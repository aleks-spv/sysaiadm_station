import { expect, test } from "bun:test";
import { openDb } from "../db";
import { trackExec } from "../exec-registry";
import { classify } from "../guard";
import type { OpenCodeClient } from "../opencode";
import { getOverlay, saveOverlay, type Overlay } from "../opencode-config";
import { REDACTED, selfAdminRoutes } from "./selfadmin";

const TOKEN = "t".repeat(64);

function setup() {
  const db = openDb(":memory:");
  saveOverlay(db, { providers: { gw: { settings: { baseURL: "https://x", apiKey: "sk-secret" } } }, plugins: [] });
  const applied: Overlay[] = [];
  const restarts: number[] = [];
  const client = {
    integration: { list: async () => ({ data: [{ id: "opencode", name: "OpenCode Zen", connections: [{ key: "sk-zen" }] }, { id: "opencode-go", name: "OpenCode Go", connections: [] }] }) },
  } as unknown as OpenCodeClient;
  const app = selfAdminRoutes({ db, token: TOKEN, client, apply: (o) => applied.push(o), proc: { status: () => "running" as never, restart: async () => void restarts.push(1) } });
  const call = (method: string, path: string, body?: unknown, token = TOKEN) =>
    app.request(`/selfadmin/${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { db, applied, call };
}

test("needs its own token", async () => {
  expect((await setup().call("GET", "config", undefined, "wrong")).status).toBe(401);
});

test("reads never show secrets", async () => {
  const { call } = setup();
  const config = JSON.stringify(await (await call("GET", "config")).json());
  expect(config).not.toContain("sk-secret");
  expect(config).toContain(REDACTED);
  expect(await (await call("GET", "providers")).json()).toEqual([
    { id: "opencode", name: "OpenCode Zen", connected: true },
    { id: "opencode-go", name: "OpenCode Go", connected: false },
  ]);
});

test("changes need an approved sysadm-oc command in flight; redacted values keep the stored secret", async () => {
  const { db, applied, call } = setup();
  const next = { providers: { gw: { settings: { baseURL: "https://y", apiKey: REDACTED } } }, plugins: [] };
  expect((await call("PUT", "config", next)).status).toBe(403);

  const exec = trackExec("task-1", `sysadm-oc set-config '${JSON.stringify(next)}'`);
  expect((await call("PUT", "config", next)).status).toBe(200);
  expect(getOverlay(db)).toEqual({ providers: { gw: { settings: { baseURL: "https://y", apiKey: "sk-secret" } } }, plugins: [] });
  expect(applied).toHaveLength(1);
  // Locked keys stay locked for the agent too.
  expect((await call("PUT", "config", { permissions: [] })).status).toBe(400);
  exec.done();
  expect((await call("PUT", "config", next)).status).toBe(403);
});

test("plugin-add: only registry packages, and only the one the admin approved", async () => {
  const { db, call } = setup();
  const exec = trackExec("task-2", "sysadm-oc plugin-add opencode-foo@1.2.3");
  expect((await call("POST", "plugins", { package: "https://evil/x.tgz" })).status).toBe(400);
  expect((await call("POST", "plugins", { package: "opencode-bar" })).status).toBe(403);
  expect((await call("POST", "plugins", { package: "opencode-foo" })).status).toBe(403);
  expect((await call("POST", "plugins", { package: "opencode-foo@1.2.3" })).status).toBe(200);
  expect(getOverlay(db).plugins).toEqual(["opencode-foo@1.2.3"]);
  exec.done();
});

test("guard: sysadm-oc reads run freely, changes always ask", () => {
  expect(classify("sysadm-oc models")).toBe("read");
  expect(classify("sysadm-oc config")).toBe("read");
  for (const cmd of ["sysadm-oc upgrade", "sysadm-oc restart", "sysadm-oc plugin-add x", `sysadm-oc set-config '{}'`]) {
    expect(classify(cmd)).toBe("dangerous");
  }
});
