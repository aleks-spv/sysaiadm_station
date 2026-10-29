import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { SCHEMA_VERSION } from "../db";
import { audit } from "../guard";
import type { Log, LogLevel, LogSource } from "../log";
import type { OpencodeProc } from "../opencode-proc";
import { createToken, listTokens, revokeToken } from "../tokens";

export interface SystemDeps {
  db: Database;
  log: Log;
  proc: Pick<OpencodeProc, "status" | "restart">;
  startedAt: number;
  version: string;
}

const SOURCES: LogSource[] = ["app", "opencode"];
const LEVELS: LogLevel[] = ["info", "warn", "error"];

export function systemRoutes({ db, log, proc, startedAt, version }: SystemDeps): Hono {
  const app = new Hono();

  app.get("/api/system/health", (c) => {
    let dbOk = true;
    try {
      db.query("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    const counts = Object.fromEntries(
      db
        .query<{ status: string; n: number }, []>("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")
        .all()
        .map((r) => [r.status, r.n]),
    );
    return c.json({
      version,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      db: { ok: dbOk, schemaVersion: SCHEMA_VERSION },
      opencode: proc.status(),
      tasks: { running: counts.running ?? 0, waiting_permission: counts.waiting_permission ?? 0 },
    });
  });

  app.get("/api/system/logs", (c) => {
    const source = c.req.query("source");
    const level = c.req.query("level");
    if (source !== undefined && !SOURCES.includes(source as LogSource)) return c.json({ error: "unknown source" }, 400);
    if (level !== undefined && !LEVELS.includes(level as LogLevel)) return c.json({ error: "unknown level" }, 400);
    const since = c.req.query("since") === undefined ? undefined : Number(c.req.query("since"));
    if (since !== undefined && !Number.isFinite(since)) return c.json({ error: "since must be a unix ms timestamp" }, 400);
    const limit = c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit"));
    return c.json(
      log.query({
        source: source as LogSource | undefined,
        level: level as LogLevel | undefined,
        since,
        limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
      }),
    );
  });

  app.post("/api/system/opencode/restart", async (c) => {
    await proc.restart();
    audit(db, { actor: c.get("actor"), action: "opencode_restart" });
    return c.json({ ok: true });
  });

  // The raw token is returned once, here; afterwards only metadata is readable.
  app.get("/api/tokens", (c) => c.json(listTokens(db)));

  app.post("/api/tokens", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; scopes?: unknown; ttlDays?: unknown } | null;
    if (!body || typeof body.name !== "string" || !Array.isArray(body.scopes)) {
      return c.json({ error: "name and scopes are required" }, 400);
    }
    try {
      const scopes = body.scopes as string[];
      const { id, token } = createToken(db, {
        name: body.name,
        scopes,
        ttlDays: typeof body.ttlDays === "number" ? body.ttlDays : undefined,
      });
      audit(db, { actor: c.get("actor"), action: "token_create", detail: { id, name: body.name.trim(), scopes } });
      return c.json({ id, token, name: body.name.trim(), scopes }, 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "invalid token" }, 400);
    }
  });

  app.delete("/api/tokens/:id", (c) => {
    const id = c.req.param("id");
    if (!revokeToken(db, id)) return c.json({ error: "not found" }, 404);
    audit(db, { actor: c.get("actor"), action: "token_revoke", detail: { id } });
    return c.json({ ok: true });
  });

  return app;
}
