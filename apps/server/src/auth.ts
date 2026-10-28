import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import * as OTPAuth from "otpauth";
import { audit } from "./guard";
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

// Requires a valid session cookie. Mutating methods also need X-Requested-With (CSRF guard for a cookie API).
export const requireAuth = (auth: Auth) =>
  createMiddleware(async (c, next) => {
    if (!auth.validate(getCookie(c, COOKIE))) return c.json({ error: "unauthorized" }, 401);
    if (MUTATING.has(c.req.method) && c.req.header("x-requested-with") !== "sysadm") {
      return c.json({ error: "csrf header missing" }, 403);
    }
    await next();
  });

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
