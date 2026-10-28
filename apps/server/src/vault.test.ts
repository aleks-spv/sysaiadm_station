import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { loadMasterKey, open, seal } from "./vault";

const key = randomBytes(32);

describe("vault", () => {
  test("roundtrip", () => {
    const s = seal(key, "secret-pass", "rec-1");
    expect(open(key, s, "rec-1").toString()).toBe("secret-pass");
  });

  test("flipping one ciphertext byte throws", () => {
    const s = seal(key, "secret-pass", "rec-1");
    s.ciphertext[0] ^= 1;
    expect(() => open(key, s, "rec-1")).toThrow();
  });

  test("different aad throws", () => {
    const s = seal(key, "secret-pass", "rec-1");
    expect(() => open(key, s, "rec-2")).toThrow();
  });

  test("each seal uses a fresh iv", () => {
    const a = seal(key, "same", "rec-1");
    const b = seal(key, "same", "rec-1");
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  test("master key must be 32 bytes", () => {
    const short = randomBytes(31).toString("base64");
    expect(() => loadMasterKey({ SYSADM_MASTER_KEY: short })).toThrow(/32 bytes/);
    expect(() => loadMasterKey({})).toThrow(/not set/);
    expect(loadMasterKey({ SYSADM_MASTER_KEY: randomBytes(32).toString("base64") }).length).toBe(32);
  });
});
