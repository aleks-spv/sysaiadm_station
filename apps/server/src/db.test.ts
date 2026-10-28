import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION } from "./db";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sysadm-db-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const insertNode = (
  db: ReturnType<typeof openDb>,
  id: string,
  parent: string | null = null,
  jump: { mode: string; node: string | null } = { mode: "inherit", node: null },
) =>
  db.run(
    "INSERT INTO nodes (id, parent_id, kind, name, jump_mode, jump_node_id) VALUES (?, ?, 'vm', ?, ?, ?)",
    [id, parent, id, jump.mode, jump.node],
  );

describe("openDb", () => {
  test("opening the same file twice does not fail and keeps the version", () => {
    const path = join(dir, "a.sqlite");
    openDb(path).close();
    const db = openDb(path);
    const v = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    expect(v).toBe(SCHEMA_VERSION);
    db.close();
  });

  test("applies migrations and enables foreign keys", () => {
    const db = openDb(join(dir, "b.sqlite"));
    const fk = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!.foreign_keys;
    expect(fk).toBe(1);
    db.close();
  });

  test("deleting a node that has children fails", () => {
    const db = openDb(join(dir, "c.sqlite"));
    insertNode(db, "root");
    insertNode(db, "child", "root");
    expect(() => db.run("DELETE FROM nodes WHERE id = 'root'")).toThrow();
    db.close();
  });

  test("deleting a node used as jump host fails", () => {
    const db = openDb(join(dir, "d.sqlite"));
    insertNode(db, "bastion");
    insertNode(db, "vm", null, { mode: "via", node: "bastion" });
    expect(() => db.run("DELETE FROM nodes WHERE id = 'bastion'")).toThrow();
    db.close();
  });

  test("jump_mode 'via' without jump_node_id is rejected by CHECK", () => {
    const db = openDb(join(dir, "e.sqlite"));
    expect(() => insertNode(db, "vm", null, { mode: "via", node: null })).toThrow(/CHECK/);
    db.close();
  });

  test("duplicate (import_source, import_key) is rejected", () => {
    const db = openDb(join(dir, "f.sqlite"));
    const ins = (id: string) =>
      db.run(
        "INSERT INTO nodes (id, kind, name, import_source, import_key) VALUES (?, 'vm', ?, 'rdm', 'k1')",
        [id, id],
      );
    ins("n1");
    expect(() => ins("n2")).toThrow(/UNIQUE/);
    db.close();
  });
});
