import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import type { JumpMode, NodeKind, OsKind, ShellKind } from "@sysadm/shared";
import { audit } from "../guard";
import { createNode, deleteNode, getNode, getTree, moveNode, resolveEffective, setNodeSkills, updateNode, type NodePatch } from "../inventory";
import { materializeSubtree, removeNode } from "../materialize";
import { applyAutopilot, AUTOPILOT_MS, type TaskDeps } from "./tasks";

const KINDS: NodeKind[] = ["company", "group", "hypervisor", "vm"];
const OSES: OsKind[] = ["ubuntu", "debian", "proxmox", "windows", "other"];
const SHELLS: ShellKind[] = ["bash", "powershell"];
const JUMP_MODES: JumpMode[] = ["inherit", "direct", "via"];
const ADDRESS = /^[A-Za-z0-9.:-]{1,253}$/;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface InventoryDeps extends TaskDeps {
  bus?: { publish(message: { type: string; [key: string]: unknown }): void };
}

type Body = Record<string, unknown>;

async function readBody(c: Context): Promise<Body | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Body) : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

function optString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function optPort(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined;
}

function optAddress(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && ADDRESS.test(value) ? value : undefined;
}

// Maps domain error codes from inventory.ts to HTTP status.
function failure(c: Context, err: unknown) {
  const code = err instanceof Error ? err.message : "";
  if (code === "NOT_FOUND") return c.json({ error: code }, 404);
  if (code === "HAS_CHILDREN" || code === "IS_JUMP_HOST" || code === "MOVE_CYCLE") return c.json({ error: code }, 409);
  if (code.startsWith("JUMP_") || code === "VM_NO_ADDRESS") return c.json({ error: code }, 422);
  if (code.includes("FOREIGN KEY") || code.includes("CHECK constraint")) return c.json({ error: "constraint violated" }, 409);
  throw err;
}

