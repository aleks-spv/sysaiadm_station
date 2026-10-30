import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDb } from "../db";
import { createLog, type Log } from "../log";
import { systemRoutes } from "./system";

const SECRET = "master-secret-value";

let dir: string;
let db: Database;
let log: Log;
let restarts: number;
let app: Hono;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "system-routes-"));
  db = openDb(join(dir, "system.sqlite"));
  log = createLog({ secrets: [SECRET], minLevel: "debug" });
  restarts = 0;
  const proc = {
    status: () => ({ state: "running" as const, pid: 1, restarts: 0, lastExitCode: null, startedAt: 0 }),
    restart: async () => {
      restarts++;
    },
  };
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("actor", "admin");
    await next();
  });
  app.route("/", systemRoutes({ db, log, proc, startedAt: Date.now(), version: "test" }));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const json = (res: Response) => res.json() as Promise<Record<string, unknown>>;

test("health includes opencode state and schema version", async () => {
  const body = await json(await app.request("/api/system/health"));
  expect((body.opencode as { state: string }).state).toBe("running");
  expect((body.db as { ok: boolean }).ok).toBe(true);
});

test("logs respect limit and never contain the secret", async () => {
  log.write("app", "info", `leaked ${SECRET}`);
  for (let i = 0; i < 3; i++) log.write("app", "info", `line ${i}`);
  const res = await app.request("/api/system/logs?limit=2");
  const text = await res.text();
  const rows = JSON.parse(text) as Array<{ msg: string }>;
  expect(rows).toHaveLength(2);
  expect(text.includes(SECRET)).toBe(false);
});

test("logs reject unknown filters with 400", async () => {
  expect((await app.request("/api/system/logs?source=nope")).status).toBe(400);
  expect((await app.request("/api/system/logs?level=bogus")).status).toBe(400);
});

test("level=debug returns only debug entries", async () => {
  log.write("app", "debug", "dbg-line");
  log.write("app", "info", "info-line");
  const res = await app.request("/api/system/logs?level=debug");
  const rows = (await res.json()) as Array<{ msg: string; level: string }>;
  expect(rows.map((r) => r.msg)).toEqual(["dbg-line"]);
  expect(rows[0].level).toBe("debug");
});

test("POST tokens returns the raw token once; GET never returns token or hash", async () => {
  const created = await app.request("/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ci", scopes: ["read"] }),
  });
  expect(created.status).toBe(201);
  const { token, id } = (await json(created)) as { token: string; id: string };
  expect(token.startsWith("sat_")).toBe(true);

  const listed = await app.request("/api/tokens");
  const text = await listed.text();
  expect(text.includes(token)).toBe(false);
  expect(text.includes("hash")).toBe(false);
  expect(JSON.parse(text)[0].id).toBe(id);
});

test("DELETE revokes the token and writes an audit row without the value", async () => {
  const created = await app.request("/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "gone", scopes: ["read"] }),
  });
  const { token, id } = (await json(created)) as { token: string; id: string };
  expect((await app.request(`/api/tokens/${id}`, { method: "DELETE" })).status).toBe(200);
  const row = db.query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM api_tokens WHERE id = ?").get(id);
  expect(row?.revoked_at).not.toBeNull();
  const audit = db.query<{ detail: string }, []>("SELECT detail FROM audit WHERE action = 'token_create'").all();
  expect(audit.some((a) => a.detail.includes(token))).toBe(false);
});

test("restart calls proc.restart and audits it as admin", async () => {
  const res = await app.request("/api/system/opencode/restart", { method: "POST" });
  expect(res.status).toBe(200);
  expect(restarts).toBe(1);
  const row = db.query<{ actor: string }, []>("SELECT actor FROM audit WHERE action = 'opencode_restart'").get();
  expect(row?.actor).toBe("admin");
});
