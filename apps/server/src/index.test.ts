import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "./log";
import { buildApp, ConfigError, readConfig, type BuiltApp, type Config, type Runtime } from "./index";

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
  other.stop();
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
