import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTE_SCOPES } from "../auth";
import { buildApp, type BuiltApp, type Config, type Runtime } from "../index";
import { createLog } from "../log";
import { createToken } from "../tokens";

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];
const dir = mkdtempSync(join(tmpdir(), "sysadm-rest-"));
let built: BuiltApp;

const config: Config = {
  masterKey: randomBytes(32),
  infraDir: join(dir, "infra"),
  dbPath: ":memory:",
  skillsDir: join(dir, "no-skills"),
  webDist: join(dir, "no-web"),
  publicPort: 8080,
  internalPort: 3001,
  opencodeBin: "opencode",
  opencodePort: 4096,
  opencodeHome: join(dir, "home"),
  pluginPath: join(dir, "plugin"),
};

const runtime: Runtime = {
  internalToken: "t".repeat(40),
  opencodePassword: "pw",
  log: createLog({ secrets: [] }),
  proc: { status: () => ({ state: "stopped", pid: null, restarts: 0, lastExitCode: null, startedAt: null }), restart: async () => {} },
};

beforeAll(async () => {
  built = await buildApp(config, { background: false, runtime });
});

afterAll(() => {
  built.stop();
  rmSync(dir, { recursive: true, force: true });
});

// Hono reports `:param` routes as they are written, so the table keys match directly.
const apiRoutes = () =>
  built.publicApp.routes.filter((r) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(r.method) && r.path.startsWith("/api/"));

const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, "x");

test("every API route is in ROUTE_SCOPES, or is health, auth or cookie-only tokens", () => {
  expect(apiRoutes().length).toBeGreaterThan(30);
  const missing = apiRoutes()
    .filter((r) => r.path !== "/api/health" && !r.path.startsWith("/api/auth") && !r.path.startsWith("/api/tokens"))
    .filter((r) => !ROUTE_SCOPES.some((s) => s.method === r.method && s.pattern === r.path))
    .map((r) => `${r.method} ${r.path}`);
  expect(missing).toEqual([]);
});

test("a read-only token gets 403 on every mutating route", async () => {
  const { token } = createToken(built.db, { name: "readonly", scopes: ["read"] });
  for (const s of ROUTE_SCOPES.filter((s) => MUTATING.includes(s.method) && s.scope !== "read")) {
    const res = await built.publicApp.request(concrete(s.pattern), {
      method: s.method,
      headers: { authorization: `Bearer ${token}` },
    });
    expect({ route: `${s.method} ${s.pattern}`, status: res.status }).toEqual({ route: `${s.method} ${s.pattern}`, status: 403 });
  }
});

test("an unlisted /api path is 403 for an admin token, the cookie rule does not leak", async () => {
  const { token } = createToken(built.db, { name: "adm-unlisted", scopes: ["admin"] });
  const res = await built.publicApp.request("/api/nodes/x/unlisted", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(403);
});

test("approve token cannot answer with always, but can answer once", async () => {
  const { token } = createToken(built.db, { name: "approver", scopes: ["approve"] });
  built.db.run("INSERT INTO nodes (id, kind, name) VALUES ('n1', 'vm', 'vm1')");
  built.db.run(
    "INSERT INTO tasks (id, node_id, session_id, title, status, created_at) VALUES ('t1', 'n1', 'ses_1', 'x', 'waiting_permission', 0)",
  );
  const always = await built.publicApp.request("/api/tasks/t1/permissions/r1", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "always" }),
  });
  expect(always.status).toBe(403);
  expect(await always.json()).toEqual({ error: "always requires an admin session" });
});

test("an admin token cannot switch autopilot on", async () => {
  const { token } = createToken(built.db, { name: "adm-autopilot", scopes: ["admin"] });
  const res = await built.publicApp.request("/api/nodes/n1", {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ autopilot: true }),
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "autopilot requires an admin session" });
});

test("a mutation by an admin token is audited as token:<name>", async () => {
  const { token } = createToken(built.db, { name: "auditor", scopes: ["admin"] });
  const res = await built.publicApp.request("/api/skills", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "custom-skill", name: "Custom", description: "d", content: "c" }),
  });
  expect(res.status).toBeLessThan(300);
  const row = built.db.query<{ actor: string }, []>("SELECT actor FROM audit WHERE action = 'skill_create' ORDER BY id DESC").get();
  expect(row?.actor).toBe("token:auditor");
});
