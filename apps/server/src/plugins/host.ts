import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { audit } from "../guard";
import { getNode, getTree } from "../inventory";
import type { Log } from "../log";
import { createTask, enableAutopilot, getTask, type TaskDeps } from "../routes/tasks";
import { openNodeShell, type NodeShell } from "../shell";
import { getSetting, setSetting } from "../settings";
import { open, seal } from "../vault";
import type { ExecOutputView, FilteredOutput, PluginContext, ServerPlugin } from "./types";

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface PluginHostOptions {
  db: Database;
  masterKey: Buffer;
  dataDir: string;
  log: Log;
  plugins: ServerPlugin[];
  background: boolean;
  // Without it (tests) ctx.tasks.create throws; the app always passes it.
  taskDeps?: TaskDeps;
  openShell?: (nodeId: string, cols: number, rows: number) => Promise<NodeShell>;
}

function makeContext(opts: PluginHostOptions, plugin: ServerPlugin): PluginContext {
  const { db } = opts;
  const dataDir = join(opts.dataDir, "plugins", plugin.id);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    id: plugin.id,
    db,
    encrypt: (plaintext, aad) => seal(opts.masterKey, plaintext, `plugin:${plugin.id}:${aad}`),
    decrypt: (sealed, aad) =>
      open(opts.masterKey, { ciphertext: Buffer.from(sealed.ciphertext), iv: Buffer.from(sealed.iv), tag: Buffer.from(sealed.tag) }, `plugin:${plugin.id}:${aad}`).toString(),
    dataDir,
    log: (level, message) => opts.log.write("app", level, `[plugin ${plugin.id}] ${message}`),
    audit: (actor, action, detail, ref) => audit(db, { actor, action, detail, nodeId: ref?.nodeId, taskId: ref?.taskId }),
    nodes: { get: (id) => getNode(db, id), list: () => getTree(db) },
    tasks: {
      create: async ({ autopilot, ...input }, actor) => {
        if (!opts.taskDeps) throw new Error("tasks are not available");
        if (autopilot) await enableAutopilot(opts.taskDeps, actor, input.nodeId);
        return createTask(opts.taskDeps, actor, input);
      },
      get: (id) => getTask(db, id),
    },
    ssh: { openShell: opts.openShell ?? ((nodeId, cols, rows) => openNodeShell(db, opts.masterKey, nodeId, cols, rows)) },
    upgradeWebSocket,
    migrate: (migrations) => {
      const key = `plugin_schema:${plugin.id}`;
      const current = getSetting<number>(db, key) ?? 0;
      for (let v = current; v < migrations.length; v++) {
        db.transaction(() => {
          db.exec(migrations[v]);
          setSetting(db, key, v + 1);
        })();
      }
    },
  };
}

// Mounts every plugin under /api/plugins/<id>; a disabled plugin answers 404 and has no background work.
export function createPluginHost(opts: PluginHostOptions) {
  const { db } = opts;
  const app = new Hono();
  const contexts = new Map<string, PluginContext>();
  const stops = new Map<string, () => void | Promise<void>>();
  const enabled = (id: string) => getSetting<boolean>(db, `plugin_enabled:${id}`) ?? true;

  const startPlugin = (plugin: ServerPlugin) => {
    if (!opts.background || !plugin.start || stops.has(plugin.id)) return;
    try {
      stops.set(plugin.id, plugin.start(contexts.get(plugin.id)!));
    } catch (err) {
      opts.log.write("app", "error", `[plugin ${plugin.id}] start failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const stopPlugin = async (id: string) => {
    const stop = stops.get(id);
    stops.delete(id);
    await stop?.();
  };

  const info = (p: ServerPlugin): PluginInfo => ({ id: p.id, name: p.name, description: p.description, enabled: enabled(p.id) });

  app.get("/api/plugins", (c) => c.json(opts.plugins.map(info)));

  app.put("/api/plugins/:id", async (c) => {
    const plugin = opts.plugins.find((p) => p.id === c.req.param("id"));
    if (!plugin) return c.json({ error: "плагин не найден" }, 404);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.enabled !== "boolean") return c.json({ error: "enabled должен быть true или false" }, 400);
    setSetting(db, `plugin_enabled:${plugin.id}`, body.enabled);
    if (body.enabled) startPlugin(plugin);
    else await stopPlugin(plugin.id);
    audit(db, { actor: c.get("actor"), action: body.enabled ? "plugin_enable" : "plugin_disable", detail: { id: plugin.id } });
    return c.json(info(plugin));
  });

  for (const plugin of opts.plugins) {
    const ctx = makeContext(opts, plugin);
    contexts.set(plugin.id, ctx);
    const base = `/api/plugins/${plugin.id}`;
    app.use(`${base}/*`, async (c, next) => {
      if (!enabled(plugin.id)) return c.json({ error: "плагин выключен" }, 404);
      await next();
    });
    app.route(base, plugin.routes(ctx));
    if (enabled(plugin.id)) startPlugin(plugin);
  }

  // Enabled filters run in PLUGINS order, each on the previous one's result; a failing filter is skipped, never loses output.
  const filterOutput = async (output: ExecOutputView): Promise<FilteredOutput> => {
    let current: FilteredOutput = { stdout: output.stdout, stderr: output.stderr };
    const notes: string[] = [];
    for (const plugin of opts.plugins) {
      if (!plugin.filterOutput || !enabled(plugin.id)) continue;
      try {
        const next = await plugin.filterOutput(contexts.get(plugin.id)!, { ...output, ...current });
        if (!next) continue;
        current = { stdout: next.stdout, stderr: next.stderr };
        if (next.note) notes.push(next.note);
      } catch (err) {
        opts.log.write("app", "warn", `[plugin ${plugin.id}] filterOutput failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return notes.length ? { ...current, note: notes.join("\n") } : current;
  };

  // Like filterOutput, but fails closed: a broken mask must not hand secrets to the model.
  // `shown` is what the model would read so far: the filtered (or raw) output with its note.
  const maskOutput = async (output: ExecOutputView, shown: FilteredOutput): Promise<FilteredOutput> => {
    let current = shown;
    for (const plugin of opts.plugins) {
      if (!plugin.maskOutput || !enabled(plugin.id)) continue;
      try {
        const next = await plugin.maskOutput(contexts.get(plugin.id)!, { ...output, ...current });
        if (!next) continue;
        const note = [current.note, next.note].filter(Boolean).join("\n");
        current = { stdout: next.stdout, stderr: next.stderr, ...(note && { note }) };
      } catch (err) {
        opts.log.write("app", "error", `[plugin ${plugin.id}] maskOutput failed: ${err instanceof Error ? err.message : String(err)}`);
        return { stdout: "", stderr: "", note: `[вывод скрыт: плагин ${plugin.id} не смог проверить его на секреты]` };
      }
    }
    return current;
  };

  return {
    app,
    filterOutput,
    maskOutput,
    stop: async () => {
      for (const id of [...stops.keys()]) await stopPlugin(id);
    },
  };
}
