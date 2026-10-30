import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "./log";
import { openDb } from "./db";
import { buildApp, ConfigError, readConfig, syncBuiltinSkills, type BuiltApp, type Config, type Runtime } from "./index";

const dir = mkdtempSync(join(tmpdir(), "sysadm-index-"));
const TOKEN = "i".repeat(40);
const MASTER = randomBytes(32).toString("base64");

const config: Config = {
  masterKey: Buffer.alloc(32, 9),
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
  internalToken: TOKEN,
  opencodePassword: "pw",
  log: createLog({ secrets: [] }),
  proc: { status: () => ({ state: "stopped", pid: null, restarts: 0, lastExitCode: null, startedAt: null }), restart: async () => {} },
};

const built: BuiltApp = await buildApp(config, { background: false, runtime });

afterAll(() => {
  built.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("readConfig lists every missing variable at once", () => {
  const err = (() => {
    try {
      readConfig({});
    } catch (e) {
      return e;
    }
    return null;
  })();
  expect(err).toBeInstanceOf(ConfigError);
  const message = (err as Error).message;
  for (const name of ["INFRA_DIR", "DB_PATH", "SYSADM_MASTER_KEY"]) {
    expect(message).toContain(name);
  }
});

test("readConfig needs only the master key, infra dir and db path", () => {
  const cfg = readConfig({ SYSADM_MASTER_KEY: MASTER, INFRA_DIR: "/tmp/i", DB_PATH: ":memory:" });
  expect(cfg.opencodePort).toBe(4096);
  expect(cfg.pluginPath).toBe("/app/packages/plugin");
});

const BASE_ENV = { SYSADM_MASTER_KEY: MASTER, INFRA_DIR: "/tmp/i", DB_PATH: ":memory:" };

test("SYSADM_ENV: only the exact value dev turns dev mode on", () => {
  expect(readConfig(BASE_ENV).devMode).toBe(false);
  expect(readConfig({ ...BASE_ENV, SYSADM_ENV: "" }).devMode).toBe(false);
  expect(readConfig({ ...BASE_ENV, SYSADM_ENV: "prod" }).devMode).toBe(false);
  expect(readConfig({ ...BASE_ENV, SYSADM_ENV: "dev" }).devMode).toBe(true);
});

test("SYSADM_ENV: a typo fails startup instead of running as prod", () => {
  for (const value of ["Dev", "devv", "staging"]) {
    expect(() => readConfig({ ...BASE_ENV, SYSADM_ENV: value })).toThrow("SYSADM_ENV");
  }
});

test("readConfig rejects a bad port", () => {
  expect(() => readConfig({ SYSADM_MASTER_KEY: MASTER, INFRA_DIR: "/tmp/i", DB_PATH: ":memory:", OPENCODE_PORT: "abc" })).toThrow(
    "OPENCODE_PORT must be a port number",
  );
});

test("health answers 200 without a session", async () => {
  const res = await built.publicApp.request("/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("health answers 503 once the database is closed", async () => {
  const other = await buildApp(config, { background: false, runtime });
  await other.stop();
  const res = await other.publicApp.request("/api/health");
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ ok: false });
});

test("every response carries the security headers", async () => {
  const res = await built.publicApp.request("/api/health");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
});

test("the tree needs a session cookie", async () => {
  const res = await built.publicApp.request("/api/tree");
  expect(res.status).toBe(401);
});

test("the internal exec route is not served on the public port", async () => {
  const res = await built.publicApp.request("/internal/exec", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sessionID: "x", command: "uptime" }),
  });
  expect(res.status).toBe(404);
});

test("the internal app refuses requests without the token", async () => {
  const res = await built.internalApp.request("/internal/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: "x", command: "uptime" }),
  });
  expect(res.status).toBe(401);
});

test("a body over 1 MiB is refused with 413", async () => {
  const big = "x".repeat(2 * 1024 * 1024);
  const res = await built.publicApp.request("/api/credentials", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(big.length) },
    body: JSON.stringify({ name: big }),
  });
  expect(res.status).toBe(413);
});

