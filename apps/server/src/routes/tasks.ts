import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Task, TaskStatus } from "@sysadm/shared";
import { audit } from "../guard";
import { getNode } from "../inventory";
import { nodeDir } from "../materialize";
import {
  agents,
  connectKey,
  createSession,
  integrations,
  interrupt,
  listPending,
  messages,
  models,
  removeSession,
  setModel,
  setPermissions,
  prompt,
  providers,
  reply,
  type OpenCodeClient,
  type Permissions,
} from "../opencode";
import { getSetting, setSetting } from "../settings";

export const AUTOPILOT_MS = 4 * 60 * 60 * 1000;
const EXPIRY_CHECK_MS = 60 * 1000;
const PURGE_CHECK_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_KEY = "task_archive_days";
const RETENTION_DEFAULT = 90;
const AUTOPILOT_RULES: Permissions = [{ action: "remote_exec", resource: "*", effect: "allow" }];
const DECISIONS = ["once", "always", "reject"] as const;
const AGENT_NAME = /^[\w.-]{1,64}$/;
const STATUSES: TaskStatus[] = ["running", "idle", "waiting_permission", "stopped", "error"];
const TASK_COLUMNS = "id, node_id, session_id, title, status, created_at, archived_at";

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
  archived_at: number | null;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    nodeId: row.node_id,
    sessionID: row.session_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

function findTask(db: Database, id: string): TaskRow | null {
  return db.query<TaskRow, [string]>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id);
}

