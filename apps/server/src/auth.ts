import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import * as OTPAuth from "otpauth";
import { audit } from "./guard";
import { verifyToken, type Scope } from "./tokens";
import { open, seal } from "./vault";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILS = 5;
const MIN_PASSWORD = 12;
const COOKIE = "sid";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 409 | 429,
  ) {
    super(message);
  }
}

// Session tokens are stored hashed: a DB read does not yield a usable cookie.
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export interface AuthDeps {
  db: Database;
  masterKey: Buffer;
  now?: () => number;
}

export function createAuth({ db, masterKey, now = Date.now }: AuthDeps) {
  const fails = new Map<string, number[]>();

  const recentFails = (ip: string): number[] => {
    const cutoff = now() - RATE_WINDOW_MS;
    const list = (fails.get(ip) ?? []).filter((t) => t > cutoff);
    fails.set(ip, list);
    return list;
  };

  const isSetup = (): boolean => !!db.query("SELECT 1 FROM admin WHERE id = 1").get();

  const totpFor = (base32: string) =>
    new OTPAuth.TOTP({
      issuer: "sysadm",
      label: "admin",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(base32),
    });

  async function setup(password: string): Promise<string> {
    if (isSetup()) throw new AuthError("already set up", 409);
    if (password.length < MIN_PASSWORD) throw new AuthError(`password must be at least ${MIN_PASSWORD} characters`, 400);

    const secret = new OTPAuth.Secret().base32;
    const enc = seal(masterKey, secret, "totp");
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    try {
      db.run(
        "INSERT INTO admin (id, password_hash, totp_secret_enc, totp_iv, totp_tag) VALUES (1, ?, ?, ?, ?)",
        [hash, enc.ciphertext, enc.iv, enc.tag],
      );
    } catch {
      throw new AuthError("already set up", 409);
    }
    audit(db, { actor: "system", action: "admin_setup" });
    return totpFor(secret).toString();
  }

  async function login(password: string, code: string, ip: string): Promise<string> {
    if (recentFails(ip).length >= RATE_MAX_FAILS) throw new AuthError("too many attempts", 429);

    const row = db
      .query<{ password_hash: string; totp_secret_enc: Buffer; totp_iv: Buffer; totp_tag: Buffer }, []>(
        "SELECT password_hash, totp_secret_enc, totp_iv, totp_tag FROM admin WHERE id = 1",
      )
      .get();

    // Same generic error for wrong password and wrong code: the caller learns nothing about which one failed.
    let ok = false;
    if (row) {
      const pwOk = await Bun.password.verify(password, row.password_hash);
      const secret = open(masterKey, { ciphertext: row.totp_secret_enc, iv: row.totp_iv, tag: row.totp_tag }, "totp").toString();
      const codeOk = totpFor(secret).validate({ token: code, window: 1 }) !== null;
      ok = pwOk && codeOk;
    }
    if (!ok) {
      fails.set(ip, [...recentFails(ip), now()]);
      audit(db, { actor: ip, action: "login_fail" });
      throw new AuthError("invalid credentials", 401);
    }

    fails.delete(ip);
    const token = randomBytes(32).toString("base64url");
    db.run("INSERT INTO auth_sessions (id, expires_at) VALUES (?, ?)", [hashToken(token), now() + SESSION_TTL_MS]);
    audit(db, { actor: "admin", action: "login_ok", detail: { ip } });
    return token;
  }

  function validate(token: string | undefined): boolean {
    if (!token) return false;
    const id = hashToken(token);
    const row = db.query<{ expires_at: number }, [string]>("SELECT expires_at FROM auth_sessions WHERE id = ?").get(id);
    if (!row) return false;
    if (row.expires_at <= now()) {
      db.run("DELETE FROM auth_sessions WHERE id = ?", [id]);
      return false;
    }
    return true;
  }

  function logout(token: string | undefined): void {
    if (token) db.run("DELETE FROM auth_sessions WHERE id = ?", [hashToken(token)]);
  }

  return { isSetup, setup, login, validate, logout };
}

export type Auth = ReturnType<typeof createAuth>;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BEARER_MAX_FAILS = 20;

export interface RouteScope {
  method: string;
  pattern: string;
  scope: Scope;
}

