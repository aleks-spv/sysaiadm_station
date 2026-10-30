import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { buildOpencodeConfig, DCP_PLUGIN, DEFAULT_OVERLAY, getOverlay, PROMPT_UPGRADES, saveOverlay, validateOverlay, writeOpencodeConfig } from "./opencode-config";

const base = { $schema: "x", permissions: [{ action: "remote_exec", resource: "*", effect: "ask" }], policies: [{ action: "tool.use", resource: "shell:*", effect: "deny" }] };

test("written config keeps the sysadm plugin first and the base security keys", () => {
  const cfg = buildOpencodeConfig(base, "/app/plugin", { plugins: ["extra-plugin", "@tarquinen/opencode-dcp"], default_agent: "debugger" });
  // DCP is always bundled once, at the pinned version.
  expect(cfg.plugins).toEqual([{ package: "/app/plugin" }, DCP_PLUGIN, "extra-plugin"]);
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

test("a stored agent with an old shipped prompt is upgraded, an edited one is kept", () => {
  const db = openDb(":memory:");
  const [[, oldSysadmin, newSysadmin]] = PROMPT_UPGRADES as [[string, string, string]];
  saveOverlay(db, { agents: { sysadmin: { mode: "primary", system: oldSysadmin }, debugger: { mode: "primary", system: "мой промпт" } } });
  const overlay = getOverlay(db) as { agents: Record<string, { system: string }> };
  expect(overlay.agents.sysadmin!.system).toBe(newSysadmin);
  expect(overlay.agents.debugger!.system).toBe("мой промпт");
  expect(newSysadmin).toContain("skill");
  db.close();
});

test("every shipped prompt version upgrades to the current one", () => {
  for (const [, from, to] of PROMPT_UPGRADES) {
    expect(from).not.toBe(to);
    expect(to).toContain("выполняются сразу, без подтверждения");
  }
});