export function getTask(db: Database, id: string): Task | null {
  const row = findTask(db, id);
  return row ? toTask(row) : null;
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

// Removes archived tasks past the retention window. The opencode session goes first, errors ignored: its state is not ours to keep.
export function purgeArchivedTasks(deps: TaskDeps): number {
  const { db, client } = deps;
  const days = getSetting<number>(db, RETENTION_KEY) ?? RETENTION_DEFAULT;
  const cutoff = (deps.now ?? Date.now)() - days * DAY_MS;
  const rows = db
    .query<TaskRow, [number]>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE archived_at IS NOT NULL AND archived_at <= ?`)
    .all(cutoff);
  for (const row of rows) {
    removeSession(client, row.session_id).catch(() => {});
    db.run("DELETE FROM tasks WHERE id = ?", [row.id]);
    audit(db, { actor: "system", action: "task_purged", nodeId: row.node_id, taskId: row.id });
  }
  return rows.length;
}

// Runs the purge at start and then hourly.
export function startArchivePurge(deps: TaskDeps): () => void {
  purgeArchivedTasks(deps);
  const timer = setInterval(() => purgeArchivedTasks(deps), PURGE_CHECK_MS);
  return () => clearInterval(timer);
}

export interface NewTask {
  nodeId: string;
  title: string;
  prompt: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
}

// One path for every task start: the REST route and plugins (scheduler) both come here.
export async function createTask(deps: TaskDeps, actor: string, input: NewTask): Promise<Task> {
  const { db, client } = deps;
  const now = deps.now ?? Date.now;
  const node = getNode(db, input.nodeId);
  if (!node) throw new Error("NOT_FOUND");
  if (input.agent !== undefined && !AGENT_NAME.test(input.agent)) throw new Error("BAD_AGENT");
  const autopilot = autopilotOn(node.autopilotUntil, now());
  const session = await createSession(
    client,
    nodeDir(deps.infraDir, input.nodeId),
    input.title,
    autopilot ? AUTOPILOT_RULES : undefined,
    input.agent,
  );
  const taskId = crypto.randomUUID();
  db.run("INSERT INTO tasks (id, node_id, session_id, title, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)", [
    taskId,
    input.nodeId,
    session.id,
    input.title,
    now(),
  ]);
  audit(db, { actor, action: "task_create", nodeId: input.nodeId, taskId, detail: { title: input.title, autopilot } });
  if (input.model) await setModel(client, session.id, input.model.providerID, input.model.modelID);
  await prompt(client, session.id, input.prompt);
  return toTask(findTask(db, taskId)!);
}

// Turns a node's autopilot on for AUTOPILOT_MS and pushes it into the node's open sessions.
export async function enableAutopilot(deps: TaskDeps, actor: string, nodeId: string): Promise<void> {
  deps.db.run("UPDATE nodes SET autopilot_until = ? WHERE id = ?", [(deps.now ?? Date.now)() + AUTOPILOT_MS, nodeId]);
  audit(deps.db, { actor, action: "autopilot_on", nodeId });
  await applyAutopilot(deps, nodeId);
}

export function tasksRoutes(deps: TaskDeps): Hono {
  const { db, client } = deps;
  const now = deps.now ?? Date.now;
  const app = new Hono();

  app.post("/api/nodes/:id/tasks", async (c) => {
    const nodeId = c.req.param("id");
    if (!getNode(db, nodeId)) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.title !== "string" || typeof body?.prompt !== "string" || body.prompt.length === 0) {
      return c.json({ error: "title and prompt are required" }, 400);
    }
    if (body.agent !== undefined && (typeof body.agent !== "string" || !AGENT_NAME.test(body.agent))) {
      return c.json({ error: "bad agent" }, 400);
    }
    const model = typeof body.model?.providerID === "string" && typeof body.model?.modelID === "string" ? body.model : undefined;
    const task = await createTask(deps, c.get("actor"), { nodeId, title: body.title, prompt: body.prompt, agent: body.agent, model });
    return c.json(task, 201);
  });

  app.get("/api/tasks", (c) => {
    const status = c.req.query("status");
    const archived = c.req.query("archived") === "1";
    const where = [archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
    const params: string[] = [];
    if (status && STATUSES.includes(status as TaskStatus)) {
      where.push("status = ?");
      params.push(status);
    }
    const order = archived ? "archived_at DESC" : "created_at DESC";
    const rows = db
      .query<TaskRow, string[]>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE ${where.join(" AND ")} ORDER BY ${order}`)
      .all(...params);
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
    audit(db, { actor: c.get("actor"), action: "stop", nodeId: row.node_id, taskId: row.id });
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/archive", (c) => {
    const row = findTask(db, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status === "running" || row.status === "waiting_permission") {
      return c.json({ error: "задача ещё работает, сначала остановите" }, 409);
    }
    db.run("UPDATE tasks SET archived_at = ? WHERE id = ?", [now(), row.id]);
    audit(db, { actor: c.get("actor"), action: "task_archive", nodeId: row.node_id, taskId: row.id });
    const updated = findTask(db, row.id);
    return c.json(updated ? toTask(updated) : null);
  });

  app.post("/api/tasks/:id/unarchive", (c) => {
    const row = findTask(db, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    db.run("UPDATE tasks SET archived_at = NULL WHERE id = ?", [row.id]);
    audit(db, { actor: c.get("actor"), action: "task_unarchive", nodeId: row.node_id, taskId: row.id });
    const updated = findTask(db, row.id);
    return c.json(updated ? toTask(updated) : null);
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
    // A rule that outlives the request is an admin decision: tokens may only answer once or reject.
    if (decision === "always" && c.get("scopes") !== "*") return c.json({ error: "always requires an admin session" }, 403);
    const requestID = c.req.param("requestID");
    await reply(client, row.session_id, requestID, decision);
    audit(db, { actor: c.get("actor"), action: "permission", nodeId: row.node_id, taskId: row.id, detail: { requestID, decision } });
    return c.json({ ok: true });
  });

  app.get("/api/settings/providers", async (c) => c.json(await providers(client)));

  app.post("/api/settings/providers/:id/key", async (c) => {
    const providerID = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    if (typeof body?.key !== "string" || body.key.length === 0) return c.json({ error: "key is required" }, 400);
    await connectKey(client, providerID, body.key);
    audit(db, { actor: c.get("actor"), action: "provider_key", detail: { providerID } });
    return c.json({ ok: true });
  });

  app.get("/api/settings/models", async (c) => c.json(await models(client)));

  app.get("/api/settings/agents", async (c) => c.json(await agents(client)));

  app.get("/api/settings/integrations", async (c) => c.json(await integrations(client)));

  app.get("/api/settings/task-retention", (c) => c.json({ days: getSetting<number>(db, RETENTION_KEY) ?? RETENTION_DEFAULT }));

  app.put("/api/settings/task-retention", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!Number.isInteger(body?.days) || body.days < 1 || body.days > 3650) {
      return c.json({ error: "days: целое число от 1 до 3650" }, 400);
    }
    setSetting(db, RETENTION_KEY, body.days);
    audit(db, { actor: c.get("actor"), action: "task_retention", detail: { days: body.days } });
    return c.json({ days: body.days });
  });

  return app;
}
