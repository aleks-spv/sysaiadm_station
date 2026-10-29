import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { createAuth, authRoutes, requireAuth } from "./auth";
import { openDb } from "./db";
import { createInternalApp } from "./routes/internal";
import { inventoryRoutes } from "./routes/inventory";
import { credentialsRoutes } from "./routes/credentials";
import { startAutopilotExpiry, tasksRoutes } from "./routes/tasks";
import { createBus, eventsRoutes, startEventBridge } from "./routes/events";
import { materializeAll } from "./materialize";
import { makeClient, type OpenCodeClient } from "./opencode";
import { loadMasterKey } from "./vault";

const MAX_BODY = 1024 * 1024;
const MAX_IMPORT_BODY = 5 * 1024 * 1024;
const MIN_TOKEN_LENGTH = 32;

export interface Config {
  masterKey: Buffer;
  internalToken: string;
  opencodeUrl: string;
  opencodePassword: string;
  infraDir: string;
  dbPath: string;
  skillsDir: string;
  webDist: string;
}

export class ConfigError extends Error {}

// Fails fast with every problem listed at once, so a bad .env is fixed in one pass.
export function readConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const need = (name: string): string => {
    const value = env[name];
    if (!value) problems.push(`${name} is required`);
    return value ?? "";
  };
  const internalToken = need("SYSADM_INTERNAL_TOKEN");
  if (internalToken && internalToken.length < MIN_TOKEN_LENGTH) problems.push(`SYSADM_INTERNAL_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  const opencodeUrl = need("OPENCODE_URL");
  const opencodePassword = need("OPENCODE_SERVER_PASSWORD");
  const infraDir = need("INFRA_DIR");
  const dbPath = need("DB_PATH");
  let masterKey: Buffer | undefined;
  try {
    masterKey = loadMasterKey(env);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : "SYSADM_MASTER_KEY is invalid");
  }
  if (problems.length > 0 || masterKey === undefined) throw new ConfigError(problems.join("\n"));
  return {
    masterKey,
    internalToken,
    opencodeUrl,
    opencodePassword,
    infraDir,
    dbPath,
    skillsDir: env.SKILLS_DIR ?? "/app/skills",
    webDist: env.WEB_DIST ?? "apps/web/dist",
  };
}

// Built-in skills ship with the image; a user skill with the same id is never overwritten.
export function syncBuiltinSkills(db: Database, skillsDir: string): number {
  if (!existsSync(skillsDir)) return 0;
  let count = 0;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? entry.name;
    const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "";
    db.run(
      `INSERT INTO skills (id, name, description, content, builtin) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, content = excluded.content
       WHERE skills.builtin = 1`,
      [entry.name, name, description, content],
    );
    count++;
  }
  return count;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export interface BuiltApp {
  publicApp: Hono;
  internalApp: Hono;
  stop: () => void;
}

export async function buildApp(config: Config, options: { background: boolean }): Promise<BuiltApp> {
  const db = openDb(config.dbPath);
  const auth = createAuth({ db, masterKey: config.masterKey });
  const client: OpenCodeClient = makeClient({ baseUrl: config.opencodeUrl, password: config.opencodePassword });
  const bus = createBus();
  syncBuiltinSkills(db, config.skillsDir);
  await materializeAll(db, config.infraDir);
  const taskDeps = { db, client, infraDir: config.infraDir };

  const stops: Array<() => void> = [];
  if (options.background) {
    stops.push(startAutopilotExpiry(taskDeps));
    stops.push(startEventBridge({ db, client, bus }));
  }

  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
    await next();
  });
  const limitDefault = bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "payload too large" }, 413) });
  const limitImport = bodyLimit({ maxSize: MAX_IMPORT_BODY, onError: (c) => c.json({ error: "payload too large" }, 413) });
  app.use("*", (c, next) => (c.req.path === "/api/import/preview" ? limitImport(c, next) : limitDefault(c, next)));

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/api/auth", authRoutes(auth));

  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/health") return next();
    return requireAuth(auth)(c, next);
  });
  app.route("/", inventoryRoutes({ ...taskDeps, bus }));
  app.route("/", credentialsRoutes(db, config.masterKey));
  app.route("/", tasksRoutes(taskDeps));
  app.route("/", eventsRoutes(bus));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  app.get("*", serveStatic({ root: config.webDist }), serveStatic({ root: config.webDist, path: "index.html" }));

  const internalApp = createInternalApp({ db, token: config.internalToken, masterKey: config.masterKey });

  return {
    publicApp: app,
    internalApp,
    stop: () => {
      for (const stop of stops) stop();
      db.close();
    },
  };
}

if (import.meta.main) {
  let config: Config;
  try {
    config = readConfig(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "invalid configuration");
    process.exit(1);
  }
  const built = await buildApp(config, { background: true });
  Bun.serve({ port: 8080, fetch: built.publicApp.fetch });
  // Internal API: reachable only inside the compose network, never published by compose.
  Bun.serve({ port: 3001, fetch: built.internalApp.fetch });
  console.log("sysadm listening on :8080 (public) and :3001 (internal)");
}
