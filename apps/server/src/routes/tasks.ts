import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Task, TaskStatus } from "@sysadm/shared";
import { audit } from "../guard";
import { getNode } from "../inventory";
import { nodeDir } from "../materialize";
import {
  connectKey,
  createSession,
  interrupt,
  listPending,
  messages,
  models,
  setModel,
  setPermissions,
  prompt,
  providers,
  reply,
  type OpenCodeClient,
  type Permissions,
} from "../opencode";

export const AUTOPILOT_MS = 4 * 60 * 60 * 1000;
const EXPIRY_CHECK_MS = 60 * 1000;
const AUTOPILOT_RULES: Permissions = [{ action: "remote_exec", resource: "*", effect: "allow" }];
const DECISIONS = ["once", "always", "reject"] as const;
const STATUSES: TaskStatus[] = ["running", "idle", "waiting_permission", "stopped", "error"];

export interface TaskDeps {
  db: Database;
  client: OpenCodeClient;
  infraDir: string;
  now?: () => number;
}

interface TaskRow {
  id: string;
  node_id: string;
  session_id: string;
  title: string;
  status: TaskStatus;
  created_at: number;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    nodeId: row.node_id,
    sessionID: row.session_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
  };
}

function findTask(db: Database, id: string): TaskRow | null {
  return db
    .query<TaskRow, [string]>("SELECT id, node_id, session_id, title, status, created_at FROM tasks WHERE id = ?")
    .get(id);
}

function autopilotOn(autopilotUntil: number | null, now: number): boolean {
  return (autopilotUntil ?? 0) > now;
}

// Pushes the node's autopilot state into the session rules of every task on that node.
export async function applyAutopilot(deps: TaskDeps, nodeId: string): Promise<void> {
  const node = getNode(deps.db, nodeId);
  if (!node) return;
  const on = autopilotOn(node.autopilotUntil, (deps.now ?? Date.now)());
  const rows = deps.db
    .query<{ session_id: string }, [string]>("SELECT session_id FROM tasks WHERE node_id = ?")
    .all(nodeId);
  for (const row of rows) {
    await setPermissions(deps.client, row.session_id, on ? AUTOPILOT_RULES : []);
  }
}

// Turns autopilot off for nodes whose 4-hour window has passed. Runs once a minute.
export function startAutopilotExpiry(deps: TaskDeps): () => void {
  const timer = setInterval(() => {
    const now = (deps.now ?? Date.now)();
    const expired = deps.db
      .query<{ id: string }, [number]>("SELECT id FROM nodes WHERE autopilot_until IS NOT NULL AND autopilot_until <= ?")
      .all(now);
    for (const { id } of expired) {
      deps.db.run("UPDATE nodes SET autopilot_until = NULL WHERE id = ?", [id]);
      audit(deps.db, { actor: "system", action: "autopilot_expired", nodeId: id });
      applyAutopilot(deps, id).catch(() => {});
    }
  }, EXPIRY_CHECK_MS);
  return () => clearInterval(timer);
}

export function tasksRoutes(deps: TaskDeps): Hono {
  const { db, client } = deps;
  const now = deps.now ?? Date.now;
  const app = new Hono();

  app.post("/api/nodes/:id/tasks", async (c) => {
    const nodeId = c.req.param("id");
    const node = getNode(db, nodeId);
    if (!node) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.title !== "string" || typeof body?.prompt !== "string" || body.prompt.length === 0) {
      return c.json({ error: "title and prompt are required" }, 400);
    }
    const autopilot = autopilotOn(node.autopilotUntil, now());
    const session = await createSession(client, nodeDir(deps.infraDir, nodeId), body.title, autopilot ? AUTOPILOT_RULES : undefined);
    const taskId = crypto.randomUUID();
    db.run("INSERT INTO tasks (id, node_id, session_id, title, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)", [
      taskId,
      nodeId,
      session.id,
      body.title,
      now(),
    ]);
    audit(db, { actor: "admin", action: "task_create", nodeId, taskId, detail: { title: body.title, autopilot } });
    if (typeof body.model?.providerID === "string" && typeof body.model?.modelID === "string") {
      await setModel(client, session.id, body.model.providerID, body.model.modelID);
    }
    await prompt(client, session.id, body.prompt);
    const row = findTask(db, taskId);
    return c.json(row ? toTask(row) : null, 201);
  });

  app.get("/api/tasks", (c) => {
    const status = c.req.query("status");
    const rows = status && STATUSES.includes(status as TaskStatus)
      ? db
          .query<TaskRow, [string]>(
            "SELECT id, node_id, session_id, title, status, created_at FROM tasks WHERE status = ? ORDER BY created_at DESC",
          )
          .all(status)
      : db
          .query<TaskRow, []>("SELECT id, node_id, session_id, title, status, created_at FROM tasks ORDER BY created_at DESC")
          .all();
    return c.json(rows.map(toTask));
  });

  app.get("/api/tasks/:id", async (c) => {
    const row = findTask(db, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const messageList = await messages(client, row.session_id);
    return c.json({ task: toTask(row), messages: messageList });
  });

  app.post("/api/tasks/:id/prompt", async (c) => {
    const row = findTask(db, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.text !== "string" || body.text.length === 0) return c.json({ error: "text is required" }, 400);
    await prompt(client, row.session_id, body.text);
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/stop", async (c) => {
    const row = findTask(db, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    await interrupt(client, row.session_id);
    db.run("UPDATE tasks SET status = 'stopped' WHERE id = ?", [row.id]);
    audit(db, { actor: "admin", action: "stop", nodeId: row.node_id, taskId: row.id });
    return c.json({ ok: true });
  });

  app.get("/api/tasks/:id/permissions", async (c) => {
    const row = findTask(db, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(await listPending(client, row.session_id));
  });

  app.post("/api/tasks/:id/permissions/:requestID", async (c) => {
    const row = findTask(db, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const decision = DECISIONS.find((d) => d === body?.decision);
    if (!decision) return c.json({ error: "decision must be once, always or reject" }, 400);
    const requestID = c.req.param("requestID");
    await reply(client, row.session_id, requestID, decision);
    audit(db, { actor: "admin", action: "permission", nodeId: row.node_id, taskId: row.id, detail: { requestID, decision } });
    return c.json({ ok: true });
  });

  app.get("/api/settings/providers", async (c) => c.json(await providers(client)));

  app.post("/api/settings/providers/:id/key", async (c) => {
    const providerID = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (typeof body?.key !== "string" || body.key.length === 0) return c.json({ error: "key is required" }, 400);
    await connectKey(client, providerID, body.key);
    audit(db, { actor: "admin", action: "provider_key", detail: { providerID } });
    return c.json({ ok: true });
  });

  app.get("/api/settings/models", async (c) => c.json(await models(client)));

  return app;
}
