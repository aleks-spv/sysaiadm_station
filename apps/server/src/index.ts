import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { websocket } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { createAuth, authRoutes, isHttps, requireAuth } from "./auth";
import { openDb } from "./db";
import { commandsRoutes } from "./routes/commands";
import { factsRoutes } from "./routes/facts";
import { createInternalApp } from "./routes/internal";
import { inventoryRoutes } from "./routes/inventory";
import { credentialsRoutes } from "./routes/credentials";
import { backupRoutes, startBackups } from "./backup";
import { createWebSearcher, webSearchRoutes } from "./websearch";
import { exportRoutes } from "./routes/export";
import { importRoutes } from "./routes/import";
import { startArchivePurge, startAutopilotExpiry, tasksRoutes } from "./routes/tasks";
import { createBus, eventsRoutes, startEventBridge } from "./routes/events";
import { systemRoutes } from "./routes/system";
import { materializeAll } from "./materialize";
import { makeClient, type OpenCodeClient } from "./opencode";
import { createOpencodeInstaller, type OpencodeInstaller } from "./opencode-install";
import { frontmatter } from "./skills-github";
import { startOpencode, type OpencodeProc } from "./opencode-proc";
import { buildOpencodeConfig, DISABLED_PROVIDERS_KEY, getOverlay, writeDcpConfig, writeOpencodeConfig, type Overlay } from "./opencode-config";
import { opencodeSettingsRoutes } from "./routes/opencode-settings";
import { getSetting } from "./settings";
import { createPluginHost } from "./plugins/host";
import { PLUGINS } from "./plugins";
import { createLog, parseLevel, type Log, type LogLevel } from "./log";
import { loadMasterKey } from "./vault";
import { seedLocalhost } from "./localhost";
import { selfAdminRoutes } from "./routes/selfadmin";

const MAX_BODY = 1024 * 1024;
const MAX_IMPORT_BODY = 5 * 1024 * 1024;
const VERSION = "0.1.0";

export interface Config {
  masterKey: Buffer;
  infraDir: string;
  dbPath: string;
  // Plugin files live under <dataDir>/plugins/<id>.
  dataDir: string;
  skillsDir: string;
  webDist: string;
  publicPort: number;
  internalPort: number;
  // Set only for a self-managed binary (dev); otherwise opencode is installed into <opencodeHome>/bin.
  opencodeBin?: string;
  opencodePort: number;
  opencodeHome: string;
  pluginPath: string;
  devMode: boolean;
  // Raises the GitHub API limit for skill installs; optional.
  githubToken?: string;
  // Private key for the container's own sshd (set in the image); seeds the localhost node.
  localSshKey?: string;
}

// Secrets generated on every start; they never reach the .env file.
export interface Runtime {
  internalToken: string;
  opencodePassword: string;
  log: Log;
  proc: Pick<OpencodeProc, "status" | "restart">;
  installer?: OpencodeInstaller;
  // Token of `sysadm-oc` (the localhost node's agent); written to <dataDir>/selfadmin.json, readable by uid 1000 only.
  selfAdminToken?: string;
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
  // Typos must fail here: an unrecognised value silently running as prod would hide the intent.
  if (env.SYSADM_ENV && env.SYSADM_ENV !== "dev" && env.SYSADM_ENV !== "prod") {
    problems.push(`SYSADM_ENV must be "dev" or "prod"`);
  }
  if (problems.length > 0 || masterKey === undefined) throw new ConfigError(problems.join("\n"));
  return {
    masterKey,
    infraDir,
    dbPath,
    dataDir: env.DATA_DIR ?? dirname(dbPath),
    githubToken: env.GITHUB_TOKEN || undefined,
    localSshKey: env.LOCAL_SSH_KEY || undefined,
    skillsDir: env.SKILLS_DIR ?? "/app/skills",
    webDist: env.WEB_DIST ?? "apps/web/dist",
    publicPort,
    internalPort,
    opencodeBin: env.OPENCODE_BIN || undefined,
    opencodePort,
    opencodeHome: env.OPENCODE_HOME ?? "/data/opencode",
    pluginPath: env.PLUGIN_PATH ?? "/app/packages/plugin",
    devMode: env.SYSADM_ENV === "dev",
  };
}

