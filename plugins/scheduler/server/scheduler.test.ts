import { expect, test } from "bun:test";
import type { InventoryNode, Task } from "@sysadm/shared";
import { openDb } from "../../../apps/server/src/db";
import type { PluginContext, PluginTaskInput } from "../../../apps/server/src/plugins/types";
import { createScheduler } from "./index";
import { checkSchedule, nextRun, wallToUtc } from "./schedule";

const MSK = "Europe/Moscow";
const BERLIN = "Europe/Berlin";

test("nextRun: daily, weekly, monthly in the schedule's zone", () => {
  // 2026-11-02 (Mon) 10:00 Moscow = 07:00 UTC
  const after = Date.UTC(2026, 10, 2, 7, 0);
  expect(nextRun({ kind: "daily", time: "03:00", tz: MSK }, after)).toBe(Date.UTC(2026, 10, 3, 0, 0));
  expect(nextRun({ kind: "daily", time: "12:30", tz: MSK }, after)).toBe(Date.UTC(2026, 10, 2, 9, 30));
  // Fri and Sun only → Fri 2026-11-06 03:00 MSK
  expect(nextRun({ kind: "weekly", time: "03:00", days: [5, 0], tz: MSK }, after)).toBe(Date.UTC(2026, 10, 6, 0, 0));
  expect(nextRun({ kind: "monthly", time: "03:00", day: 1, tz: MSK }, after)).toBe(Date.UTC(2026, 11, 1, 0, 0));
  expect(nextRun({ kind: "once", at: after - 1 }, after)).toBeNull();
});

test("wallToUtc follows DST", () => {
  // Berlin: winter UTC+1, summer UTC+2 (switch 2026-03-29).
  expect(wallToUtc(2026, 1, 15, 3, 0, BERLIN)).toBe(Date.UTC(2026, 0, 15, 2, 0));
  expect(wallToUtc(2026, 7, 15, 3, 0, BERLIN)).toBe(Date.UTC(2026, 6, 15, 1, 0));
  const beforeSwitch = Date.UTC(2026, 2, 28, 12, 0);
  expect(nextRun({ kind: "daily", time: "04:00", tz: BERLIN }, beforeSwitch)).toBe(Date.UTC(2026, 2, 29, 2, 0));
});

test("checkSchedule rejects bad input", () => {
  const now = 1_000;
  expect(checkSchedule({ kind: "once", at: 500 }, now)).not.toBeNull();
  expect(checkSchedule({ kind: "daily", time: "25:00", tz: MSK }, now)).not.toBeNull();
  expect(checkSchedule({ kind: "daily", time: "03:00", tz: "Mars/Base" }, now)).not.toBeNull();
  expect(checkSchedule({ kind: "weekly", time: "03:00", days: [], tz: MSK }, now)).not.toBeNull();
  expect(checkSchedule({ kind: "monthly", time: "03:00", day: 31, tz: MSK }, now)).not.toBeNull();
  expect(checkSchedule({ kind: "weekly", time: "03:00", days: [1, 3], tz: MSK }, now)).toBeNull();
});

function fakeCtx() {
  const db = openDb(":memory:");
  const node = { id: "n1", kind: "vm", name: "web1" } as InventoryNode;
  const tasks = new Map<string, Task>();
  const created: PluginTaskInput[] = [];
  let version = 0;
  const ctx = {
    id: "scheduler",
    db,
    log() {},
    audit() {},
    migrate(m: string[]) {
      for (; version < m.length; version++) db.exec(m[version]);
    },
    nodes: { get: (id: string) => (id === node.id ? node : null), list: () => [node] },
    tasks: {
      create: async (input: PluginTaskInput) => {
        created.push(input);
        const t = { id: `t${created.length}`, nodeId: input.nodeId, title: input.title, status: "running" } as Task;
        tasks.set(t.id, t);
        return t;
      },
      get: (id: string) => tasks.get(id) ?? null,
    },
  } as unknown as PluginContext;
  return { ctx, created, tasks };
}

test("tick runs due jobs once, skips while the previous run works, skips stale runs", async () => {
  let now = Date.UTC(2026, 10, 2, 7, 0);
  const { ctx, created, tasks } = fakeCtx();
  const s = createScheduler(ctx, () => now);
  const post = (body: unknown) =>
    s.app.request("/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  expect((await post({ nodeId: "nope", prompt: "x", schedule: { kind: "daily", time: "03:00", tz: MSK } })).status).toBe(400);
  const res = await post({ nodeId: "n1", prompt: "обнови пакеты", agent: "sysadmin", schedule: { kind: "daily", time: "10:05", tz: MSK }, autopilot: true });
  expect(res.status).toBe(201);
  const job = (await res.json()) as { id: string; nextRunAt: number; title: string };
  expect(job.nextRunAt).toBe(Date.UTC(2026, 10, 2, 7, 5));
  expect(job.title).toBe("обнови пакеты");

  await s.tick();
  expect(created).toHaveLength(0);

  now = Date.UTC(2026, 10, 2, 7, 6);
  await s.tick();
  await s.tick();
  expect(created).toEqual([{ nodeId: "n1", title: "обнови пакеты", prompt: "обнови пакеты", agent: "sysadmin", model: undefined, autopilot: true }]);

  // Next day the first task is still running: the run is skipped and recorded.
  now = Date.UTC(2026, 10, 3, 7, 6);
  await s.tick();
  expect(created).toHaveLength(1);
  const runs = (await (await s.app.request(`/jobs/${job.id}/runs`)).json()) as Array<{ error: string | null }>;
  expect(runs[0].error).toContain("предыдущий запуск");

  // Two days of downtime: the overdue run is skipped, the schedule moves on.
  tasks.get("t1")!.status = "idle";
  now = Date.UTC(2026, 10, 5, 12, 0);
  await s.tick();
  expect(created).toHaveLength(1);
  const list = (await (await s.app.request("/jobs")).json()) as Array<{ nextRunAt: number; lastError: string }>;
  expect(list[0].nextRunAt).toBe(Date.UTC(2026, 10, 6, 7, 5));
  expect(list[0].lastError).toContain("недоступен");

  // Manual run works; pause clears the next run.
  expect((await s.app.request(`/jobs/${job.id}/run`, { method: "POST" })).status).toBe(200);
  expect(created).toHaveLength(2);
  const paused = await s.app.request(`/jobs/${job.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  expect(((await paused.json()) as { nextRunAt: number | null }).nextRunAt).toBeNull();
});

test("two manual runs at once start one task", async () => {
  const now = Date.UTC(2026, 10, 2, 7, 0);
  const { ctx, created } = fakeCtx();
  const s = createScheduler(ctx, () => now);
  const res = await s.app.request("/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId: "n1", prompt: "проверка", schedule: { kind: "daily", time: "10:05", tz: MSK } }),
  });
  const job = (await res.json()) as { id: string };
  const [a, b] = await Promise.all([s.app.request(`/jobs/${job.id}/run`, { method: "POST" }), s.app.request(`/jobs/${job.id}/run`, { method: "POST" })]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  expect(created).toHaveLength(1);
});
