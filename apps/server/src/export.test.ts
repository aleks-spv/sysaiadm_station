import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { openDb } from "./db";
import { applyExport, buildExport, decryptExport, encryptExport } from "./export";
import { createNode, getTree, updateNode } from "./inventory";
import { open, seal } from "./vault";

const PASS = "correct horse battery";

function addCredential(db: ReturnType<typeof openDb>, key: Buffer, name: string, secret: object): string {
  const id = crypto.randomUUID();
  const s = seal(key, JSON.stringify(secret), id);
  db.run("INSERT INTO credentials (id, name, type, ciphertext, iv, tag, created_at) VALUES (?, ?, 'password', ?, ?, ?, 0)", [id, name, s.ciphertext, s.iv, s.tag]);
  return id;
}

function source() {
  const key = randomBytes(32);
  const db = openDb(":memory:");
  const cred = addCredential(db, key, "root-pass", { password: "s3cret" });
  const acme = createNode(db, { parentId: null, kind: "company", name: "Acme" });
  updateNode(db, acme.id, { credentialId: cred });
  const bastion = createNode(db, { parentId: acme.id, kind: "vm", name: "bastion", address: "10.0.0.1", os: "debian" });
  const web = createNode(db, { parentId: acme.id, kind: "vm", name: "web", address: "10.0.0.2", os: "ubuntu" });
  updateNode(db, web.id, { jumpMode: "via", jumpNodeId: bastion.id });
  createNode(db, { parentId: null, kind: "company", name: "Other" });
  return { db, key, acme, web };
}

test("export with secrets moves nodes, jump and a re-sealed credential to another instance", () => {
  const src = source();
  const file = encryptExport(buildExport(src.db, src.key, null, true), PASS);
  expect(JSON.stringify(file)).not.toContain("s3cret");
  expect(() => decryptExport(file, "wrong passphrase!")).toThrow("неверный пароль");

  const key = randomBytes(32);
  const db = openDb(":memory:");
  const result = applyExport(db, key, decryptExport(JSON.parse(JSON.stringify(file)), PASS), null);
  expect(result).toMatchObject({ nodes: 4, credentials: 1, warnings: [] });

  const tree = getTree(db);
  const byName = (n: string) => tree.find((x) => x.name === n)!;
  expect(byName("web").jumpMode).toBe("via");
  expect(byName("web").jumpNodeId).toBe(byName("bastion").id);
  const cred = db.query<{ id: string; ciphertext: Buffer; iv: Buffer; tag: Buffer }, []>("SELECT id, ciphertext, iv, tag FROM credentials").get()!;
  expect(byName("Acme").credentialId).toBe(cred.id);
  expect(JSON.parse(open(key, cred, cred.id).toString())).toEqual({ password: "s3cret" });
});

test("a subtree export without secrets reuses a same-named credential and warns about a missing bastion", () => {
  const src = source();
  const payload = buildExport(src.db, src.key, src.web.id, false);
  expect(payload.nodes.map((n) => n.name)).toEqual(["web"]);
  expect(payload.credentials).toEqual([]);

  const acmeOnly = buildExport(src.db, src.key, src.acme.id, false);
  expect(acmeOnly.credentials).toEqual([{ id: expect.any(String), name: "root-pass", type: "password" }]);

  const key = randomBytes(32);
  const db = openDb(":memory:");
  const local = addCredential(db, key, "root-pass", { password: "other" });
  const target = createNode(db, { parentId: null, kind: "company", name: "Target" });
  expect(applyExport(db, key, acmeOnly, null)).toMatchObject({ nodes: 3, credentials: 0, warnings: [] });
  expect(getTree(db).find((n) => n.name === "Acme")!.credentialId).toBe(local);

  const result = applyExport(db, key, payload, target.id);
  expect(result.nodes).toBe(1);
  expect(result.warnings[0]).toContain("бастион");
});

test("a short passphrase and a malformed node are rejected", () => {
  const src = source();
  const payload = buildExport(src.db, src.key, null, false);
  expect(() => encryptExport(payload, "short")).toThrow("не короче");
  const bad = { ...payload, nodes: [{ ...payload.nodes[0]!, kind: "router" }] } as unknown as typeof payload;
  expect(() => applyExport(openDb(":memory:"), randomBytes(32), bad, null)).toThrow("некорректный узел");
});