// Deny by default: a Bearer request to a path not listed here gets 403.
export const ROUTE_SCOPES: RouteScope[] = [
  { method: "GET", pattern: "/api/tree", scope: "read" },
  { method: "GET", pattern: "/api/nodes/:id", scope: "read" },
  { method: "GET", pattern: "/api/skills", scope: "read" },
  { method: "GET", pattern: "/api/tasks", scope: "read" },
  { method: "GET", pattern: "/api/tasks/:id", scope: "read" },
  { method: "GET", pattern: "/api/tasks/:id/permissions", scope: "read" },
  { method: "GET", pattern: "/api/audit", scope: "read" },
  { method: "GET", pattern: "/api/events", scope: "read" },
  { method: "GET", pattern: "/api/credentials", scope: "read" },
  { method: "GET", pattern: "/api/settings/providers", scope: "read" },
  { method: "GET", pattern: "/api/settings/models", scope: "read" },
  { method: "GET", pattern: "/api/system/health", scope: "read" },
  { method: "POST", pattern: "/api/nodes/:id/tasks", scope: "tasks" },
  { method: "POST", pattern: "/api/tasks/:id/prompt", scope: "tasks" },
  { method: "POST", pattern: "/api/tasks/:id/stop", scope: "tasks" },
  { method: "POST", pattern: "/api/tasks/:id/permissions/:requestID", scope: "approve" },
  { method: "GET", pattern: "/api/system/logs", scope: "logs" },
  { method: "POST", pattern: "/api/nodes", scope: "admin" },
  { method: "PATCH", pattern: "/api/nodes/:id", scope: "admin" },
  { method: "DELETE", pattern: "/api/nodes/:id", scope: "admin" },
  { method: "POST", pattern: "/api/nodes/:id/move", scope: "admin" },
  { method: "POST", pattern: "/api/nodes/:id/reset-hostkey", scope: "admin" },
  { method: "PUT", pattern: "/api/nodes/:id/skills", scope: "admin" },
  { method: "POST", pattern: "/api/skills", scope: "admin" },
  { method: "PUT", pattern: "/api/skills/:id", scope: "admin" },
  { method: "DELETE", pattern: "/api/skills/:id", scope: "admin" },
  { method: "POST", pattern: "/api/credentials", scope: "admin" },
  { method: "PUT", pattern: "/api/credentials/:id", scope: "admin" },
  { method: "DELETE", pattern: "/api/credentials/:id", scope: "admin" },
  { method: "POST", pattern: "/api/import/preview", scope: "admin" },
  { method: "POST", pattern: "/api/import/apply", scope: "admin" },
  { method: "POST", pattern: "/api/settings/providers/:id/key", scope: "admin" },
  { method: "POST", pattern: "/api/system/opencode/restart", scope: "admin" },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const compiledScopes = ROUTE_SCOPES.map((r) => ({
  method: r.method,
  scope: r.scope,
  re: new RegExp(`^${r.pattern.split(/:[A-Za-z]+/).map(escapeRe).join("[^/]+")}$`),
}));

// Scope a Bearer token needs for this request, or null when the route is not in the map.
export function matchRouteScope(method: string, path: string): Scope | null {
  return compiledScopes.find((r) => r.method === method && r.re.test(path))?.scope ?? null;
}

declare module "hono" {
  interface ContextVariableMap {
    // Who the request acts as: "admin" (cookie) or "token:<name>" (Bearer). Audit uses it.
    actor: string;
    scopes: Scope[] | "*";
  }
}

// A Bearer header bypasses the cookie entirely. Cookie requests keep the session check and the CSRF header.
export const requireAuth = (auth: Auth, db: Database) => {
  const bearerFails = new Map<string, number[]>();
  return createMiddleware(async (c, next) => {
    const header = c.req.header("authorization");
    if (header !== undefined) {
      const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
      const now = Date.now();
      const recent = (bearerFails.get(ip) ?? []).filter((t) => t > now - RATE_WINDOW_MS);
      bearerFails.set(ip, recent);
      if (recent.length >= BEARER_MAX_FAILS) return c.json({ error: "too many attempts" }, 429);
      const raw = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
      const token = raw ? verifyToken(db, raw, now) : null;
      if (!token) {
        bearerFails.set(ip, [...recent, now]);
        return c.json({ error: "unauthorized" }, 401);
      }
      const needed = c.req.path.startsWith("/api/tokens") ? null : matchRouteScope(c.req.method, c.req.path);
      if (needed === null || !token.scopes.includes(needed)) return c.json({ error: "forbidden" }, 403);
      c.set("actor", `token:${token.name}`);
      c.set("scopes", token.scopes);
      return next();
    }
    if (!auth.validate(getCookie(c, COOKIE))) return c.json({ error: "unauthorized" }, 401);
    if (MUTATING.has(c.req.method) && c.req.header("x-requested-with") !== "sysadm") {
      return c.json({ error: "csrf header missing" }, 403);
    }
    c.set("actor", "admin");
    c.set("scopes", "*");
    await next();
  });
};

export function authRoutes(auth: Auth) {
  const app = new Hono();

  app.get("/status", (c) =>
    c.json({ setup: auth.isSetup(), authed: auth.validate(getCookie(c, COOKIE)) }),
  );

  app.post("/setup", async (c) => {
    const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
    try {
      const otpauth = await auth.setup(body.password ?? "");
      return c.json({ otpauth }, 201);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  app.post("/login", async (c) => {
    const body = await c.req.json<{ password?: string; code?: string }>().catch(() => ({}) as { password?: string; code?: string });
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    try {
      const token = await auth.login(body.password ?? "", body.code ?? "", ip);
      setCookie(c, COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
      });
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  app.post("/logout", (c) => {
    auth.logout(getCookie(c, COOKIE));
    setCookie(c, COOKIE, "", { path: "/", maxAge: 0 });
    return c.json({ ok: true });
  });

  return app;
}
