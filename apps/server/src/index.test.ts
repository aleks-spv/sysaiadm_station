import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, ConfigError, readConfig, type BuiltApp, type Config } from "./index";

const dir = mkdtempSync(join(tmpdir(), "sysadm-index-"));
const TOKEN = "i".repeat(40);

const config: Config = {
  masterKey: Buffer.alloc(32, 9),
  internalToken: TOKEN,
  opencodeUrl: "http://127.0.0.1:1",
  opencodePassword: "pw",
  infraDir: join(dir, "infra"),
  dbPath: ":memory:",
  skillsDir: join(dir, "no-skills"),
  webDist: join(dir, "no-web"),
};

const built: BuiltApp = await buildApp(config, { background: false });

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
  for (const name of ["SYSADM_INTERNAL_TOKEN", "OPENCODE_URL", "OPENCODE_SERVER_PASSWORD", "INFRA_DIR", "DB_PATH"]) {
    expect(message).toContain(name);
  }
});

test("readConfig rejects a short internal token", () => {
  expect(() =>
    readConfig({
      SYSADM_INTERNAL_TOKEN: "short",
      OPENCODE_URL: "http://x",
      OPENCODE_SERVER_PASSWORD: "pw",
      INFRA_DIR: "/tmp/i",
      DB_PATH: ":memory:",
      SYSADM_MASTER_KEY: Buffer.alloc(32).toString("base64"),
    }),
  ).toThrow("SYSADM_INTERNAL_TOKEN must be at least 32");
});

test("health answers 200 without a session", async () => {
  const res = await built.publicApp.request("/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
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
