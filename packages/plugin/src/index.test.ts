import { describe, expect, test } from "bun:test";
import plugin, { ALLOW, requireEnv } from "./index";

describe("sysadm plugin", () => {
  test("model sees only the whitelisted tools", () => {
    expect([...ALLOW].sort()).toEqual(["compress", "question", "remote_exec", "skill", "todowrite", "web_search"]);
    expect(ALLOW.has("shell")).toBe(false);
    expect(ALLOW.has("webfetch")).toBe(false);
  });

  // Regression: tools left in Code Mode sit behind `execute`, which the context hook drops, so the model had no remote_exec.
  test("our tools are registered as direct tools, not Code Mode", async () => {
    process.env.SYSADM_INTERNAL_URL = "http://127.0.0.1:1";
    process.env.SYSADM_INTERNAL_TOKEN = "t";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ enabled: false })) as unknown as typeof fetch;
    const added: Array<{ name: string; options?: { codemode?: boolean } }> = [];
    const ctx = {
      tool: { transform: async (fn: (d: { add: (t: (typeof added)[number]) => void }) => void) => fn({ add: (t) => added.push(t) }) },
      session: { hook: async () => {} },
    };
    try {
      await plugin.setup(ctx as never);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(added.map((t) => [t.name, t.options?.codemode])).toEqual([["todowrite", false], ["web_search", false], ["remote_exec", false]]);
  });

  test("missing env fails at startup, value is returned otherwise", () => {
    expect(() => requireEnv({}, "SYSADM_INTERNAL_TOKEN")).toThrow("SYSADM_INTERNAL_TOKEN is not set");
    expect(requireEnv({ SYSADM_INTERNAL_TOKEN: "x" }, "SYSADM_INTERNAL_TOKEN")).toBe("x");
  });
});
