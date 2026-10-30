import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import type { PluginContext, ServerPlugin } from "../../../apps/server/src/plugins/types";
import { validateConf } from "./conf";
import { generateKeyPair, publicKeyOf } from "./keys";
import { commandRunner, type WgRunner } from "./runner";
import { health, parseDump, type PeerStatus } from "./status";

// Linux interface name; the tunnel id is the interface name.
const ID = /^[a-zA-Z0-9_=+.-]{1,15}$/;
const WATCHDOG_MS = 60_000;

const MIGRATIONS = [
  `CREATE TABLE wg_tunnels (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    conf_ct BLOB NOT NULL,
    conf_iv BLOB NOT NULL,
    conf_tag BLOB NOT NULL,
    autostart INTEGER NOT NULL DEFAULT 0,
    desired TEXT NOT NULL DEFAULT 'down' CHECK (desired IN ('up', 'down')),
    last_error TEXT,
    updated_at INTEGER NOT NULL
  )`,
];

interface Row {
  id: string;
  label: string;
  conf_ct: Uint8Array;
  conf_iv: Uint8Array;
  conf_tag: Uint8Array;
  autostart: number;
  desired: "up" | "down";
  last_error: string | null;
}

type Body = Record<string, unknown>;

async function readBody(c: Context): Promise<Body | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Body) : null;
}

// Warnings do not block saving: they point at setups that usually misbehave.
function warnings(conf: string): string[] {
  const out: string[] = [];
  if (!/^\s*PersistentKeepalive\s*=/m.test(conf)) out.push("нет PersistentKeepalive: за NAT туннель засыпает без трафика, обычно ставят 25");
  return out;
}