export function inventoryRoutes(deps: InventoryDeps): Hono {
  const { db, infraDir } = deps;
  const now = deps.now ?? Date.now;
  const app = new Hono();

  const refresh = async (nodeId: string) => {
    await materializeSubtree(db, infraDir, nodeId);
    deps.bus?.publish({ type: "tree.updated", nodeId });
  };

  app.get("/api/tree", (c) => c.json(getTree(db)));

  app.get("/api/nodes/:id", (c) => {
    const node = getNode(db, c.req.param("id"));
    if (!node) return c.json({ error: "not found" }, 404);
    try {
      return c.json({ node, effective: resolveEffective(db, node.id), routeError: null });
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      if (!code.startsWith("JUMP_")) throw err;
      return c.json({ node, effective: null, routeError: code });
    }
  });

  app.post("/api/nodes", async (c) => {
    const body = await readBody(c);
    const kind = oneOf(body?.kind, KINDS);
    const name = body?.name;
    if (!kind || typeof name !== "string" || name.length === 0 || name.length > 200) {
      return c.json({ error: "kind and name are required" }, 400);
    }
    const parentId = body?.parentId === null || body?.parentId === undefined ? null : optString(body.parentId);
    if (parentId === undefined) return c.json({ error: "parentId must be a string or null" }, 400);
    try {
      const node = createNode(db, {
        parentId,
        kind,
        name,
        os: oneOf(body?.os, OSES),
        address: optAddress(body?.address),
        port: optPort(body?.port),
        user: optString(body?.user),
        shell: oneOf(body?.shell, SHELLS) ?? null,
        credentialId: optString(body?.credentialId),
        jumpMode: oneOf(body?.jumpMode, JUMP_MODES),
        jumpNodeId: optString(body?.jumpNodeId),
        notes: optString(body?.notes),
      });
      audit(db, { actor: c.get("actor"), action: "node_create", nodeId: node.id, detail: { kind, name } });
      await refresh(node.id);
      return c.json(node, 201);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.patch("/api/nodes/:id", async (c) => {
    const id = c.req.param("id");
    if (!getNode(db, id)) return c.json({ error: "not found" }, 404);
    const body = await readBody(c);
    if (!body) return c.json({ error: "body must be an object" }, 400);
    const patch: NodePatch = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 200) return c.json({ error: "bad name" }, 400);
      patch.name = body.name;
    }
    if (body.os !== undefined) {
      const os = oneOf(body.os, OSES);
      if (!os) return c.json({ error: "bad os" }, 400);
      patch.os = os;
    }
    if (body.address !== undefined) patch.address = optAddress(body.address);
    if (body.port !== undefined) patch.port = optPort(body.port);
    if (body.user !== undefined) patch.user = optString(body.user);
    if (body.shell !== undefined) patch.shell = oneOf(body.shell, SHELLS) ?? null;
    if (body.credentialId !== undefined) patch.credentialId = optString(body.credentialId);
    if (body.jumpMode !== undefined) patch.jumpMode = oneOf(body.jumpMode, JUMP_MODES);
    if (body.jumpNodeId !== undefined) patch.jumpNodeId = optString(body.jumpNodeId);
    if (body.notes !== undefined) patch.notes = optString(body.notes);
    if (typeof body.autopilot === "boolean" && c.get("scopes") !== "*") {
      return c.json({ error: "autopilot requires an admin session" }, 403);
    }
    if (typeof body.autopilot === "boolean") patch.autopilotUntil = body.autopilot ? now() + AUTOPILOT_MS : null;
    if (patch.jumpNodeId && !getNode(db, patch.jumpNodeId)) return c.json({ error: "jumpNodeId not found" }, 400);

    try {
      const node = updateNode(db, id, patch);
      audit(db, { actor: c.get("actor"), action: "node_update", nodeId: id, detail: { fields: Object.keys(patch) } });
      if (typeof body.autopilot === "boolean") {
        await applyAutopilot(deps, id);
        audit(db, { actor: c.get("actor"), action: body.autopilot ? "autopilot_on" : "autopilot_off", nodeId: id });
      }
      await refresh(id);
      return c.json(node);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/api/nodes/:id/move", async (c) => {
    const id = c.req.param("id");
    const body = await readBody(c);
    if (typeof body?.parentId !== "string") return c.json({ error: "parentId is required" }, 400);
    try {
      const node = moveNode(db, id, body.parentId);
      audit(db, { actor: c.get("actor"), action: "node_move", nodeId: id, detail: { parentId: body.parentId } });
      await refresh(id);
      return c.json(node);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.delete("/api/nodes/:id", async (c) => {
    const id = c.req.param("id");
    if (!getNode(db, id)) return c.json({ error: "not found" }, 404);
    try {
      deleteNode(db, id);
      await removeNode(infraDir, id);
      audit(db, { actor: c.get("actor"), action: "node_delete", nodeId: id });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/api/nodes/:id/reset-hostkey", (c) => {
    const id = c.req.param("id");
    if (!getNode(db, id)) return c.json({ error: "not found" }, 404);
    db.run("UPDATE nodes SET host_key = NULL WHERE id = ?", [id]);
    audit(db, { actor: c.get("actor"), action: "hostkey_reset", nodeId: id });
    return c.json({ ok: true });
  });

  app.put("/api/nodes/:id/skills", async (c) => {
    const id = c.req.param("id");
    const body = await readBody(c);
    const skills = body?.skills;
    if (!Array.isArray(skills) || !skills.every((s): s is string => typeof s === "string" && SKILL_ID.test(s))) {
      return c.json({ error: "skills must be an array of skill ids" }, 400);
    }
    try {
      const node = setNodeSkills(db, id, skills);
      audit(db, { actor: c.get("actor"), action: "node_skills", nodeId: id, detail: { skills } });
      await refresh(id);
      return c.json(node);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/api/skills", (c) =>
    c.json(db.query<{ id: string; name: string; description: string; builtin: number }, []>("SELECT id, name, description, builtin FROM skills ORDER BY id").all()),
  );

  app.post("/api/skills", async (c) => {
    const body = await readBody(c);
    const { id, name, description, content } = body ?? {};
    if (typeof id !== "string" || !SKILL_ID.test(id) || typeof name !== "string" || typeof description !== "string" || typeof content !== "string") {
      return c.json({ error: "id, name, description, content are required" }, 400);
    }
    db.run("INSERT INTO skills (id, name, description, content, builtin) VALUES (?, ?, ?, ?, 0)", [id, name, description, content]);
    audit(db, { actor: c.get("actor"), action: "skill_create", detail: { id } });
    return c.json({ id }, 201);
  });

  app.put("/api/skills/:id", async (c) => {
    const id = c.req.param("id");
    const row = db.query<{ builtin: number }, [string]>("SELECT builtin FROM skills WHERE id = ?").get(id);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.builtin === 1) return c.json({ error: "builtin skills are read-only" }, 403);
    const body = await readBody(c);
    if (typeof body?.name !== "string" || typeof body?.description !== "string" || typeof body?.content !== "string") {
      return c.json({ error: "name, description, content are required" }, 400);
    }
    db.run("UPDATE skills SET name = ?, description = ?, content = ? WHERE id = ?", [body.name, body.description, body.content, id]);
    audit(db, { actor: c.get("actor"), action: "skill_update", detail: { id } });
    return c.json({ id });
  });

  app.delete("/api/skills/:id", (c) => {
    const id = c.req.param("id");
    const row = db.query<{ builtin: number }, [string]>("SELECT builtin FROM skills WHERE id = ?").get(id);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.builtin === 1) return c.json({ error: "builtin skills are read-only" }, 403);
    try {
      db.run("DELETE FROM skills WHERE id = ?", [id]);
    } catch {
      return c.json({ error: "skill is in use" }, 409);
    }
    audit(db, { actor: c.get("actor"), action: "skill_delete", detail: { id } });
    return c.json({ ok: true });
  });

  app.get("/api/audit", (c) => {
    const nodeId = c.req.query("nodeId");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 500);
    const rows = nodeId
      ? db
          .query<AuditRow, [string, number]>(
            "SELECT id, ts, actor, action, node_id, task_id, detail FROM audit WHERE node_id = ? ORDER BY id DESC LIMIT ?",
          )
          .all(nodeId, limit)
      : db
          .query<AuditRow, [number]>("SELECT id, ts, actor, action, node_id, task_id, detail FROM audit ORDER BY id DESC LIMIT ?")
          .all(limit);
    return c.json(rows);
  });

  return app;
}

interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  node_id: string | null;
  task_id: string | null;
  detail: string | null;
}
