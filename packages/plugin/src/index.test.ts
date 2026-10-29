import { describe, expect, test } from "bun:test";
import { ALLOW, requireEnv } from "./index";

describe("sysadm plugin", () => {
  test("model sees only the whitelisted tools", () => {
    expect([...ALLOW].sort()).toEqual(["glob", "grep", "question", "read", "remote_exec", "skill"]);
    expect(ALLOW.has("shell")).toBe(false);
    expect(ALLOW.has("webfetch")).toBe(false);
  });

  test("missing env fails at startup, value is returned otherwise", () => {
    expect(() => requireEnv({}, "SYSADM_INTERNAL_TOKEN")).toThrow("SYSADM_INTERNAL_TOKEN is not set");
    expect(requireEnv({ SYSADM_INTERNAL_TOKEN: "x" }, "SYSADM_INTERNAL_TOKEN")).toBe("x");
  });
});
