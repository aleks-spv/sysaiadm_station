import { describe, expect, test } from "bun:test";
import plugin, { ALLOW, requireEnv } from "./index";

describe("sysadm plugin", () => {
  test("model may call only the whitelisted tools", () => {
    expect([...ALLOW].sort()).toEqual(["compress", "question", "remote_exec", "skill", "todowrite", "web_search"]);
    expect(ALLOW.has("shell")).toBe(false);
    expect(ALLOW.has("webfetch")).toBe(false);
  });

  // Regression: tools left in Code Mode sit behind `execute`, which the plugin refuses, so the model had no remote_exec.
  test("our tools are registered as direct tools, not Code Mode", async () => {
    process.env.SYSADM_INTERNAL_URL = "http://127.0.0.1:1";
    process.env.SYSADM_INTERNAL_TOKEN = "t";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ enabled: false })) as unknown as typeof fetch;
    const added: Array<{ name: string; options?: { codemode?: boolean } }> = [];
    const ctx = {
      tool: { hook: async () => {}, transform: async (fn: (d: { add: (t: (typeof added)[number]) => void }) => void) => fn({ add: (t) => added.push(t) }) },
      session: { hook: async () => {} },
    };
    try {
      await plugin.setup(ctx as never);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(added.map((t) => [t.name, t.options?.codemode])).toEqual([["todowrite", false], ["web_search", false], ["remote_exec", false]]);
  });

  // Regression: deleting built-in tools from the request made Zen refuse free models; they stay listed as stubs, calls are refused.
  test("built-in tools stay in the request as stubs, calls outside the whitelist are refused", async () => {
    process.env.SYSADM_INTERNAL_URL = "http://127.0.0.1:1";
    process.env.SYSADM_INTERNAL_TOKEN = "t";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ enabled: false })) as unknown as typeof fetch;
    const hooks: Record<string, (e: never) => void> = {};
    const ctx = {
      tool: { hook: async (name: string, fn: (e: never) => void) => void (hooks[`tool.${name}`] = fn), transform: async () => {} },
      session: { hook: async (name: string, fn: (e: never) => void) => void (hooks[`session.${name}`] = fn) },
    };
    try {
      await plugin.setup(ctx as never);
    } finally {
      globalThis.fetch = realFetch;
    }
    const remote = { description: "run a command", input: { type: "object", properties: { command: { type: "string" } } } };
    const tools: Record<string, unknown> = { shell: { description: "long text", input: { type: "object", properties: { command: { type: "string" } } } }, remote_exec: remote };
    hooks["session.context"]!({ sessionID: "s", tools, messages: [], system: [] } as never);
    expect(Object.keys(tools)).toEqual(["shell", "remote_exec"]);
    expect(tools.shell).toEqual({ description: "Not available in SysAiAdm Station. Never call this tool.", input: { type: "object", properties: {} } });
    expect(tools.remote_exec).toBe(remote);
    const call = (tool: string) => () => hooks["tool.execute.before"]!({ tool } as never);
    expect(call("shell")).toThrow('Tool "shell" is not available');
    expect(call("execute")).toThrow();
    expect(call("web_search")).toThrow();
    expect(call("remote_exec")).not.toThrow();
  });

  test("missing env fails at startup, value is returned otherwise", () => {
    expect(() => requireEnv({}, "SYSADM_INTERNAL_TOKEN")).toThrow("SYSADM_INTERNAL_TOKEN is not set");
    expect(requireEnv({ SYSADM_INTERNAL_TOKEN: "x" }, "SYSADM_INTERNAL_TOKEN")).toBe("x");
  });
});
