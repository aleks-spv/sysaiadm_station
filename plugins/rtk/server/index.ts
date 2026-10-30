import { join } from "node:path";
import { Hono } from "hono";
import type { ExecOutputView, FilteredOutput, PluginContext, ServerPlugin } from "../../../apps/server/src/plugins/types";
import type { RtkDay, RtkMethod, RtkRun, RtkStats, RtkTotals } from "../web/types";
import { compact, pickRtkFilter } from "./compact";
import { createRtkInstaller, findBinary, type Binary } from "./install";

// Below this the model reads the output as is: nothing worth saving, and no note to pay for.
const MIN_BYTES = 1024;
const RTK_TIMEOUT_MS = 5000;
const KEEP_RUNS = 1000;

const MIGRATIONS = [
  `CREATE TABLE rtk_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    command TEXT NOT NULL,
    method TEXT NOT NULL,
    bytes_in INTEGER NOT NULL,
    bytes_out INTEGER NOT NULL
  );
  CREATE TABLE rtk_daily (
    day TEXT NOT NULL,
    method TEXT NOT NULL,
    commands INTEGER NOT NULL,
    compressed INTEGER NOT NULL,
    bytes_in INTEGER NOT NULL,
    bytes_out INTEGER NOT NULL,
    PRIMARY KEY (day, method)
  );`,
];

export type RunRtk = (filter: string, input: string) => Promise<string | null>;

const size = (s: string) => Buffer.byteLength(s);

function spawnRtk(path: string): RunRtk {
  return async (filter, input) => {
    const proc = Bun.spawn([path, "pipe", "--filter", filter], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "ignore",
      timeout: RTK_TIMEOUT_MS,
      // Telemetry and the recall store stay off: the model cannot reach a recall id, sysadm keeps the stats.
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", RTK_TELEMETRY_DISABLED: "1", RTK_RECALL: "0" },
    });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text : null;
  };
}

