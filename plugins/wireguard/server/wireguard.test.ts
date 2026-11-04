import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { openDb } from "../../../apps/server/src/db";
import { createPluginHost } from "../../../apps/server/src/plugins/host";
import { validateConf } from "./conf";
import { generateKeyPair } from "./keys";
import type { WgRunner } from "./runner";
import { health, parseDump } from "./status";

const iface = generateKeyPair();
const peer = generateKeyPair();
const CONF = `[Interface]
PrivateKey = ${iface.privateKey}
Address = 10.8.0.2/32

[Peer]
PublicKey = ${peer.publicKey}
Endpoint = vpn.example.com:51820
AllowedIPs = 10.8.0.0/24, 192.168.10.0/24
PersistentKeepalive = 25
`;

test("validateConf rejects hooks, DNS, a full tunnel and server setups", () => {
  expect(validateConf(CONF).errors).toEqual([]);
  const bad = CONF.replace("Address = 10.8.0.2/32", "Address = 10.8.0.2/32\nPostUp = rm -rf /\nDNS = 1.1.1.1").replace("10.8.0.0/24, 192.168.10.0/24", "0.0.0.0/0");
  const { errors } = validateConf(bad);
  expect(errors.some((e) => e.includes("PostUp"))).toBe(true);
  expect(errors.some((e) => e.includes("DNS"))).toBe(true);
  expect(errors.some((e) => e.includes("0.0.0.0/0"))).toBe(true);
  // Client only: a peer without Endpoint or an interface with ListenPort is a server setup.
  expect(validateConf(CONF.replace("Endpoint = vpn.example.com:51820\n", "")).errors.some((e) => e.includes("Endpoint"))).toBe(true);
  expect(validateConf(CONF.replace("[Peer]", "ListenPort = 51820\n\n[Peer]")).errors.some((e) => e.includes("ListenPort"))).toBe(true);
});

test("validateConf checks PresharedKey and the full-tunnel rule regardless of line order", () => {
  const psk = generateKeyPair().publicKey;
  const withPeerLine = (line: string) => CONF.replace("PersistentKeepalive = 25", line);
  expect(validateConf(withPeerLine(`PresharedKey = ${psk}`)).errors).toEqual([]);
  expect(validateConf(withPeerLine("PresharedKey = not-a-key")).errors.some((e) => e.includes("PresharedKey"))).toBe(true);

  // [Peer] first, then [Interface] with Table = off: the full tunnel is allowed.
  const peerFirst = `[Peer]
PublicKey = ${peer.publicKey}
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0

[Interface]
PrivateKey = ${iface.privateKey}
Address = 10.8.0.2/32
Table = off
`;
  expect(validateConf(peerFirst).errors).toEqual([]);
  // Without Table = off the full tunnel is still rejected, for IPv4 and IPv6.
  expect(validateConf(CONF.replace("10.8.0.0/24, 192.168.10.0/24", "::/0")).errors.some((e) => e.includes("::/0"))).toBe(true);
  expect(validateConf(peerFirst.replace("Table = off\n", "")).errors.some((e) => e.includes("0.0.0.0/0"))).toBe(true);
});

test("parseDump and health", () => {
  const dump = `wg-a\tpriv\tpub\t0\toff\nwg-a\t${peer.publicKey}\t(none)\t1.2.3.4:51820\t10.8.0.0/24\t1000\t10\t20\t25\nwg-b\tpriv\tpub\t0\toff\n`;
  const map = parseDump(dump);
  expect(map.get("wg-a")).toEqual([{ publicKey: peer.publicKey, endpoint: "1.2.3.4:51820", allowedIPs: ["10.8.0.0/24"], latestHandshake: 1000, rx: 10, tx: 20 }]);
  expect(health(map.get("wg-a"), 1100)).toBe("connected");
  expect(health(map.get("wg-a"), 2000)).toBe("stale");
  expect(health(map.get("wg-b"), 2000)).toBe("no-handshake");
  expect(health(undefined, 2000)).toBe("down");
});

