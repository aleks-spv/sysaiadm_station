import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  dataDir: join(dir, "data"),
  devMode: false,
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
    .filter((r) => r.path !== "/api/health" && !r.path.startsWith("/api/auth") && !r.path.startsWith("/api/tokens") && !r.path.startsWith("/api/plugins"))
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

test("plugin routes are cookie-only: an admin token gets 403", async () => {
  const { token } = createToken(built.db, { name: "adm-plugins", scopes: ["admin"] });
  for (const path of ["/api/plugins", "/api/plugins/wireguard/tunnels"]) {
    const res = await built.publicApp.request(path, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  }
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

test("an edited built-in skill is reset to the shipped original", async () => {
  const { token } = createToken(built.db, { name: "adm-skills", scopes: ["read", "admin"] });
  const call = (method: string, path: string, body?: unknown) =>
    built.publicApp.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const original = "---\nname: Demo\ndescription: shipped\n---\nbody";
  mkdirSync(join(config.skillsDir, "demo"), { recursive: true });
  writeFileSync(join(config.skillsDir, "demo", "SKILL.md"), original);
  built.db.run("INSERT INTO skills (id, name, description, content, builtin) VALUES ('demo', 'Demo', 'shipped', ?, 1)", [original]);

  expect((await call("PUT", "/api/skills/demo", { name: "Mine", description: "edited", content: "mine" })).status).toBe(200);
  const listed = (await (await call("GET", "/api/skills")).json()) as Array<{ id: string; builtin: number; shipped: boolean }>;
  expect(listed.find((s) => s.id === "demo")).toMatchObject({ builtin: 0, shipped: true });
  expect(listed.find((s) => s.id === "custom-skill")).toMatchObject({ shipped: false });

  expect((await call("POST", "/api/skills/demo/reset")).status).toBe(200);
  const row = built.db.query<{ content: string; builtin: number }, []>("SELECT content, builtin FROM skills WHERE id = 'demo'").get();
  expect(row).toEqual({ content: original, builtin: 1 });
  expect((await call("POST", "/api/skills/custom-skill/reset")).status).toBe(404);
});

test("export → import round trip and a backup over HTTP with an admin token", async () => {
  const { token } = createToken(built.db, { name: "adm-transfer", scopes: ["admin"] });
  const auth = { Authorization: `Bearer ${token}` };
  const call = (method: string, path: string, body?: BodyInit, json = true) =>
    built.publicApp.request(path, { method, headers: json && body ? { ...auth, "Content-Type": "application/json" } : auth, body });

  const company = await (await call("POST", "/api/nodes", JSON.stringify({ kind: "company", name: "Transfer Co" }))).json();
  expect((await call("POST", "/api/inventory/export", JSON.stringify({ rootId: company.id, passphrase: "short" }))).status).toBe(400);
  const res = await call("POST", "/api/inventory/export", JSON.stringify({ rootId: company.id, passphrase: "long enough passphrase" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Disposition")).toContain(".sysaiadm");
  const file = await res.text();

  const form = new FormData();
  form.set("file", new File([file], "x.sysaiadm"));
  form.set("passphrase", "long enough passphrase");
  const imported = await call("POST", "/api/inventory/import", form, false);
  expect(await imported.json()).toEqual({ nodes: 1, credentials: 0, warnings: [] });

  form.set("passphrase", "wrong passphrase here");
  expect((await call("POST", "/api/inventory/import", form, false)).status).toBe(400);

  const backup = await call("POST", "/api/backups");
  expect(backup.status).toBe(201);
  const { name } = await backup.json();
  expect((await call("GET", `/api/backups/${name}`)).status).toBe(200);
  expect((await call("GET", "/api/backups/..%2Fsecret")).status).toBe(404);
});
