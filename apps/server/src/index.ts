import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
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
import { importRoutes } from "./routes/import";
import { startAutopilotExpiry, tasksRoutes } from "./routes/tasks";
import { createBus, eventsRoutes, startEventBridge } from "./routes/events";
import { systemRoutes } from "./routes/system";
import { materializeAll } from "./materialize";
import { makeClient, type OpenCodeClient } from "./opencode";
import { startOpencode, writeOpencodeConfig, type OpencodeProc } from "./opencode-proc";
import { createLog, type Log } from "./log";
import { loadMasterKey } from "./vault";

const MAX_BODY = 1024 * 1024;
const MAX_IMPORT_BODY = 5 * 1024 * 1024;
const VERSION = "0.1.0";

export interface Config {
  masterKey: Buffer;
  infraDir: string;
  dbPath: string;
  skillsDir: string;
  webDist: string;
  publicPort: number;
  internalPort: number;
  opencodeBin: string;
  opencodePort: number;
  opencodeHome: string;
  pluginPath: string;
}

// Secrets generated on every start; they never reach the .env file.
export interface Runtime {
  internalToken: string;
  opencodePassword: string;
  log: Log;
  proc: Pick<OpencodeProc, "status" | "restart">;
}

export class ConfigError extends Error {}

function port(env: Record<string, string | undefined>, name: string, fallback: number, problems: string[]): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) problems.push(`${name} must be a port number`);
  return value;
}

// Fails fast with every problem listed at once, so a bad .env is fixed in one pass.
export function readConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const need = (name: string): string => {
    const value = env[name];
    if (!value) problems.push(`${name} is required`);
    return value ?? "";
  };
  const infraDir = need("INFRA_DIR");
  const dbPath = need("DB_PATH");
  const publicPort = port(env, "PUBLIC_PORT", 8080, problems);
  const internalPort = port(env, "INTERNAL_PORT", 3001, problems);
  const opencodePort = port(env, "OPENCODE_PORT", 4096, problems);
  let masterKey: Buffer | undefined;
  try {
    masterKey = loadMasterKey(env);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : "SYSADM_MASTER_KEY is invalid");
  }
  if (problems.length > 0 || masterKey === undefined) throw new ConfigError(problems.join("\n"));
  return {
    masterKey,
    infraDir,
    dbPath,
    skillsDir: env.SKILLS_DIR ?? "/app/skills",
    webDist: env.WEB_DIST ?? "apps/web/dist",
    publicPort,
    internalPort,
    opencodeBin: env.OPENCODE_BIN ?? "opencode",
    opencodePort,
    opencodeHome: env.OPENCODE_HOME ?? "/data/opencode",
    pluginPath: env.PLUGIN_PATH ?? "/app/packages/plugin",
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
  db: Database;
  stop: () => void;
}

export async function buildApp(config: Config, options: { background: boolean; runtime: Runtime }): Promise<BuiltApp> {
  const { runtime } = options;
  const db = openDb(config.dbPath);
  const auth = createAuth({ db, masterKey: config.masterKey });
  const client: OpenCodeClient = makeClient({
    baseUrl: `http://127.0.0.1:${config.opencodePort}`,
    password: runtime.opencodePassword,
  });
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

  app.get("/api/health", (c) => {
    try {
      db.query("SELECT 1").get();
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });
  app.route("/api/auth", authRoutes(auth));

  const guard = requireAuth(auth, db);
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/health") return next();
    return guard(c, next);
  });
  app.route("/", inventoryRoutes({ ...taskDeps, bus }));
  app.route("/", credentialsRoutes(db, config.masterKey));
  app.route("/", importRoutes({ db, infraDir: config.infraDir }));
  app.route("/", tasksRoutes(taskDeps));
  app.route("/", eventsRoutes(bus));
  app.route("/", systemRoutes({ db, log: runtime.log, proc: runtime.proc, startedAt: Date.now(), version: VERSION }));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  app.get("*", serveStatic({ root: config.webDist }), serveStatic({ root: config.webDist, path: "index.html" }));

  const internalApp = createInternalApp({ db, token: runtime.internalToken, masterKey: config.masterKey });

  return {
    publicApp: app,
    internalApp,
    db,
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
  const internalToken = randomBytes(32).toString("hex");
  const opencodePassword = randomBytes(32).toString("hex");
  const log = createLog({ secrets: [process.env.SYSADM_MASTER_KEY ?? "", internalToken, opencodePassword] });

  const base = JSON.parse(readFileSync(new URL("../opencode.base.json", import.meta.url), "utf8")) as Record<string, unknown>;
  writeOpencodeConfig(config.infraDir, config.pluginPath, base);
  const proc = startOpencode({
    bin: config.opencodeBin,
    port: config.opencodePort,
    home: config.opencodeHome,
    infraDir: config.infraDir,
    internalUrl: `http://127.0.0.1:${config.internalPort}`,
    internalToken,
    password: opencodePassword,
    onLine: (source, line) => log.write(source, "info", line),
  });

  const built = await buildApp(config, { background: true, runtime: { internalToken, opencodePassword, log, proc } });
  const publicServer = Bun.serve({ port: config.publicPort, fetch: built.publicApp.fetch });
  // Internal API: loopback only. The opencode plugin reaches it from the child process.
  const internalServer = Bun.serve({ hostname: "127.0.0.1", port: config.internalPort, fetch: built.internalApp.fetch });
  log.write("app", "info", `sysadm listening on :${config.publicPort} (public) and 127.0.0.1:${config.internalPort} (internal)`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    publicServer.stop();
    internalServer.stop();
    await proc.stop();
    built.stop();
    process.exitCode = 0;
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}
