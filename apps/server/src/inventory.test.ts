import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { openDb } from "./db";
import {
  createNode,
  deleteNode,
  dependentsOfJump,
  descendants,
  findByAddress,
  getNode,
  moveNode,
  resolveEffective,
  setNodeSkills,
  updateNode,
  type NodeInput,
} from "./inventory";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  for (const id of ["linux-common", "debian-ubuntu", "proxmox", "windows-server", "ops"]) {
    db.run("INSERT INTO skills (id, name, description, content, builtin) VALUES (?, ?, 'd', 'c', 1)", [id, id]);
  }
  db.run(
    "INSERT INTO credentials (id, name, type, ciphertext, iv, tag, created_at) VALUES ('cred-root', 'root', 'key', ?, ?, ?, 0)",
    [new Uint8Array(1), new Uint8Array(12), new Uint8Array(16)],
  );
});

const company = (name = "Acme") => createNode(db, { parentId: null, kind: "company", name });

const vm = (parentId: string, name: string, address: string, extra: Partial<NodeInput> = {}) =>
  createNode(db, { parentId, kind: "vm", name, address, os: "ubuntu", ...extra });

test("credential and user are taken from the nearest ancestor that sets them", () => {
  const root = company();
  updateNode(db, root.id, { credentialId: "cred-root" });
  const group = createNode(db, { parentId: root.id, kind: "group", name: "Prod", user: "ops" });
  const host = vm(group.id, "vm-01", "10.0.0.5");

  const eff = resolveEffective(db, host.id);
  expect(eff.credentialId).toBe("cred-root");
  expect(eff.credentialFrom).toBe(root.id);
  expect(eff.user).toBe("ops");
  expect(eff.port).toBe(22);
});

test("moving a node into its own subtree is rejected", () => {
  const root = company();
  const host = vm(root.id, "vm-01", "10.0.0.5");
  expect(() => moveNode(db, root.id, host.id)).toThrow("MOVE_CYCLE");
});

test("windows vm gets powershell and only the windows-server default skill", () => {
  const root = company();
  const win = vm(root.id, "win-01", "10.0.0.9", { os: "windows" });
  const eff = resolveEffective(db, win.id);
  expect(eff.shell).toBe("powershell");
  expect(eff.skillSources).toEqual({ "windows-server": "os" });
});

test("nearest skill with the same id wins over the ancestor's", () => {
  const root = company();
  setNodeSkills(db, root.id, ["ops"]);
  const host = vm(root.id, "vm-01", "10.0.0.5");
  setNodeSkills(db, host.id, ["ops"]);
  expect(resolveEffective(db, host.id).skillSources.ops).toBe(host.id);
});

test("company via bastion child: bastion goes direct, inheriting vm goes through it", () => {
  const root = company();
  const bastion = vm(root.id, "bastion", "bastion.example.test");
  const host = vm(root.id, "vm-01", "10.0.0.5");

  updateNode(db, root.id, { jumpMode: "via", jumpNodeId: bastion.id });
  expect(resolveEffective(db, bastion.id).jumpChain).toEqual([]);
  expect(resolveEffective(db, host.id).jumpChain).toEqual([bastion.id]);

  updateNode(db, host.id, { jumpMode: "direct" });
  expect(resolveEffective(db, host.id).jumpChain).toEqual([]);
});

test("a bastion with its own jump adds the previous hop first", () => {
  const root = company();
  const first = vm(root.id, "jump-a", "a.example.test", { jumpMode: "direct" });
  const bastion = vm(root.id, "bastion", "b.example.test");
  const host = vm(root.id, "vm-01", "10.0.0.5");

  updateNode(db, bastion.id, { jumpMode: "via", jumpNodeId: first.id });
  updateNode(db, root.id, { jumpMode: "via", jumpNodeId: bastion.id });
  expect(resolveEffective(db, host.id).jumpChain).toEqual([first.id, bastion.id]);
});

test("two bastions pointing at each other is JUMP_CYCLE and the write is rolled back", () => {
  const root = company();
  const a = vm(root.id, "a", "a.example.test", { jumpMode: "direct" });
  const b = vm(root.id, "b", "b.example.test", { jumpMode: "direct" });
  updateNode(db, b.id, { jumpMode: "via", jumpNodeId: a.id });

  expect(() => updateNode(db, a.id, { jumpMode: "via", jumpNodeId: b.id })).toThrow("JUMP_CYCLE");
  expect(getNode(db, a.id)?.jumpMode).toBe("direct");
});

test("a node jumping through itself is rejected, and a raw DB row like that is caught on resolve", () => {
  const root = company();
  const b = vm(root.id, "b", "b.example.test", { jumpMode: "direct" });
  expect(() => updateNode(db, b.id, { jumpMode: "via", jumpNodeId: b.id })).toThrow("JUMP_CYCLE");
  expect(getNode(db, b.id)?.jumpMode).toBe("direct");

  db.run("UPDATE nodes SET jump_mode = 'via', jump_node_id = id WHERE id = ?", [b.id]);
  expect(() => resolveEffective(db, b.id)).toThrow("JUMP_CYCLE");
});

test("more than three bastion hops is JUMP_TOO_DEEP", () => {
  const root = company();
  const hops = ["h1", "h2", "h3", "h4"].map((name) => vm(root.id, name, `${name}.example.test`, { jumpMode: "direct" }));
  updateNode(db, hops[0].id, { jumpMode: "via", jumpNodeId: hops[1].id });
  updateNode(db, hops[1].id, { jumpMode: "via", jumpNodeId: hops[2].id });
  updateNode(db, hops[2].id, { jumpMode: "via", jumpNodeId: hops[3].id });

  expect(() =>
    createNode(db, {
      parentId: root.id,
      kind: "vm",
      name: "target",
      address: "10.0.0.5",
      jumpMode: "via",
      jumpNodeId: hops[0].id,
    }),
  ).toThrow("JUMP_TOO_DEEP");
});

test("a bastion without an address is JUMP_NO_ADDRESS", () => {
  const root = company();
  const group = createNode(db, { parentId: root.id, kind: "group", name: "no-address" });
  expect(() => vm(root.id, "vm-01", "10.0.0.5", { jumpMode: "via", jumpNodeId: group.id })).toThrow("JUMP_NO_ADDRESS");
});

test("a vm without an address is refused", () => {
  const root = company();
  expect(() => createNode(db, { parentId: root.id, kind: "vm", name: "x" })).toThrow("VM_NO_ADDRESS");
});

test("deleting a parent with children or a bastion in use is refused", () => {
  const root = company();
  const bastion = vm(root.id, "bastion", "bastion.example.test");
  const host = vm(root.id, "vm-01", "10.0.0.5", { jumpMode: "via", jumpNodeId: bastion.id });

  expect(() => deleteNode(db, root.id)).toThrow("HAS_CHILDREN");
  expect(() => deleteNode(db, bastion.id)).toThrow("IS_JUMP_HOST");
  expect(dependentsOfJump(db, bastion.id)).toEqual([host.id]);
  expect(descendants(db, root.id).sort()).toEqual([bastion.id, host.id].sort());
});

test("findByAddress uses port 22 by default", () => {
  const root = company();
  const host = vm(root.id, "vm-01", "10.0.0.5");
  expect(findByAddress(db, "10.0.0.5")?.id).toBe(host.id);
  expect(findByAddress(db, "10.0.0.5", 2222)).toBeNull();
});
