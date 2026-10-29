import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import type { EffectiveNode, ExecVerdict, TaskStatus } from "@sysadm/shared";
import { Hono, type Context } from "hono";
import { audit, classify } from "../guard";
import { getNode, resolveEffective } from "../inventory";
import {
  execRemote,
  HostKeyMismatch,
  SshHopError,
  type ExecInput,
  type ExecOutput,
  type Hop,
  type Secret,
} from "../ssh";
import { open } from "../vault";

const PER_NODE_LIMIT = 4;
const GLOBAL_LIMIT = 16;
const MAX_COMMAND = 8192;
const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;
const ACTOR = "plugin";
const JUMP_ERRORS = ["JUMP_CYCLE", "JUMP_TOO_DEEP", "JUMP_NO_ADDRESS"];

export interface InternalDeps {
  db: Database;
  token: string;
  masterKey: Buffer;
  now?: () => number;
  exec?: (input: ExecInput) => Promise<ExecOutput>;
}

interface PlannedHop {
  nodeId: string;
  name: string;
  hop: Hop;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function tokenOk(header: string | undefined, expected: string): boolean {
  const given = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(digest(given), digest(expected));
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

// Credential payload is the JSON of a Secret, written by the credentials route.
function loadSecret(db: Database, masterKey: Buffer, credentialId: string): Secret {
  const row = db
    .query<{ ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }, [string]>(
      "SELECT ciphertext, iv, tag FROM credentials WHERE id = ?",
    )
    .get(credentialId);
  if (!row) throw new Error("NO_CREDENTIAL");
  const plain = open(
    masterKey,
    { ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), tag: Buffer.from(row.tag) },
    credentialId,
  );
  try {
    const parsed: unknown = JSON.parse(plain.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("BAD_CREDENTIAL");
    if ("password" in parsed && typeof parsed.password === "string") return { password: parsed.password };
    if ("privateKey" in parsed && typeof parsed.privateKey === "string") {
      const passphrase = "passphrase" in parsed && typeof parsed.passphrase === "string" ? parsed.passphrase : undefined;
      return { privateKey: parsed.privateKey, passphrase };
    }
    throw new Error("BAD_CREDENTIAL");
  } finally {
    plain.fill(0);
  }
}

// Hops from the outermost bastion to the target. Each hop uses its own effective creds and pinned key.
function planHops(db: Database, masterKey: Buffer, nodeId: string): { eff: EffectiveNode; hops: PlannedHop[] } {
  const eff = resolveEffective(db, nodeId);
  const ids = [...eff.jumpChain, nodeId];
  const hops = ids.map((id): PlannedHop => {
    const hopEff = id === nodeId ? eff : resolveEffective(db, id);
    if (!hopEff.user) throw new Error("NO_USER");
    if (!hopEff.credentialId) throw new Error("NO_CREDENTIAL");
    const hostKey = db.query<{ host_key: string | null }, [string]>("SELECT host_key FROM nodes WHERE id = ?").get(id);
    return {
      nodeId: id,
      name: hopEff.name,
      hop: {
        host: hopEff.address,
        port: hopEff.port,
        user: hopEff.user,
        secret: loadSecret(db, masterKey, hopEff.credentialId),
        knownHostKey: hostKey?.host_key ?? null,
      },
    };
  });
  return { eff, hops };
}

// Compare-and-set pin per hop; returns the index of the first hop whose stored key differs.
function pinHostKeys(db: Database, hops: PlannedHop[], keys: string[]): number | null {
  for (const [i, planned] of hops.entries()) {
    db.run("UPDATE nodes SET host_key = ? WHERE id = ? AND host_key IS NULL", [keys[i], planned.nodeId]);
    const stored = db
      .query<{ host_key: string | null }, [string]>("SELECT host_key FROM nodes WHERE id = ?")
      .get(planned.nodeId);
    if (stored?.host_key !== keys[i]) return i;
  }
  return null;
}

function setTaskStatus(db: Database, taskId: string, status: TaskStatus): void {
  db.run("UPDATE tasks SET status = ? WHERE id = ?", [status, taskId]);
}

export function createInternalApp(deps: InternalDeps): Hono {
  const { db, masterKey } = deps;
  const now = deps.now ?? Date.now;
  const exec = deps.exec ?? execRemote;
  const active = new Map<string, number>();
  let total = 0;

  const acquire = (nodeId: string): boolean => {
    const n = active.get(nodeId) ?? 0;
    if (n >= PER_NODE_LIMIT || total >= GLOBAL_LIMIT) return false;
    active.set(nodeId, n + 1);
    total++;
    return true;
  };
  const release = (nodeId: string): void => {
    active.set(nodeId, (active.get(nodeId) ?? 1) - 1);
    total--;
  };

  const findTask = (sessionID: string) =>
    db
      .query<{ id: string; node_id: string }, [string]>("SELECT id, node_id FROM tasks WHERE session_id = ?")
      .get(sessionID);

  const app = new Hono();

  app.use("/internal/*", async (c, next) => {
    if (!tokenOk(c.req.header("authorization"), deps.token)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.post("/internal/check", async (c) => {
    const body = await readBody(c);
    const sessionID = body?.sessionID;
    const command = body?.command;
    if (typeof sessionID !== "string" || typeof command !== "string") return c.json({ error: "bad request" }, 400);
    const task = findTask(sessionID);
    if (!task) return c.json({ error: "unknown session" }, 404);

    const node = getNode(db, task.node_id);
    if (!node) return c.json({ error: "unknown node" }, 404);
    let eff: EffectiveNode;
    try {
      eff = resolveEffective(db, task.node_id);
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      if (!JUMP_ERRORS.includes(code)) throw err;
      const deny: ExecVerdict = { verdict: "deny", reason: `route: ${code}`, node: node.name, via: [], autopilot: false };
      return c.json(deny);
    }

    const verdict = classify(command);
    const via = eff.jumpChain.map((id) => getNode(db, id)?.name ?? id);
    const result: ExecVerdict = {
      verdict,
      node: node.name,
      address: eff.address,
      via,
      autopilot: (node.autopilotUntil ?? 0) > now(),
    };
    if (verdict === "deny") result.reason = "denied by sysadm policy";
    return c.json(result);
  });

  app.post("/internal/exec", async (c) => {
    const body = await readBody(c);
    const sessionID = body?.sessionID;
    const command = body?.command;
    const toolCallId = typeof body?.toolCallId === "string" ? body.toolCallId : null;
    const timeoutRaw = body?.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    if (typeof sessionID !== "string" || typeof command !== "string") return c.json({ error: "bad request" }, 400);
    if (command.length === 0 || command.length > MAX_COMMAND) return c.json({ error: "bad command" }, 400);
    if (typeof timeoutRaw !== "number" || !Number.isInteger(timeoutRaw) || timeoutRaw < 1 || timeoutRaw > MAX_TIMEOUT_SEC) {
      return c.json({ error: "bad timeout" }, 400);
    }
    const task = findTask(sessionID);
    if (!task) return c.json({ error: "unknown session" }, 404);

    // The target and route come only from the task row, never from the body.
    const verdict = classify(command);
    if (verdict === "deny") {
      audit(db, { actor: ACTOR, action: "exec_denied", nodeId: task.node_id, taskId: task.id, detail: { command, toolCallId } });
      return c.json({ error: "denied" }, 403);
    }
    if (!acquire(task.node_id)) return c.json({ error: "too many concurrent executions" }, 429);

    try {
      let planned: { eff: EffectiveNode; hops: PlannedHop[] };
      try {
        planned = planHops(db, masterKey, task.node_id);
      } catch (err) {
        const code = err instanceof Error ? err.message : "";
        if (JUMP_ERRORS.includes(code)) return c.json({ error: code }, 409);
        if (code === "NO_USER" || code === "NO_CREDENTIAL" || code === "BAD_CREDENTIAL") {
          return c.json({ error: code }, 422);
        }
        throw err;
      }
      const { eff, hops } = planned;
      const via = hops.slice(0, -1).map((h) => h.name);
      setTaskStatus(db, task.id, "running");
      const started = now();

      let out: ExecOutput;
      try {
        out = await exec({
          hops: hops.map((h) => h.hop),
          command,
          shell: eff.shell,
          timeoutMs: timeoutRaw * 1000,
          signal: c.req.raw.signal,
        });
      } catch (err) {
        if (err instanceof HostKeyMismatch) {
          const hopName = hops[err.hop]?.name ?? "unknown";
          audit(db, { actor: ACTOR, action: "hostkey_mismatch", nodeId: hops[err.hop]?.nodeId, taskId: task.id, detail: { via } });
          setTaskStatus(db, task.id, "error");
          return c.json({ error: "HOST_KEY_MISMATCH", node: hopName }, 409);
        }
        if (err instanceof SshHopError) {
          const hopName = hops[err.hop]?.name ?? "unknown";
          setTaskStatus(db, task.id, "error");
          return c.json({ error: "SSH_HOP_ERROR", node: hopName }, 502);
        }
        const code = err instanceof Error ? err.message : "EXEC_FAILED";
        setTaskStatus(db, task.id, "error");
        if (code === "EXEC_TIMEOUT") return c.json({ error: code }, 504);
        return c.json({ error: code === "ABORTED" ? code : "EXEC_FAILED" }, 408);
      }

      const raced = pinHostKeys(db, hops, out.hostKeys);
      if (raced !== null) {
        // Another first connection pinned a different key; this output is not trusted.
        const hopName = hops[raced]?.name ?? "unknown";
        audit(db, { actor: ACTOR, action: "hostkey_race", nodeId: hops[raced]?.nodeId, taskId: task.id, detail: { via } });
        setTaskStatus(db, task.id, "error");
        return c.json({ error: "HOST_KEY_MISMATCH", node: hopName }, 409);
      }

      audit(db, {
        actor: ACTOR,
        action: "exec",
        nodeId: task.node_id,
        taskId: task.id,
        detail: {
          command,
          exitCode: out.exitCode,
          durationMs: now() - started,
          truncated: out.truncated,
          via,
          toolCallId,
        },
      });
      setTaskStatus(db, task.id, "idle");
      return c.json({ exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr, truncated: out.truncated });
    } finally {
      release(task.node_id);
    }
  });

  return app;
}