export function createWireguardPlugin(runner: WgRunner = commandRunner(), now: () => number = Date.now): ServerPlugin {
  // One operation per tunnel at a time, so the watchdog never races a click.
  const busy = new Set<string>();

  const load = (ctx: PluginContext, id: string) => ctx.db.query<Row, [string]>("SELECT * FROM wg_tunnels WHERE id = ?").get(id);
  const confOf = (ctx: PluginContext, row: Row) => ctx.decrypt({ ciphertext: row.conf_ct, iv: row.conf_iv, tag: row.conf_tag }, row.id);
  const setError = (ctx: PluginContext, id: string, error: string | null) =>
    ctx.db.run("UPDATE wg_tunnels SET last_error = ? WHERE id = ?", [error, id]);

  const dump = async () => {
    const r = await runner(["dump"]);
    return r.ok ? { ifaces: parseDump(r.out), error: null } : { ifaces: new Map<string, PeerStatus[]>(), error: r.err };
  };

  // The wrapper reads <dataDir>/<id>.conf and copies it to a root-owned place; the file here lives only for the call.
  const up = async (ctx: PluginContext, row: Row): Promise<string | null> => {
    const path = join(ctx.dataDir, `${row.id}.conf`);
    try {
      writeFileSync(path, confOf(ctx, row), { mode: 0o600 });
      chmodSync(path, 0o600);
      const r = await runner(["up", row.id]);
      return r.ok ? null : r.err;
    } finally {
      rmSync(path, { force: true });
    }
  };

  const apply = async (ctx: PluginContext, id: string, action: "up" | "down" | "restart"): Promise<string | null> => {
    if (busy.has(id)) return "туннель занят другой операцией, повторите";
    busy.add(id);
    try {
      const row = load(ctx, id);
      if (!row) return "not found";
      let error: string | null = null;
      if (action !== "up") {
        const r = await runner(["down", id]);
        if (!r.ok) error = r.err;
      }
      if (action !== "down" && !error) {
        // "up" on a live interface fails in wg-quick, so bring it down first.
        if (action === "up" && (await dump()).ifaces.has(id)) await runner(["down", id]);
        error = await up(ctx, row);
      }
      setError(ctx, id, error);
      return error;
    } finally {
      busy.delete(id);
    }
  };

  const view = (ctx: PluginContext, row: Row, ifaces: Map<string, PeerStatus[]>) => {
    const conf = confOf(ctx, row);
    const parsed = validateConf(conf);
    const live = ifaces.get(row.id);
    const privateKey = /^\s*PrivateKey\s*=\s*(\S+)/m.exec(conf)?.[1];
    let publicKey = "";
    try {
      if (privateKey) publicKey = publicKeyOf(privateKey);
    } catch {}
    return {
      id: row.id,
      label: row.label,
      autostart: row.autostart === 1,
      desired: row.desired,
      lastError: row.last_error,
      state: live ? ("up" as const) : ("down" as const),
      health: health(live, Math.floor(now() / 1000)),
      publicKey,
      address: parsed.address,
      // Configured peers merged with live counters.
      peers: parsed.peers.map((p) => {
        const s = live?.find((l) => l.publicKey === p.publicKey);
        return {
          publicKey: p.publicKey,
          endpoint: s?.endpoint ?? p.endpoint ?? null,
          allowedIPs: p.allowedIPs ?? [],
          latestHandshake: s?.latestHandshake ?? 0,
          rx: s?.rx ?? 0,
          tx: s?.tx ?? 0,
        };
      }),
    };
  };

  const store = (ctx: PluginContext, id: string, conf: string) => {
    const sealed = ctx.encrypt(conf, id);
    return [sealed.ciphertext, sealed.iv, sealed.tag] as const;
  };

  return {
    id: "wireguard",
    name: "WireGuard",
    description: "Клиент WireGuard: туннели из контейнера SysAiAdm Station к VPN-серверам площадок. Подключение, статус, автозапуск.",

    routes(ctx) {
      ctx.migrate(MIGRATIONS);
      const app = new Hono();
      const all = () => ctx.db.query<Row, []>("SELECT * FROM wg_tunnels ORDER BY id").all();

      app.get("/tunnels", async (c) => {
        const { ifaces, error } = await dump();
        return c.json({ available: error === null, ...(error ? { error } : {}), tunnels: all().map((row) => view(ctx, row, ifaces)) });
      });

      app.get("/tunnels/:id", async (c) => {
        const row = load(ctx, c.req.param("id"));
        if (!row) return c.json({ error: "туннель не найден" }, 404);
        return c.json({ ...view(ctx, row, (await dump()).ifaces), config: confOf(ctx, row) });
      });

      app.post("/tunnels", async (c) => {
        const body = await readBody(c);
        const id = body?.id;
        if (typeof id !== "string" || !ID.test(id)) return c.json({ error: "имя: 1–15 символов, латиница, цифры, _=+.-" }, 400);
        if (typeof body?.config !== "string") return c.json({ error: "нужен config" }, 400);
        const { errors } = validateConf(body.config);
        if (errors.length) return c.json({ error: errors.join("; ") }, 400);
        if (load(ctx, id)) return c.json({ error: "туннель с таким именем уже есть" }, 409);
        const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : id;
        ctx.db.run(
          "INSERT INTO wg_tunnels (id, label, conf_ct, conf_iv, conf_tag, autostart, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [id, label, ...store(ctx, id, body.config), body.autostart === true ? 1 : 0, now()],
        );
        ctx.audit(c.get("actor"), "wg_create", { id });
        return c.json({ id, warnings: warnings(body.config) }, 201);
      });

      app.put("/tunnels/:id", async (c) => {
        const id = c.req.param("id");
        const row = load(ctx, id);
        if (!row) return c.json({ error: "туннель не найден" }, 404);
        const body = await readBody(c);
        if (!body) return c.json({ error: "нужен JSON" }, 400);
        let warn: string[] = [];
        if (typeof body.config === "string") {
          const { errors } = validateConf(body.config);
          if (errors.length) return c.json({ error: errors.join("; ") }, 400);
          ctx.db.run("UPDATE wg_tunnels SET conf_ct = ?, conf_iv = ?, conf_tag = ? WHERE id = ?", [...store(ctx, id, body.config), id]);
          warn = warnings(body.config);
        }
        if (typeof body.label === "string" && body.label.trim()) ctx.db.run("UPDATE wg_tunnels SET label = ? WHERE id = ?", [body.label.trim(), id]);
        if (typeof body.autostart === "boolean") ctx.db.run("UPDATE wg_tunnels SET autostart = ? WHERE id = ?", [body.autostart ? 1 : 0, id]);
        ctx.db.run("UPDATE wg_tunnels SET updated_at = ? WHERE id = ?", [now(), id]);
        ctx.audit(c.get("actor"), "wg_update", { id, config: typeof body.config === "string" });
        // A running tunnel picks up the new config right away.
        if (typeof body.config === "string" && (await dump()).ifaces.has(id)) {
          const error = await apply(ctx, id, "restart");
          if (error) warn.push(`перезапуск не удался: ${error}`);
        }
        return c.json({ id, warnings: warn });
      });

      app.delete("/tunnels/:id", async (c) => {
        const id = c.req.param("id");
        if (!load(ctx, id)) return c.json({ error: "туннель не найден" }, 404);
        if ((await dump()).ifaces.has(id)) {
          const r = await runner(["down", id]);
          if (!r.ok) return c.json({ error: `не удалось остановить: ${r.err}` }, 502);
        }
        ctx.db.run("DELETE FROM wg_tunnels WHERE id = ?", [id]);
        ctx.audit(c.get("actor"), "wg_delete", { id });
        return c.json({ ok: true });
      });

      for (const action of ["up", "down", "restart"] as const) {
        app.post(`/tunnels/:id/${action}`, async (c) => {
          const id = c.req.param("id");
          if (!load(ctx, id)) return c.json({ error: "туннель не найден" }, 404);
          ctx.db.run("UPDATE wg_tunnels SET desired = ? WHERE id = ?", [action === "down" ? "down" : "up", id]);
          const error = await apply(ctx, id, action);
          ctx.audit(c.get("actor"), `wg_${action}`, { id, error });
          return error ? c.json({ error }, 502) : c.json({ ok: true });
        });
      }

      app.post("/keygen", (c) => c.json(generateKeyPair()));
      return app;
    },

    // On start, autostart tunnels are wanted up; the watchdog then keeps every wanted tunnel up.
    start(ctx) {
      ctx.db.run("UPDATE wg_tunnels SET desired = 'up' WHERE autostart = 1");
      const tick = async () => {
        const { ifaces, error } = await dump();
        if (error) return;
        const wanted = ctx.db.query<{ id: string }, []>("SELECT id FROM wg_tunnels WHERE desired = 'up'").all();
        for (const { id } of wanted) {
          if (ifaces.has(id) || busy.has(id)) continue;
          const err = await apply(ctx, id, "up");
          ctx.log(err ? "warn" : "info", err ? `туннель ${id} не поднялся: ${err}` : `туннель ${id} поднят`);
        }
      };
      void tick();
      const timer = setInterval(() => void tick(), WATCHDOG_MS);
      return () => clearInterval(timer);
    },
  };
}

export const wireguardPlugin = createWireguardPlugin();
