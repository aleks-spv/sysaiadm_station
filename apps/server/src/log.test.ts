import { afterEach, beforeEach, expect, test } from "bun:test";
import { createLog } from "./log";

const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;

beforeEach(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
});

test("buffer drops the oldest entries past capacity", () => {
  const log = createLog({ capacity: 3, secrets: [] });
  for (let i = 0; i < 5; i++) log.write("app", "info", `m${i}`);
  expect(log.query().map((e) => e.msg)).toEqual(["m2", "m3", "m4"]);
});

test("filters by source, level and since", () => {
  const log = createLog({ secrets: [] });
  log.write("app", "info", "a");
  log.write("opencode", "error", "b");
  const since = Date.now() + 1;
  expect(log.query({ source: "opencode" }).map((e) => e.msg)).toEqual(["b"]);
  expect(log.query({ level: "info" }).map((e) => e.msg)).toEqual(["a"]);
  expect(log.query({ since })).toEqual([]);
});

test("limit above 1000 is capped", () => {
  const log = createLog({ capacity: 5000, secrets: [] });
  for (let i = 0; i < 1100; i++) log.write("app", "info", `m${i}`);
  expect(log.query({ limit: 5000 })).toHaveLength(1000);
  expect(log.query({ limit: 5000 })[999].msg).toBe("m1099");
});

test("redacts configured secrets, sat tokens and private key blocks", () => {
  const log = createLog({ secrets: ["master-key-value"] });
  log.write("app", "info", "key=master-key-value");
  log.write("app", "info", "token sat_abcdefghijklmnopqrstuvwxyz0123 here");
  log.write("opencode", "error", "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----");
  const msgs = log.query().map((e) => e.msg);
  expect(msgs).toEqual(["key=[redacted]", "token [redacted] here", "[redacted]"]);
});

test("every write is mirrored to console with its level", () => {
  const seen: string[] = [];
  console.log = (line: string) => seen.push(`log:${line}`);
  console.warn = (line: string) => seen.push(`warn:${line}`);
  const log = createLog({ secrets: [] });
  log.write("app", "info", "hello");
  log.write("app", "warn", "careful");
  expect(seen).toEqual(["log:[app] hello", "warn:[app] careful"]);
});
