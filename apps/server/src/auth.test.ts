import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import * as OTPAuth from "otpauth";
import { openDb } from "./db";
import { authRoutes, createAuth, matchRouteScope, requireAuth } from "./auth";
import { createToken, revokeToken } from "./tokens";

const PASSWORD = "correct-horse-battery";
const HOUR = 60 * 60 * 1000;

let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sysadm-auth-"));
  clock = 1_000_000;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setupApp() {
  const db = openDb(join(dir, "auth.sqlite"));
  const auth = createAuth({ db, masterKey: randomBytes(32), now: () => clock });
  const app = new Hono();
  app.route("/api/auth", authRoutes(auth));
  app.post("/api/probe", requireAuth(auth, db), (c) => c.text("ok"));
  return { app, auth, db };
}

const post = (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function setupAndGetSecret(app: Hono): Promise<OTPAuth.TOTP> {
  const res = await post(app, "/api/auth/setup", { password: PASSWORD });
  expect(res.status).toBe(201);
  const { otpauth } = (await res.json()) as { otpauth: string };
  return OTPAuth.URI.parse(otpauth) as OTPAuth.TOTP;
}

describe("auth", () => {
  test("second setup is refused", async () => {
    const { app } = setupApp();
    await setupAndGetSecret(app);
    const again = await post(app, "/api/auth/setup", { password: PASSWORD });
    expect(again.status).toBe(409);
  });

  test("correct password and code set an HttpOnly SameSite=Strict cookie", async () => {
    const { app } = setupApp();
    const totp = await setupAndGetSecret(app);
    const res = await post(app, "/api/auth/login", { password: PASSWORD, code: totp.generate() });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/sid=/);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=strict");
    expect(await res.text()).not.toContain("sid");
  });

  test("wrong code and wrong password give the same 401", async () => {
    const { app } = setupApp();
    const totp = await setupAndGetSecret(app);
    const badCode = await post(app, "/api/auth/login", { password: PASSWORD, code: "000000" });
    const badPass = await post(app, "/api/auth/login", { password: "wrong-password-xx", code: totp.generate() });
    expect(badCode.status).toBe(401);
    expect(badPass.status).toBe(401);
    expect(await badCode.text()).toBe(await badPass.text());
  });

  test("sixth attempt inside 15 minutes gets 429", async () => {
    const { app } = setupApp();
    const totp = await setupAndGetSecret(app);
    for (let i = 0; i < 5; i++) {
      await post(app, "/api/auth/login", { password: "bad", code: "000000" });
    }
    const sixth = await post(app, "/api/auth/login", { password: PASSWORD, code: totp.generate() });
    expect(sixth.status).toBe(429);
  });

  test("mutating request without X-Requested-With gets 403", async () => {
    const { app } = setupApp();
    const totp = await setupAndGetSecret(app);
    const login = await post(app, "/api/auth/login", { password: PASSWORD, code: totp.generate() });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const noHeader = await app.request("/api/probe", { method: "POST", headers: { cookie } });
    expect(noHeader.status).toBe(403);
    const withHeader = await app.request("/api/probe", {
      method: "POST",
      headers: { cookie, "x-requested-with": "sysadm" },
    });
    expect(withHeader.status).toBe(200);
  });

  test("expired session gets 401", async () => {
    const { app } = setupApp();
    const totp = await setupAndGetSecret(app);
    const login = await post(app, "/api/auth/login", { password: PASSWORD, code: totp.generate() });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    clock += 12 * HOUR + 1;
    const res = await app.request("/api/probe", {
      method: "POST",
      headers: { cookie, "x-requested-with": "sysadm" },
    });
    expect(res.status).toBe(401);
  });

  test("status reports setup and authed", async () => {
    const { app } = setupApp();
    const before = (await (await app.request("/api/auth/status")).json()) as { setup: boolean; authed: boolean };
    expect(before).toEqual({ setup: false, authed: false });
    await setupAndGetSecret(app);
    const after = (await (await app.request("/api/auth/status")).json()) as { setup: boolean };
    expect(after.setup).toBe(true);
  });
});

