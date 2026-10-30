import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDb } from "../db";
import { createLog } from "../log";
import { createPluginHost } from "./host";
import type { ServerPlugin } from "./types";

function fakePlugin(events: string[]): ServerPlugin {
  return {
    id: "demo",
    name: "Demo",
    description: "test",
    routes: (ctx) => {
      ctx.migrate(["CREATE TABLE demo_items (id TEXT)"]);
      return new Hono().get("/ping", (c) => c.json({ ok: true }));
    },
    start: () => {
      events.push("start");
      return () => void events.push("stop");
    },
  };
}

test("plugin routes, migrations once, enable toggle starts and stops background work", async () => {
  const db = openDb(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "plugin-host-"));
  const events: string[] = [];
  const opts = { db, masterKey: randomBytes(32), dataDir, log: createLog({ secrets: [] }), background: true };
  const host = createPluginHost({ ...opts, plugins: [fakePlugin(events)] });
  // A second host on the same DB must not rerun the migration (it would fail: table exists).
  createPluginHost({ ...opts, background: false, plugins: [fakePlugin([])] });
  expect(events).toEqual(["start"]);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("actor", "admin");
    await next();
  });
  app.route("/", host.app);
  expect((await app.request("/api/plugins/demo/ping")).status).toBe(200);
  expect(await (await app.request("/api/plugins")).json()).toEqual([{ id: "demo", name: "Demo", description: "test", enabled: true }]);

  const off = await app.request("/api/plugins/demo", { method: "PUT", body: JSON.stringify({ enabled: false }) });
  expect(off.status).toBe(200);
  expect(events).toEqual(["start", "stop"]);
  expect((await app.request("/api/plugins/demo/ping")).status).toBe(404);

  await app.request("/api/plugins/demo", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  expect(events).toEqual(["start", "stop", "start"]);
  await host.stop();
  expect(events.at(-1)).toBe("stop");
});

test("a failing secret mask withholds the output instead of passing it on", async () => {
  const db = openDb(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "plugin-host-"));
  const broken: ServerPlugin = {
    id: "mask",
    name: "Mask",
    description: "test",
    routes: () => new Hono(),
    maskOutput: async () => {
      throw new Error("boom");
    },
  };
  const host = createPluginHost({ db, masterKey: randomBytes(32), dataDir, log: createLog({ secrets: [] }), background: false, plugins: [broken] });
  const view = { nodeId: "n", taskId: "t", command: "cat .env", shell: "bash" as const, exitCode: 0, stdout: "TOKEN=x", stderr: "" };
  const shown = await host.maskOutput(view, { stdout: "TOKEN=x", stderr: "" });
  expect(shown.stdout).toBe("");
  expect(shown.note).toContain("mask");
});
