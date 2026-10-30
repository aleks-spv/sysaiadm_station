import { expect, test } from "bun:test";
import type { Task } from "@sysadm/shared";
import { Hono } from "hono";
import { openDb } from "../db";
import { makeClient } from "../opencode";
import { setSetting } from "../settings";
import { purgeArchivedTasks, tasksRoutes } from "./tasks";

const NOW = Date.UTC(2026, 9, 29);
const DAY = 24 * 60 * 60 * 1000;

// Port 9 refuses connections, so opencode calls fail fast and their errors are ignored.
function setup() {
  const db = openDb(":memory:");
  db.run("INSERT INTO nodes (id, kind, name) VALUES ('n1', 'vm', 'vm1')");
  const deps = { db, client: makeClient({ baseUrl: "http://127.0.0.1:9", password: "pw" }), infraDir: "/unused", now: () => NOW };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("actor", "admin");
    await next();
  });
  app.route("/", tasksRoutes(deps));
  return { db, app, deps };
}

function insert(db: ReturnType<typeof openDb>, id: string, status: string, archivedAt: number | null = null) {
  db.run(
    "INSERT INTO tasks (id, node_id, session_id, title, status, created_at, archived_at) VALUES (?, 'n1', ?, ?, ?, 0, ?)",
    [id, `ses_${id}`, id, status, archivedAt],
  );
}

const ids = async (app: Hono, path: string) => ((await (await app.request(path)).json()) as Task[]).map((t) => t.id);

test("archived tasks leave the default list and show with ?archived=1", async () => {
  const { db, app } = setup();
  insert(db, "t1", "idle");
  insert(db, "t2", "running");
  insert(db, "t3", "idle", NOW - DAY);
  insert(db, "t4", "stopped", NOW - 2 * DAY);

  const res = await app.request("/api/tasks/t1/archive", { method: "POST" });
  expect(res.status).toBe(200);
  expect((await res.json()).archivedAt).toBe(NOW);

  expect(await ids(app, "/api/tasks")).toEqual(["t2"]);
  expect(await ids(app, "/api/tasks?archived=1")).toEqual(["t1", "t3", "t4"]);
  expect(await ids(app, "/api/tasks?archived=1&status=idle")).toEqual(["t1", "t3"]);
});

test("archive of a running or waiting task is 409, a missing task is 404", async () => {
  const { db, app } = setup();
  insert(db, "t1", "running");
  insert(db, "t2", "waiting_permission");
  for (const id of ["t1", "t2"]) {
    const res = await app.request(`/api/tasks/${id}/archive`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "задача ещё работает, сначала остановите" });
  }
  expect((await app.request("/api/tasks/nope/archive", { method: "POST" })).status).toBe(404);
});

test("unarchive returns the task to the default list and is audited", async () => {
  const { db, app } = setup();
  insert(db, "t1", "idle", NOW - DAY);

  const res = await app.request("/api/tasks/t1/unarchive", { method: "POST" });
  expect(res.status).toBe(200);
  expect((await res.json()).archivedAt).toBeNull();
  expect(await ids(app, "/api/tasks")).toEqual(["t1"]);
  const row = db.query<{ actor: string }, []>("SELECT actor FROM audit WHERE action = 'task_unarchive'").get();
  expect(row?.actor).toBe("admin");
});

test("retention defaults to 90 days and PUT accepts only integers 1..3650", async () => {
  const { app } = setup();
  expect(await (await app.request("/api/settings/task-retention")).json()).toEqual({ days: 90 });

  const put = (body: unknown) =>
    app.request("/api/settings/task-retention", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  for (const days of [0, 3651, 1.5, "30", null]) {
    expect((await put({ days })).status).toBe(400);
  }
  expect((await put({ days: 30 })).status).toBe(200);
  expect(await (await app.request("/api/settings/task-retention")).json()).toEqual({ days: 30 });
});

test("purge deletes only archived tasks past the retention window", () => {
  const { db, deps } = setup();
  insert(db, "old", "idle", NOW - 91 * DAY);
  insert(db, "edge", "idle", NOW - 90 * DAY);
  insert(db, "recent", "idle", NOW - 89 * DAY);
  insert(db, "active", "idle");

  expect(purgeArchivedTasks(deps)).toBe(2);
  expect(db.query<{ id: string }, []>("SELECT id FROM tasks ORDER BY id").all().map((r) => r.id)).toEqual(["active", "recent"]);
  const purged = db.query<{ task_id: string; actor: string }, []>("SELECT task_id, actor FROM audit WHERE action = 'task_purged' ORDER BY task_id").all();
  expect(purged).toEqual([
    { task_id: "edge", actor: "system" },
    { task_id: "old", actor: "system" },
  ]);
});

test("purge uses the retention setting", () => {
  const { db, deps } = setup();
  setSetting(db, "task_archive_days", 7);
  insert(db, "t1", "idle", NOW - 8 * DAY);
  expect(purgeArchivedTasks(deps)).toBe(1);
});