// Built-in skills ship with the image; a user skill with the same id is never overwritten.
export function syncBuiltinSkills(db: Database, skillsDir: string): number {
  if (!existsSync(skillsDir)) return 0;
  let count = 0;
  const shipped: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    shipped.push(entry.name);
    const content = readFileSync(file, "utf8");
    const meta = frontmatter(content);
    const name = meta.name || entry.name;
    const description = meta.description;
    db.run(
      `INSERT INTO skills (id, name, description, content, builtin) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, content = excluded.content
       WHERE skills.builtin = 1`,
      [entry.name, name, description, content],
    );
    count++;
  }
  // A built-in dropped from the image goes away too; one the admin edited (builtin = 0) stays.
  const stale = `SELECT id FROM skills WHERE builtin = 1 AND id NOT IN (${shipped.map(() => "?").join(",") || "''"})`;
  db.transaction(() => {
    db.run(`DELETE FROM node_skills WHERE skill_id IN (${stale})`, shipped);
    db.run(`DELETE FROM skills WHERE id IN (${stale})`, shipped);
  })();
  return count;
}

const SECURITY_HEADERS: Record<string, string> = {
  // xterm.js injects <style> elements for ANSI colors and the selection; scripts stay 'self' only.
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export interface BuiltApp {
  publicApp: Hono;
  internalApp: Hono;
  db: Database;
  stop: () => Promise<void>;
}

export async function buildApp(config: Config, options: { background: boolean; runtime: Runtime }): Promise<BuiltApp> {
  const { runtime } = options;
  const db = openDb(config.dbPath);
  const auth = createAuth({ db, masterKey: config.masterKey, dev: config.devMode });
  const client: OpenCodeClient = makeClient({
    baseUrl: `http://127.0.0.1:${config.opencodePort}`,
    password: runtime.opencodePassword,
  });
  const bus = createBus();
  syncBuiltinSkills(db, config.skillsDir);
  seedLocalhost(db, config.masterKey, config.localSshKey);
  const base = JSON.parse(readFileSync(new URL("../opencode.base.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const applyOverlay = (overlay: Overlay) =>
    writeOpencodeConfig(config.infraDir, buildOpencodeConfig(base, config.pluginPath, overlay, getSetting<string[]>(db, DISABLED_PROVIDERS_KEY) ?? []));
  applyOverlay(getOverlay(db));
  await materializeAll(db, config.infraDir);
  const taskDeps = { db, client, infraDir: config.infraDir };
  const webSearch = createWebSearcher({ db, client, directory: config.infraDir });

  const stops: Array<() => void | Promise<void>> = [];
  const plugins = createPluginHost({ db, masterKey: config.masterKey, dataDir: config.dataDir, log: runtime.log, plugins: PLUGINS, background: options.background, taskDeps });
  stops.push(plugins.stop);
  if (options.background) {
    stops.push(startAutopilotExpiry(taskDeps));
    stops.push(startArchivePurge(taskDeps));
    stops.push(startEventBridge({ db, client, bus }));
    stops.push(startBackups(db, join(config.dataDir, "backups"), (level, line) => runtime.log.write("app", level, line)));
  }

  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
    await next();
  });
  // Health and the SSE stream poll constantly; logging them would bury everything else.
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const path = c.req.path;
    if (path === "/api/health" || path === "/api/events") return;
    const status = c.res.status;
    const isLogin = c.req.method === "POST" && path === "/api/auth/login";
    const level: LogLevel = status >= 500 ? "error" : isLogin ? "info" : status >= 400 ? "warn" : "debug";
    runtime.log.write("app", level, `${c.req.method} ${path} ${status} ${Date.now() - start}ms actor=${c.get("actor") ?? "-"}`);
    if (isLogin && status === 200 && !isHttps(c)) {
      runtime.log.write("app", "warn", "login over HTTP: session cookie is sent without Secure, use HTTPS");
    }
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    runtime.log.write("app", "error", `unhandled ${c.req.method} ${c.req.path}: ${err.message}\n${err.stack ?? ""}`);
    return c.json({ error: "internal error" }, 500);
  });
  const limitDefault = bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "payload too large" }, 413) });
  const limitImport = bodyLimit({ maxSize: MAX_IMPORT_BODY, onError: (c) => c.json({ error: "payload too large" }, 413) });
  app.use("*", (c, next) => (c.req.path === "/api/import/preview" || c.req.path === "/api/inventory/import" ? limitImport(c, next) : limitDefault(c, next)));

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
  app.route("/", inventoryRoutes({ ...taskDeps, bus, githubToken: config.githubToken, skillsDir: config.skillsDir }));
  app.route("/", credentialsRoutes(db, config.masterKey));
  app.route("/", commandsRoutes(db));
  app.route("/", factsRoutes({ db, masterKey: config.masterKey, infraDir: config.infraDir, bus }));
  app.route("/", importRoutes({ db, infraDir: config.infraDir }));
  app.route("/", webSearchRoutes(db, webSearch));
  app.route("/", backupRoutes(db, join(config.dataDir, "backups")));
  app.route("/", exportRoutes({ db, masterKey: config.masterKey, infraDir: config.infraDir }));
  app.route("/", tasksRoutes(taskDeps));
  app.route("/", eventsRoutes(bus));
  app.route("/", opencodeSettingsRoutes({ db, client, apply: applyOverlay }));
  app.route("/", plugins.app);
  app.route("/", systemRoutes({ db, log: runtime.log, proc: runtime.proc, installer: runtime.installer, startedAt: Date.now(), version: VERSION }));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  app.get("*", serveStatic({ root: config.webDist }), serveStatic({ root: config.webDist, path: "index.html" }));

  const internalApp = createInternalApp({ db, token: runtime.internalToken, masterKey: config.masterKey, filterOutput: plugins.filterOutput, maskOutput: plugins.maskOutput, webSearch });
  if (runtime.selfAdminToken) {
    internalApp.route("/", selfAdminRoutes({ db, token: runtime.selfAdminToken, client, apply: applyOverlay, proc: runtime.proc, installer: runtime.installer }));
  }

  return {
    publicApp: app,
    internalApp,
    db,
    stop: async () => {
      for (const stop of stops) await stop();
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
  // Only the image has the localhost node; sysadm-oc (run as uid 1000 via sudo) reads the token file, the agent's user cannot.
  const selfAdminToken = config.localSshKey ? randomBytes(32).toString("hex") : undefined;
  const level = parseLevel(process.env.LOG_LEVEL);
  const log = createLog({ secrets: [process.env.SYSADM_MASTER_KEY ?? "", internalToken, opencodePassword, selfAdminToken ?? ""], minLevel: level ?? "info" });
  if (level === null) log.write("app", "warn", `LOG_LEVEL=${process.env.LOG_LEVEL} is not recognised (debug, info, warn, error); using info`);

  // buildApp writes opencode.json, so the child starts after it; status/restart reach the child through this holder.
  let proc: OpencodeProc | undefined;
  const procRef = { status: () => proc!.status(), restart: () => proc!.restart() };
  const installer = createOpencodeInstaller({
    home: config.opencodeHome,
    external: config.opencodeBin,
    log: (level, line) => log.write("app", level, line),
  });
  if (selfAdminToken) {
    writeFileSync(join(config.dataDir, "selfadmin.json"), JSON.stringify({ port: config.internalPort, token: selfAdminToken }), { mode: 0o600 });
  }
  const built = await buildApp(config, { background: true, runtime: { internalToken, opencodePassword, log, proc: procRef, installer, selfAdminToken } });
  // First start on an empty volume downloads opencode; on failure the child backs off until the admin installs it.
  await installer.ensure();
  writeDcpConfig(config.opencodeHome);
  proc = startOpencode({
    bin: installer.bin,
    port: config.opencodePort,
    home: config.opencodeHome,
    infraDir: config.infraDir,
    internalUrl: `http://127.0.0.1:${config.internalPort}`,
    internalToken,
    password: opencodePassword,
    onLine: (source, line, level) => log.write(source, level, line),
  });

  // websocket: plugin routes upgraded with ctx.upgradeWebSocket (terminal).
  const publicServer = Bun.serve({ port: config.publicPort, fetch: built.publicApp.fetch, websocket });
  // Internal API: loopback only. The opencode plugin reaches it from the child process.
  const internalServer = Bun.serve({ hostname: "127.0.0.1", port: config.internalPort, fetch: built.internalApp.fetch });
  log.write("app", "info", `SysAiAdm Station listening on :${config.publicPort} (public) and 127.0.0.1:${config.internalPort} (internal)`);
  // Error level on purpose: it passes any LOG_LEVEL threshold, so the warning cannot be silenced.
  if (config.devMode) log.write("app", "error", "SYSADM_ENV=dev: TOTP code check is disabled, password is the only factor");
  log.write("app", "info", `log level: ${level ?? "info"}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    publicServer.stop();
    internalServer.stop();
    await proc?.stop();
    await built.stop();
    process.exitCode = 0;
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}
