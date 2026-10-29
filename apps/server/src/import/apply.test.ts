import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { ImportTree } from "@sysadm/shared";
import { openDb } from "../db";
import { createNode, getNode } from "../inventory";
import { applyImport, previewImport } from "./apply";

let db: Database;
let root: string;

beforeEach(() => {
  db = openDb(":memory:");
  root = createNode(db, { parentId: null, kind: "company", name: "Acme" }).id;
});

const tree = (over: Partial<ImportTree> = {}): ImportTree => ({
  source: "ansible",
  groups: [
    { key: "g-prod", name: "prod", parentKey: null },
    { key: "g-web", name: "web", parentKey: "g-prod", user: "deploy" },
  ],
  hosts: [
    { key: "h1", name: "web1", address: "10.0.0.1", os: "other", parentKey: "g-web" },
    { key: "h2", name: "web2", address: "10.0.0.2", os: "other", parentKey: "g-web" },
    { key: "h3", name: "db1", address: "10.0.0.3", os: "other", parentKey: "g-prod" },
  ],
  warnings: [],
  ...over,
});

const count = () => (db.query("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n;

describe("applyImport", () => {
  test("creates groups and hosts under the target with correct parents", () => {
    const res = applyImport(db, tree(), root, { skipKeys: [] });
    expect(res.created).toBe(5);
    expect(res.skipped).toBe(0);
    const web = db.query<{ id: string }, []>("SELECT id FROM nodes WHERE name = 'web'").get()!;
    expect(getNode(db, web.id)?.parentId).toBe(db.query<{ id: string }, []>("SELECT id FROM nodes WHERE name = 'prod'").get()!.id);
    expect(getNode(db, web.id)?.user).toBe("deploy");
    expect(getNode(db, db.query<{ id: string }, []>("SELECT id FROM nodes WHERE name = 'web1'").get()!.id)?.parentId).toBe(web.id);
    expect(res.createdIds).toEqual([db.query<{ id: string }, []>("SELECT id FROM nodes WHERE name = 'prod'").get()!.id]);
  });

  test("repeat apply of the same tree creates nothing and skips the 3 hosts", () => {
    applyImport(db, tree(), root, { skipKeys: [] });
    const before = count();
    const res = applyImport(db, tree(), root, { skipKeys: [] });
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(3);
    expect(count()).toBe(before);
  });

  test("jumpRef key becomes via jump on the created node", () => {
    const t = tree({
      hosts: [
        { key: "bastion", name: "bastion", address: "10.0.1.1", os: "other", parentKey: null },
        { key: "vm", name: "vm", address: "10.0.1.2", os: "other", parentKey: null, jumpRef: { key: "bastion" } },
      ],
      groups: [],
    });
    applyImport(db, t, root, { skipKeys: [] });
    const vm = db.query<{ id: string; b: string }, []>(
      "SELECT n.id AS id, b.id AS b FROM nodes n JOIN nodes b ON b.name = 'bastion' WHERE n.name = 'vm' AND n.jump_node_id = b.id",
    ).get();
    expect(vm).not.toBeNull();
    expect(getNode(db, vm!.id)?.jumpMode).toBe("via");
  });

  test("unmatched jumpRef raw adds a warning and keeps inherit", () => {
    const t = tree({
      groups: [],
      hosts: [
        { key: "vm", name: "vm", address: "10.0.2.2", os: "other", parentKey: null, jumpRef: { raw: "ops@10.9.9.9:2222" } },
      ],
    });
    const res = applyImport(db, t, root, { skipKeys: [] });
    expect(res.warnings).toEqual(["vm: jump ops@10.9.9.9:2222 not found"]);
    const vm = db.query<{ id: string }, []>("SELECT id FROM nodes WHERE name = 'vm'").get()!;
    expect(getNode(db, vm.id)?.jumpMode).toBe("inherit");
  });

  test("error on a host rolls back the whole import", () => {
    const t = tree({
      hosts: [
        { key: "h1", name: "ok", address: "10.0.3.1", os: "other", parentKey: null },
        { key: "bad", name: "bad", address: "10.0.3.2", os: "other", parentKey: null, jumpRef: { key: "bad" } },
      ],
    });
    const before = count();
    expect(() => applyImport(db, t, root, { skipKeys: [] })).toThrow("JUMP_CYCLE");
    expect(count()).toBe(before);
  });

  test("unchecked group skips all its descendants", () => {
    const res = applyImport(db, tree(), root, { skipKeys: ["g-web"] });
    expect(res.created).toBe(2);
    expect(res.skipped).toBe(2);
    const names = db.query<{ name: string }, []>("SELECT name FROM nodes ORDER BY name").all().map((r) => r.name);
    expect(names).not.toContain("web1");
    expect(names).toContain("db1");
  });
});

describe("previewImport", () => {
  test("marks already imported items as exists", () => {
    applyImport(db, tree(), root, { skipKeys: [] });
    const preview = previewImport(db, tree());
    expect(preview.items.every((i) => i.action === "skip" && i.reason === "exists")).toBe(true);
  });

  test("marks hosts with an existing address as exists", () => {
    createNode(db, { parentId: root, kind: "vm", name: "manual", os: "other", address: "10.0.0.3", port: 22 });
    const preview = previewImport(db, tree());
    const db1 = preview.items.find((i) => i.key === "h3");
    expect(db1?.action).toBe("skip");
    expect(db1?.reason).toBe("exists");
  });
});