export function createRtk(binary: Binary | null, runRtk: RunRtk | null, now: () => number = Date.now) {
  let ready = false;
  // rtk is spawned per command, so switching to a freshly installed binary needs no restart.
  const use = (next: Binary | null) => {
    binary = next;
    runRtk = next ? spawnRtk(next.path) : null;
  };
  const ensure = (ctx: PluginContext) => {
    if (!ready) ctx.migrate(MIGRATIONS);
    ready = true;
  };

  const record = (ctx: PluginContext, out: ExecOutputView, method: string, bytesIn: number, bytesOut: number) => {
    const ts = now();
    const day = new Date(ts).toISOString().slice(0, 10);
    ctx.db
      .query("INSERT INTO rtk_runs (ts, node_id, task_id, command, method, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ts, out.nodeId, out.taskId, out.command.slice(0, 500), method, bytesIn, bytesOut);
    ctx.db
      .query(
        `INSERT INTO rtk_daily (day, method, commands, compressed, bytes_in, bytes_out) VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT (day, method) DO UPDATE SET commands = commands + 1, compressed = compressed + excluded.compressed,
           bytes_in = bytes_in + excluded.bytes_in, bytes_out = bytes_out + excluded.bytes_out`,
      )
      .run(day, method, bytesOut < bytesIn ? 1 : 0, bytesIn, bytesOut);
    ctx.db.query("DELETE FROM rtk_runs WHERE id <= (SELECT MAX(id) FROM rtk_runs) - ?").run(KEEP_RUNS);
  };

  const filterOutput = async (ctx: PluginContext, out: ExecOutputView): Promise<FilteredOutput | null> => {
    ensure(ctx);
    const bytesIn = size(out.stdout) + size(out.stderr);
    if (bytesIn < MIN_BYTES) return null;

    const filter = runRtk ? pickRtkFilter(out.command) : null;
    const viaRtk = filter && out.shell === "bash" && out.stdout ? await runRtk!(filter, out.stdout).catch(() => null) : null;
    const stdout = compact(viaRtk ?? out.stdout);
    const stderr = compact(out.stderr);
    const bytesOut = size(stdout) + size(stderr);
    const method = viaRtk !== null ? `rtk:${filter}` : "compact";
    if (bytesOut >= bytesIn) {
      record(ctx, out, method, bytesIn, bytesIn);
      return null;
    }
    record(ctx, out, method, bytesIn, bytesOut);
    const saved = Math.round((1 - bytesOut / bytesIn) * 100);
    return { stdout, stderr, note: `[вывод сжат на ${saved}% (${method}); полный вывод — тот же remote_exec с raw=true]` };
  };

  const totals = (ctx: PluginContext, where: string, ...args: string[]): RtkTotals => {
    const row = ctx.db
      .query<RtkTotals, string[]>(
        `SELECT COALESCE(SUM(commands), 0) AS commands, COALESCE(SUM(compressed), 0) AS compressed,
           COALESCE(SUM(bytes_in), 0) AS bytesIn, COALESCE(SUM(bytes_out), 0) AS bytesOut FROM rtk_daily ${where}`,
      )
      .get(...args);
    return row ?? { commands: 0, compressed: 0, bytesIn: 0, bytesOut: 0 };
  };

  const stats = (ctx: PluginContext): RtkStats => {
    ensure(ctx);
    const today = new Date(now()).toISOString().slice(0, 10);
    const since = new Date(now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const sums = "SUM(commands) AS commands, SUM(compressed) AS compressed, SUM(bytes_in) AS bytesIn, SUM(bytes_out) AS bytesOut";
    return {
      binary,
      total: totals(ctx, ""),
      today: totals(ctx, "WHERE day = ?", today),
      daily: ctx.db.query<RtkDay, [string]>(`SELECT day, ${sums} FROM rtk_daily WHERE day >= ? GROUP BY day ORDER BY day`).all(since),
      methods: ctx.db.query<RtkMethod, []>(`SELECT method, ${sums} FROM rtk_daily GROUP BY method ORDER BY SUM(bytes_in) - SUM(bytes_out) DESC`).all(),
      recent: ctx.db
        .query<RtkRun, []>(
          `SELECT id, ts, node_id AS nodeId, task_id AS taskId, command, method, bytes_in AS bytesIn, bytes_out AS bytesOut
           FROM rtk_runs ORDER BY id DESC LIMIT 50`,
        )
        .all(),
    };
  };

  const routes = (ctx: PluginContext) => {
    const app = new Hono();
    app.get("/stats", (c) => c.json(stats(ctx)));
    app.delete("/stats", (c) => {
      ensure(ctx);
      ctx.db.exec("DELETE FROM rtk_runs; DELETE FROM rtk_daily;");
      ctx.audit(c.get("actor"), "rtk_stats_reset");
      return c.json({ ok: true });
    });
    return app;
  };

  return { filterOutput, routes, stats, use, binary: () => binary };
}

const rtk = createRtk(null, null);

// Version routes: GET /version[?refresh=1] → RtkVersion, POST /upgrade → RtkVersion (installs the latest release).
function routes(ctx: PluginContext) {
  const app = rtk.routes(ctx);
  const managed = join(ctx.dataDir, "bin", "rtk");
  rtk.use(findBinary(managed));
  const installer = createRtkInstaller({
    dir: join(ctx.dataDir, "bin"),
    external: Boolean(process.env.RTK_BIN),
    current: rtk.binary,
    onInstalled: (path) => rtk.use(findBinary(path)),
  });
  app.get("/version", async (c) => c.json(await installer.info(c.req.query("refresh") === "1")));
  app.post("/upgrade", async (c) => {
    try {
      const info = await installer.upgrade();
      ctx.audit(c.get("actor"), "rtk_upgrade", { version: info.current });
      ctx.log("info", `rtk upgraded to ${info.current}`);
      return c.json(info);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.log("error", `rtk upgrade failed: ${message}`);
      return c.json({ error: message }, 502);
    }
  });
  return app;
}

export const rtkPlugin: ServerPlugin = {
  id: "rtk",
  name: "Экономия токенов (RTK)",
  description: "Сжимает вывод команд перед моделью: фильтры rtk (find, grep, git diff) и встроенное сжатие повторов, прогресс-баров и длинного вывода.",
  routes,
  filterOutput: rtk.filterOutput,
};