test("tunnel lifecycle through the plugin host", async () => {
  const { createWireguardPlugin } = await import("./index");
  const dataDir = mkdtempSync(join(tmpdir(), "wg-"));
  const db: Database = openDb(":memory:");
  const live = new Set<string>();
  const calls: string[] = [];
  let seenConf = "";
  const runner: WgRunner = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "dump") return { ok: true, out: [...live].map((id) => `${id}\tp\tq\t0\toff`).join("\n"), err: "" };
    if (args[0] === "up") {
      seenConf = readFileSync(join(dataDir, "plugins", "wireguard", `${args[1]}.conf`), "utf8");
      live.add(args[1]);
    } else live.delete(args[1]);
    return { ok: true, out: "", err: "" };
  };
  const host = createPluginHost({
    db,
    masterKey: Buffer.alloc(32, 7),
    dataDir,
    log: { write() {} } as never,
    plugins: [createWireguardPlugin(runner)],
    background: false,
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("actor", "admin");
    await next();
  });
  app.route("/", host.app);
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`/api/plugins/wireguard${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

  expect((await call("POST", "/tunnels", { id: "eth0; rm", config: CONF })).status).toBe(400);
  const created = await call("POST", "/tunnels", { id: "wg-office", label: "Офис", config: CONF, autostart: true });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ id: "wg-office", warnings: [] });

  // The config is encrypted at rest.
  const raw = db.query<{ conf_ct: Uint8Array }, []>("SELECT conf_ct FROM wg_tunnels").get()!;
  expect(Buffer.from(raw.conf_ct).toString()).not.toContain(iface.privateKey);

  expect((await call("POST", "/tunnels/wg-office/up")).status).toBe(200);
  expect(seenConf).toBe(CONF);
  expect(existsSync(join(dataDir, "plugins", "wireguard", "wg-office.conf"))).toBe(false);

  const list = (await (await call("GET", "/tunnels")).json()) as { available: boolean; tunnels: Array<Record<string, unknown>> };
  expect(list.available).toBe(true);
  expect(list.tunnels[0]).toMatchObject({ id: "wg-office", label: "Офис", state: "up", desired: "up", health: "no-handshake", publicKey: iface.publicKey, address: ["10.8.0.2/32"] });

  expect((await call("POST", "/tunnels/wg-office/down")).status).toBe(200);
  expect(live.has("wg-office")).toBe(false);
  expect((await call("DELETE", "/tunnels/wg-office")).status).toBe(200);
  expect(calls).toContain("up wg-office");
  await host.stop();
});

test("an undecryptable tunnel shows its error and does not hide the others", async () => {
  const { createWireguardPlugin } = await import("./index");
  const db: Database = openDb(":memory:");
  const host = createPluginHost({
    db,
    masterKey: Buffer.alloc(32, 7),
    dataDir: mkdtempSync(join(tmpdir(), "wg-")),
    log: { write() {} } as never,
    plugins: [createWireguardPlugin(async () => ({ ok: true, out: "", err: "" }))],
    background: false,
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("actor", "admin");
    await next();
  });
  app.route("/", host.app);
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`/api/plugins/wireguard${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

  await call("POST", "/tunnels", { id: "wg-ok", config: CONF });
  await call("POST", "/tunnels", { id: "wg-bad", config: CONF });
  db.run("UPDATE wg_tunnels SET conf_tag = ? WHERE id = ?", [new Uint8Array(16), "wg-bad"]);

  const list = (await (await call("GET", "/tunnels")).json()) as { tunnels: Array<{ id: string; lastError: string | null; address: string[] }> };
  expect(list.tunnels.map((t) => t.id)).toEqual(["wg-bad", "wg-ok"]);
  expect(list.tunnels[0].lastError).toContain("не расшифровался");
  expect(list.tunnels[1]).toMatchObject({ lastError: null, address: ["10.8.0.2/32"] });

  const detail = await call("GET", "/tunnels/wg-bad");
  expect(detail.status).toBe(500);
  const detailBody = (await detail.json()) as { error: string };
  expect(detailBody.error).toContain("не расшифровался");
  expect((await call("GET", "/tunnels/wg-ok")).status).toBe(200);
  await host.stop();
});
