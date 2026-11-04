import { Hono, type Context } from "hono";
import type { PluginContext, ServerPlugin } from "../../../apps/server/src/plugins/types";
import type { Job, JobInput, Run, Schedule } from "../web/types";
import { checkSchedule, nextRun } from "./schedule";

const TICK_MS = 30_000;
// After downtime a run older than this is skipped, not fired at a random hour.
const LATE_MS = 60 * 60 * 1000;
const AGENT = /^[\w.-]{1,64}$/;
const ACTOR = "scheduler";

const MIGRATIONS = [
  `CREATE TABLE sched_jobs (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    agent TEXT,
    model TEXT,
    schedule TEXT NOT NULL,
    autopilot INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_task_id TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sched_jobs_due ON sched_jobs (enabled, next_run_at);
  CREATE TABLE sched_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    task_id TEXT,
    error TEXT
  );
  CREATE INDEX sched_runs_job ON sched_runs (job_id, id);`,
];

interface Row {
  id: string;
  node_id: string;
  title: string;
  prompt: string;
  agent: string | null;
  model: string | null;
  schedule: string;
  autopilot: number;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_task_id: string | null;
  last_error: string | null;
  created_at: number;
}

const toJob = (r: Row): Job => ({
  id: r.id,
  nodeId: r.node_id,
  title: r.title,
  prompt: r.prompt,
  agent: r.agent,
  model: r.model ? (JSON.parse(r.model) as Job["model"]) : null,
  schedule: JSON.parse(r.schedule) as Schedule,
  autopilot: r.autopilot === 1,
  enabled: r.enabled === 1,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastTaskId: r.last_task_id,
  lastError: r.last_error,
  createdAt: r.created_at,
});

type Body = Record<string, unknown>;

async function readBody(c: Context): Promise<Body | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Body) : null;
}

// Full validation of a job; returns a Russian error or the clean input.
function validate(ctx: PluginContext, v: Body, now: number): JobInput | string {
  const node = typeof v.nodeId === "string" ? ctx.nodes.get(v.nodeId) : null;
  if (!node) return "сервер не найден";
  if (node.kind !== "vm" && node.kind !== "hypervisor") return "задачи ставятся только на сервер или гипервизор";
  if (typeof v.prompt !== "string" || !v.prompt.trim() || v.prompt.length > 20_000) return "нужно задание (до 20 000 символов)";
  const title = typeof v.title === "string" && v.title.trim() ? v.title.trim().slice(0, 200) : v.prompt.trim().slice(0, 60);
  if (v.agent !== null && v.agent !== undefined && (typeof v.agent !== "string" || !AGENT.test(v.agent))) return "неверный агент";
  const m = v.model as Record<string, unknown> | null | undefined;
  if (m !== null && m !== undefined && (typeof m !== "object" || typeof m.providerID !== "string" || typeof m.modelID !== "string")) return "неверная модель";
  const err = checkSchedule(v.schedule, now);
  if (err) return err;
  return {
    nodeId: node.id,
    title,
    prompt: v.prompt,
    agent: (v.agent as string | null | undefined) ?? null,
    model: m ? { providerID: m.providerID as string, modelID: m.modelID as string } : null,
    schedule: v.schedule as Schedule,
    autopilot: v.autopilot === true,
  };
}