function bearerApp() {
  const db = openDb(join(dir, "bearer.sqlite"));
  const auth = createAuth({ db, masterKey: randomBytes(32), now: () => clock });
  const app = new Hono();
  app.route("/api/auth", authRoutes(auth));
  app.use("/api/*", requireAuth(auth, db));
  app.get("/api/tree", (c) => c.text("ok"));
  app.get("/api/nodes/:id", (c) => c.text("ok"));
  app.post("/api/nodes", (c) => c.text("ok"));
  app.post("/api/nodes/:id/tasks", (c) => c.text("ok"));
  app.get("/api/tokens", (c) => c.text("ok"));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  return { app, db };
}

describe("bearer tokens", () => {
  // Tokens use the real clock: the middleware checks expiry against Date.now().
  const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });

  test("read token: GET tree is 200, POST nodes is 403", async () => {
    const { app, db } = bearerApp();
    const { token } = createToken(db, { name: "ro", scopes: ["read"] });
    expect((await app.request("/api/tree", { headers: bearer(token) })).status).toBe(200);
    expect((await app.request("/api/nodes", { method: "POST", headers: bearer(token) })).status).toBe(403);
  });

  test("admin token mutates without X-Requested-With and actor is token:<name>", async () => {
    const { app, db } = bearerApp();
    const { token } = createToken(db, { name: "robot", scopes: ["admin"] });
    expect((await app.request("/api/nodes", { method: "POST", headers: bearer(token) })).status).toBe(200);
  });

  test("tasks scope reaches the handler on POST /api/nodes/:id/tasks", async () => {
    const { app, db } = bearerApp();
    const { token } = createToken(db, { name: "t", scopes: ["tasks"] });
    expect((await app.request("/api/nodes/x/tasks", { method: "POST", headers: bearer(token) })).status).toBe(200);
  });

  test("revoked token gets 401", async () => {
    const { app, db } = bearerApp();
    const { id, token } = createToken(db, { name: "gone", scopes: ["read"] });
    revokeToken(db, id);
    expect((await app.request("/api/tree", { headers: bearer(token) })).status).toBe(401);
  });

  test("21st failed Bearer attempt from one IP gets 429", async () => {
    const { app } = bearerApp();
    for (let i = 0; i < 20; i++) {
      expect((await app.request("/api/tree", { headers: bearer("sat_wrong") })).status).toBe(401);
    }
    expect((await app.request("/api/tree", { headers: bearer("sat_wrong") })).status).toBe(429);
  });

  test("/api/tokens is 403 for a Bearer token even with admin scope", async () => {
    const { app, db } = bearerApp();
    const { token } = createToken(db, { name: "adm", scopes: ["admin"] });
    expect((await app.request("/api/tokens", { headers: bearer(token) })).status).toBe(403);
  });

  test("unlisted routes are 403 for admin tokens", async () => {
    const { app, db } = bearerApp();
    const { token } = createToken(db, { name: "adm", scopes: ["admin"] });
    expect((await app.request("/api/nodes/x/unlisted", { method: "POST", headers: bearer(token) })).status).toBe(403);
    expect((await app.request("/api/nodes/x/y/z", { headers: bearer(token) })).status).toBe(403);
  });

  test("an invalid Authorization header wins over a valid cookie", async () => {
    const { app } = bearerApp();
    const totp = await setupAndGetSecret(app);
    const login = await post(app, "/api/auth/login", { password: PASSWORD, code: totp.generate() });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const res = await app.request("/api/tree", { headers: { cookie, authorization: "Bearer sat_nope" } });
    expect(res.status).toBe(401);
  });

  test("route templates are anchored", () => {
    expect(matchRouteScope("GET", "/api/nodes/a")).toBe("read");
    expect(matchRouteScope("GET", "/api/nodes/a/b")).toBeNull();
  });
});
