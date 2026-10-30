import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { buildOpencodeConfig, DEFAULT_OVERLAY, getOverlay, saveOverlay, validateOverlay, writeOpencodeConfig } from "./opencode-config";

const base = { $schema: "x", permissions: [{ action: "remote_exec", resource: "*", effect: "ask" }], policies: [{ action: "tool.use", resource: "shell:*", effect: "deny" }] };

test("written config keeps the sysadm plugin first and the base security keys", () => {
  const cfg = buildOpencodeConfig(base, "/app/plugin", { plugins: ["extra-plugin"], default_agent: "debugger" });
  expect(cfg.plugins).toEqual([{ package: "/app/plugin" }, "extra-plugin"]);
  expect(cfg.policies).toEqual(base.policies);
  expect(cfg.permissions).toEqual(base.permissions);
  expect(cfg.default_agent).toBe("debugger");
  const infra = join(mkdtempSync(join(tmpdir(), "oc-cfg-")), "infra");
  writeOpencodeConfig(infra, cfg);
  expect(JSON.parse(readFileSync(join(infra, "opencode.json"), "utf8")).plugins[0]).toEqual({ package: "/app/plugin" });
  expect(existsSync(join(infra, "opencode.json.tmp"))).toBe(false);
});

test("overlay cannot touch permissions, policies or agent permissions", () => {
  expect(validateOverlay(DEFAULT_OVERLAY)).toEqual([]);
  expect(validateOverlay([])).toHaveLength(1);
  expect(validateOverlay({ policies: [] })).toHaveLength(1);
  expect(validateOverlay({ permissions: [] })).toHaveLength(1);
  expect(validateOverlay({ agents: { x: { permissions: [] } } })).toHaveLength(1);
  expect(validateOverlay({ plugins: [1] })).toHaveLength(1);
});

test("the default overlay is seeded once, then the stored one wins", () => {
  const db = openDb(":memory:");
  expect(getOverlay(db)).toEqual(DEFAULT_OVERLAY);
  saveOverlay(db, { default_agent: "debugger" });
  expect(getOverlay(db)).toEqual({ default_agent: "debugger" });
});