export function createScheduler(ctx: PluginContext, now: () => number = Date.now) {
  ctx.migrate(MIGRATIONS);
  const db = ctx.db;
  const load = (id: string) => db.query<Row, [string]>("SELECT * FROM sched_jobs WHERE id = ?").get(id);
  const record = (jobId: string, taskId: string | null, error: string | null) => {
    db.run("INSERT INTO sched_runs (job_id, ts, task_id, error) VALUES (?, ?, ?, ?)", [jobId, now(), taskId, error]);
    db.run("UPDATE sched_jobs SET last_run_at = ?, last_task_id = COALESCE(?, last_task_id), last_error = ? WHERE id = ?", [now(), taskId, error, jobId]);
  };

  // One run of a job. A previous task that is still working blocks the run instead of stacking a second agent.
  const launch = async (row: Row, actor: string): Promise<{ taskId: string } | { error: string }> => {
    const prev = row.last_task_id ? ctx.tasks.get(row.last_task_id) : null;
    if (prev && (prev.status === "running" || prev.status === "waiting_permission")) {
      const error = "пропущено: предыдущий запуск ещё работает";
      record(row.id, null, error);
      return { error };
    }
    if (!ctx.nodes.get(row.node_id)) {
      db.run("UPDATE sched_jobs SET enabled = 0, next_run_at = NULL WHERE id = ?", [row.id]);
      record(row.id, null, "сервер удалён, задание выключено");
      return { error: "сервер удалён" };
    }
    try {
      const job = toJob(row);
      const task = await ctx.tasks.create(
        { nodeId: job.nodeId, title: job.title, prompt: job.prompt, agent: job.agent ?? undefined, model: job.model ?? undefined, autopilot: job.autopilot },
        actor,
      );
      record(row.id, task.id, null);
      ctx.audit(actor, "sched_run", { job: row.id, title: row.title }, { nodeId: row.node_id, taskId: task.id });
      return { taskId: task.id };
    } catch (err) {
      const error = `не запустилась: ${err instanceof Error ? err.message : String(err)}`;
      record(row.id, null, error);
      ctx.log("warn", `job ${row.id}: ${error}`);
      return { error };
    }
  };

  // Jobs whose run is still starting: a double click must not read the same stale last_task_id twice.
  const inFlight = new Set<string>();
  const run = async (row: Row, actor: string): Promise<{ taskId: string } | { error: string }> => {
    if (inFlight.has(row.id)) {
      const error = "пропущено: предыдущий запуск ещё работает";
      record(row.id, null, error);
      return { error };
    }
    inFlight.add(row.id);
    try {
      return await launch(row, actor);
    } finally {
      inFlight.delete(row.id);
    }
  };

  // Due jobs: next_run_at is moved forward before the run, so a slow run never fires twice.
  const tick = async () => {
    const t = now();
    const due = db.query<Row, [number]>("SELECT * FROM sched_jobs WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at").all(t);
    for (const row of due) {
      const next = nextRun(JSON.parse(row.schedule) as Schedule, t);
      db.run("UPDATE sched_jobs SET next_run_at = ? WHERE id = ?", [next, row.id]);
      if (t - (row.next_run_at ?? t) > LATE_MS) {
        record(row.id, null, `пропущено: SysAiAdm Station был недоступен в ${new Date(row.next_run_at ?? t).toISOString()}`);
        continue;
      }
      await run(row, ACTOR);
    }
  };

  const app = new Hono();

  app.get("/jobs", (c) => {
    const nodeId = c.req.query("nodeId");
    const rows = nodeId
      ? db.query<Row, [string]>("SELECT * FROM sched_jobs WHERE node_id = ? ORDER BY next_run_at IS NULL, next_run_at").all(nodeId)
      : db.query<Row, []>("SELECT * FROM sched_jobs ORDER BY next_run_at IS NULL, next_run_at").all();
    return c.json(rows.map(toJob));
  });

  app.post("/jobs", async (c) => {
    const body = await readBody(c);
    const input = body ? validate(ctx, body, now()) : "нужен JSON";
    if (typeof input === "string") return c.json({ error: input }, 400);
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO sched_jobs (id, node_id, title, prompt, agent, model, schedule, autopilot, enabled, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
      [id, input.nodeId, input.title, input.prompt, input.agent, input.model ? JSON.stringify(input.model) : null, JSON.stringify(input.schedule), input.autopilot ? 1 : 0, nextRun(input.schedule, now()), now()],
    );
    ctx.audit(c.get("actor"), "sched_create", { job: id, title: input.title, schedule: input.schedule }, { nodeId: input.nodeId });
    return c.json(toJob(load(id)!), 201);
  });

  app.put("/jobs/:id", async (c) => {
    const row = load(c.req.param("id"));
    if (!row) return c.json({ error: "задание не найдено" }, 404);
    const body = await readBody(c);
    if (!body) return c.json({ error: "нужен JSON" }, 400);
    const current = toJob(row);
    const merged = { ...current, ...body };
    // A paused one-off in the past may be edited without moving its time only if it stays paused.
    const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
    const input = validate(ctx, merged, enabled ? now() : -Infinity);
    if (typeof input === "string") return c.json({ error: input }, 400);
    db.run(
      "UPDATE sched_jobs SET node_id = ?, title = ?, prompt = ?, agent = ?, model = ?, schedule = ?, autopilot = ?, enabled = ?, next_run_at = ? WHERE id = ?",
      [input.nodeId, input.title, input.prompt, input.agent, input.model ? JSON.stringify(input.model) : null, JSON.stringify(input.schedule), input.autopilot ? 1 : 0, enabled ? 1 : 0, enabled ? nextRun(input.schedule, now()) : null, row.id],
    );
    ctx.audit(c.get("actor"), "sched_update", { job: row.id, enabled }, { nodeId: input.nodeId });
    return c.json(toJob(load(row.id)!));
  });

  app.delete("/jobs/:id", (c) => {
    const row = load(c.req.param("id"));
    if (!row) return c.json({ error: "задание не найдено" }, 404);
    db.run("DELETE FROM sched_runs WHERE job_id = ?", [row.id]);
    db.run("DELETE FROM sched_jobs WHERE id = ?", [row.id]);
    ctx.audit(c.get("actor"), "sched_delete", { job: row.id, title: row.title }, { nodeId: row.node_id });
    return c.json({ ok: true });
  });

  app.post("/jobs/:id/run", async (c) => {
    const row = load(c.req.param("id"));
    if (!row) return c.json({ error: "задание не найдено" }, 404);
    const r = await run(row, c.get("actor"));
    return "error" in r ? c.json(r, 409) : c.json(r);
  });

  app.get("/jobs/:id/runs", (c) => {
    const id = c.req.param("id");
    if (!load(id)) return c.json({ error: "задание не найдено" }, 404);
    return c.json(
      db.query<Run & { taskId: string | null }, [string]>("SELECT ts, task_id AS taskId, error FROM sched_runs WHERE job_id = ? ORDER BY id DESC LIMIT 50").all(id),
    );
  });

  return { app, tick };
}

export function createSchedulerPlugin(now: () => number = Date.now): ServerPlugin {
  const instances = new WeakMap<PluginContext, ReturnType<typeof createScheduler>>();
  const get = (ctx: PluginContext) => {
    let s = instances.get(ctx);
    if (!s) instances.set(ctx, (s = createScheduler(ctx, now)));
    return s;
  };
  return {
    id: "scheduler",
    name: "Планировщик",
    description: "Задачи агенту по расписанию: однократно, каждый день, по дням недели, раз в месяц. Правый клик по серверу → «Запланировать задачу…».",
    routes: (ctx) => get(ctx).app,
    start(ctx) {
      const s = get(ctx);
      let busy = false;
      const tick = () => {
        if (busy) return;
        busy = true;
        s.tick()
          .catch((err: unknown) => ctx.log("error", `tick: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => (busy = false));
      };
      tick();
      const timer = setInterval(tick, TICK_MS);
      return () => clearInterval(timer);
    },
  };
}

export const schedulerPlugin = createSchedulerPlugin();
