import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION } from "./db";
import { createToken, listTokens, revokeToken, verifyToken } from "./tokens";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokens-"));
  db = openDb(join(dir, "db.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("create then verify returns the scopes", () => {
  const { token } = createToken(db, { name: "mobile", scopes: ["read", "tasks"] }, 1_000);
  expect(token.startsWith("sat_")).toBe(true);
  const v = verifyToken(db, token, 2_000);
  expect(v?.name).toBe("mobile");
  expect(v?.scopes).toEqual(["read", "tasks"]);
});

test("raw token is not stored, only its hash", () => {
  const { token } = createToken(db, { name: "a", scopes: ["read"] });
  const rows = JSON.stringify(db.query("SELECT * FROM api_tokens").all());
  expect(rows.includes(token)).toBe(false);
});

test("revoked token verifies to null", () => {
  const { id, token } = createToken(db, { name: "a", scopes: ["read"] }, 1_000);
  expect(revokeToken(db, id, 1_500)).toBe(true);
  expect(verifyToken(db, token, 2_000)).toBeNull();
  expect(listTokens(db)[0].revokedAt).toBe(1_500);
});

test("expired token verifies to null", () => {
  const { token } = createToken(db, { name: "a", scopes: ["read"], ttlDays: 1 }, 0);
  expect(verifyToken(db, token, 86_400_000 - 1)).not.toBeNull();
  expect(verifyToken(db, token, 86_400_000)).toBeNull();
});

test("unknown scope throws", () => {
  expect(() => createToken(db, { name: "a", scopes: ["root"] })).toThrow("unknown scope");
  expect(() => createToken(db, { name: "a", scopes: [] })).toThrow("at least one scope");
});

test("ttl above 365 days throws", () => {
  expect(() => createToken(db, { name: "a", scopes: ["read"], ttlDays: 400 })).toThrow("ttlDays");
});

test("last_used_at is written at most once a minute", () => {
  const { id, token } = createToken(db, { name: "a", scopes: ["read"] }, 0);
  verifyToken(db, token, 100_000);
  verifyToken(db, token, 110_000);
  const first = listTokens(db).find((t) => t.id === id)!.lastUsedAt;
  expect(first).toBe(100_000);
  verifyToken(db, token, 170_000);
  expect(listTokens(db).find((t) => t.id === id)!.lastUsedAt).toBe(170_000);
});

test("database at user_version 1 migrates to the latest and gets api_tokens", () => {
  db.close();
  const path = join(dir, "db.sqlite");
  db = openDb(path);
  db.exec("DROP TABLE node_facts; DROP TABLE api_tokens; ALTER TABLE skills DROP COLUMN source; ALTER TABLE tasks DROP COLUMN archived_at; ALTER TABLE credentials DROP COLUMN user; PRAGMA user_version = 1;");
  db.close();
  db = openDb(path);
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(SCHEMA_VERSION);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'api_tokens'").get()).not.toBeNull();
});