describe("request log", () => {
  async function loggedApp() {
    const log = createLog({ secrets: [], minLevel: "debug" });
    const app = await buildApp(config, { background: false, runtime: { ...runtime, log } });
    return { app, log };
  }

  test("an unauthenticated tree request is logged as a warn with its status", async () => {
    const { app, log } = await loggedApp();
    await app.publicApp.request("/api/tree");
    const entry = log.query().find((e) => e.msg.includes("GET /api/tree"));
    expect(entry?.level).toBe("warn");
    expect(entry?.msg).toContain(" 401 ");
    app.stop();
  });

  test("health polling is not logged", async () => {
    const { app, log } = await loggedApp();
    for (let i = 0; i < 10; i++) await app.publicApp.request("/api/health");
    expect(log.query()).toEqual([]);
    app.stop();
  });

  test("a thrown error becomes a 500 and an error entry", async () => {
    const { app, log } = await loggedApp();
    await app.stop(); // closes the database, so the next token lookup throws
    const res = await app.publicApp.request("/api/tree", { headers: { authorization: `Bearer sat_${"x".repeat(40)}` } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    expect(log.query({ level: "error" }).some((e) => e.msg.includes("unhandled GET /api/tree"))).toBe(true);
  });

  test("a failed login is logged at info and never contains the password", async () => {
    const { app, log } = await loggedApp();
    const res = await app.publicApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "marker-pass-123", code: "000000" }),
    });
    expect(res.status).toBe(401);
    const entry = log.query().find((e) => e.msg.includes("POST /api/auth/login"));
    expect(entry?.level).toBe("info");
    expect(entry?.msg).toContain(" 401 ");
    expect(log.query().some((e) => e.msg.includes("marker-pass-123"))).toBe(false);
    app.stop();
  });
});

// Runs the real entry point against a fake `opencode`, then checks that SIGTERM stops both processes.
test("SIGTERM stops the server with exit 0 and kills the opencode child", async () => {
  const fakeDir = join(dir, "fake");
  const pidFile = join(fakeDir, "child.pid");
  const fake = join(fakeDir, "opencode");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(
    fake,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const port = Number(Bun.argv[Bun.argv.indexOf("--port") + 1]);
Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({ ok: true }) });
`,
  );
  chmodSync(fake, 0o755);

  const ports = () => 20_000 + Math.floor(Math.random() * 20_000);
  const publicPort = ports();
  const internalPort = publicPort + 1;
  const opencodePort = publicPort + 2;
  const server = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts")], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      SYSADM_MASTER_KEY: MASTER,
      INFRA_DIR: join(dir, "live-infra"),
      DB_PATH: join(dir, "live.sqlite"),
      OPENCODE_BIN: fake,
      OPENCODE_PORT: String(opencodePort),
      OPENCODE_HOME: join(dir, "live-home"),
      PLUGIN_PATH: join(dir, "plugin"),
      SKILLS_DIR: join(dir, "no-skills"),
      WEB_DIST: join(dir, "no-web"),
      PUBLIC_PORT: String(publicPort),
      INTERNAL_PORT: String(internalPort),
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  let healthy = false;
  for (let i = 0; i < 150 && !healthy; i++) {
    healthy = await fetch(`http://127.0.0.1:${publicPort}/api/health`)
      .then((r) => r.status === 200)
      .catch(() => false);
    if (!healthy) await Bun.sleep(100);
  }
  expect(healthy).toBe(true);
  const childPid = Number(readFileSync(pidFile, "utf8"));

  server.kill("SIGTERM");
  const timeout = Bun.sleep(10_000).then(() => "timeout" as const);
  const exit = await Promise.race([server.exited, timeout]);
  expect(exit).not.toBe("timeout");
  expect(server.exitCode).toBe(0);
  expect(() => process.kill(childPid, 0)).toThrow();
}, 40_000);

test("syncBuiltinSkills reads folded descriptions and drops built-ins no longer shipped", () => {
  const skills = mkdtempSync(join(dir, "skills-"));
  mkdirSync(join(skills, "fresh"));
  writeFileSync(join(skills, "fresh", "SKILL.md"), "---\nname: fresh\ndescription: Manage things. Use when\n  things break.\n---\nbody\n");
  const db = openDb(":memory:");
  db.run("INSERT INTO skills (id, name, description, content, builtin) VALUES ('gone', 'gone', '', '', 1), ('mine', 'mine', '', '', 0)");
  db.run("INSERT INTO nodes (id, kind, name) VALUES ('n1', 'company', 'Acme')");
  db.run("INSERT INTO node_skills (node_id, skill_id) VALUES ('n1', 'gone')");

  expect(syncBuiltinSkills(db, skills)).toBe(1);
  const rows = db.query<{ id: string; description: string }, []>("SELECT id, description FROM skills ORDER BY id").all();
  expect(rows).toEqual([
    { id: "fresh", description: "Manage things. Use when things break." },
    { id: "mine", description: "" },
  ]);
  expect(db.query("SELECT * FROM node_skills").all()).toEqual([]);
  db.close();
});
