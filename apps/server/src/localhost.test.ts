import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { createNode, deleteNode, getTree, LOCALHOST_NODE, moveNode, resolveEffective } from "./inventory";
import { LOCAL_SSH_USER, seedLocalhost } from "./localhost";
import { getSetting } from "./settings";
import { materializeAll, nodeDir } from "./materialize";
import { open } from "./vault";

const KEY = Buffer.alloc(32, 7);

test("seeds SysAiAdm with localhost once, with the key sealed in the vault", () => {
  const db = openDb(":memory:");
  const file = join(mkdtempSync(join(tmpdir(), "sysadm-local-")), "id");
  expect(seedLocalhost(db, KEY, file)).toBe(false);
  writeFileSync(file, "PRIVATE KEY");
  expect(seedLocalhost(db, KEY, file)).toBe(true);

  const tree = getTree(db);
  const host = tree.find((n) => n.name === "localhost")!;
  expect(tree.find((n) => n.id === host.parentId)?.name).toBe("SysAiAdm");
  const eff = resolveEffective(db, host.id);
  expect([eff.address, eff.port, eff.user]).toEqual(["127.0.0.1", 22, LOCAL_SSH_USER]);
  const row = db.query<{ ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }, [string]>("SELECT ciphertext, iv, tag FROM credentials WHERE id = ?").get(eff.credentialId!)!;
  const plain = open(KEY, { ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), tag: Buffer.from(row.tag) }, eff.credentialId!);
  expect(JSON.parse(plain.toString())).toEqual({ privateKey: "PRIVATE KEY" });

  expect(seedLocalhost(db, KEY, file)).toBe(false);
  expect(getTree(db)).toHaveLength(2);

  // Built in: neither the host nor its organization can be deleted, the host cannot be moved.
  const org = tree.find((n) => n.name === "SysAiAdm")!;
  expect(() => deleteNode(db, host.id)).toThrow("PROTECTED");
  expect(() => deleteNode(db, org.id, { recursive: true })).toThrow("PROTECTED");
  const other = createNode(db, { parentId: null, kind: "company", name: "Other" });
  expect(() => moveNode(db, host.id, other.id)).toThrow("PROTECTED");
});

test("adopts the node of older builds and recreates a missing one", () => {
  const db = openDb(":memory:");
  const file = join(mkdtempSync(join(tmpdir(), "sysadm-local-")), "id");
  writeFileSync(file, "PRIVATE KEY");
  seedLocalhost(db, KEY, file);
  const id = getSetting<string>(db, LOCALHOST_NODE)!;
  db.run("DELETE FROM settings WHERE key = ?", [LOCALHOST_NODE]);
  expect(seedLocalhost(db, KEY, file)).toBe(false);
  expect(getSetting(db, LOCALHOST_NODE)).toBe(id);

  // Removed behind the guard's back (old build): recreated in the existing organization.
  db.run("DELETE FROM settings WHERE key = ?", [LOCALHOST_NODE]);
  deleteNode(db, id);
  expect(seedLocalhost(db, KEY, file)).toBe(true);
  expect(getTree(db).map((n) => n.name).sort()).toEqual(["SysAiAdm", "localhost"]);
});

test("only the localhost node's AGENTS.md explains sysadm-oc", async () => {
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "sysadm-local-"));
  writeFileSync(join(dir, "id"), "PRIVATE KEY");
  seedLocalhost(db, KEY, join(dir, "id"));
  const infra = join(dir, "infra");
  await materializeAll(db, infra);
  for (const node of getTree(db)) {
    const md = await Bun.file(join(nodeDir(infra, node.id), "AGENTS.md")).text();
    expect(md.includes("sysadm-oc plugin-add")).toBe(node.name === "localhost");
  }
});
