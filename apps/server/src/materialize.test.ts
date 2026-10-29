import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { createNode, setNodeSkills, updateNode, type NodeInput } from "./inventory";
import { materializeAll, materializeNode, materializeSubtree, nodeDir } from "./materialize";

let db: Database;
let infra: string;

beforeEach(async () => {
  db = openDb(":memory:");
  infra = await mkdtemp(join(tmpdir(), "sysadm-materialize-"));
  for (const id of ["linux-common", "debian-ubuntu", "proxmox", "windows-server", "ops"]) {
    db.run("INSERT INTO skills (id, name, description, content, builtin) VALUES (?, ?, 'd', ?, 1)", [
      id,
      id,
      `---\nname: ${id}\ndescription: test\n---\nbody of ${id}\n`,
    ]);
  }
  db.run(
    "INSERT INTO credentials (id, name, type, ciphertext, iv, tag, created_at) VALUES ('cred-1', 'CRED-NAME-SECRET', 'key', ?, ?, ?, 0)",
    [new Uint8Array(1), new Uint8Array(12), new Uint8Array(16)],
  );
});

afterEach(async () => {
  db.close();
  await rm(infra, { recursive: true, force: true });
});

const company = (name = "Acme", extra: Partial<NodeInput> = {}) =>
  createNode(db, { parentId: null, kind: "company", name, ...extra });

const vm = (parentId: string, name: string, extra: Partial<NodeInput> = {}) =>
  createNode(db, { parentId, kind: "vm", name, address: "10.0.0.5", os: "ubuntu", ...extra });

const read = (nodeId: string, file: string) => readFile(join(nodeDir(infra, nodeId), file), "utf8");

test("a proxmox vm gets the three os skills and no credential or ssh user", async () => {
  const root = company("Acme", { notes: "COMPANY-NOTE" });
  updateNode(db, root.id, { credentialId: "cred-1", user: "SSH-USER-SECRET" });
  const host = vm(root.id, "pve-07", { os: "proxmox" });
  await materializeNode(db, infra, host.id);

  const agents = await read(host.id, "AGENTS.md");
  expect(agents).toContain("Сервер этой сессии: pve-07, 10.0.0.5, ОС proxmox, оболочка bash.");
  expect(agents).toContain("Путь в дереве: Acme / pve-07");
  expect(agents).not.toContain("CRED-NAME-SECRET");
  expect(agents).not.toContain("SSH-USER-SECRET");

  for (const skill of ["linux-common", "debian-ubuntu", "proxmox"]) {
    expect(await read(host.id, `.opencode/skills/${skill}/SKILL.md`)).toContain(`body of ${skill}`);
  }
});

test("company notes come before vm notes", async () => {
  const root = company("Acme", { notes: "COMPANY-NOTE" });
  const host = vm(root.id, "vm-01", { notes: "VM-NOTE" });
  await materializeNode(db, infra, host.id);
  const agents = await read(host.id, "AGENTS.md");
  expect(agents.indexOf("COMPANY-NOTE")).toBeGreaterThan(-1);
  expect(agents.indexOf("COMPANY-NOTE")).toBeLessThan(agents.indexOf("VM-NOTE"));
});

test("re-materialize after a removed skill and changed notes drops the old skill dir", async () => {
  const root = company("Acme", { notes: "first" });
  const host = vm(root.id, "vm-01", { os: "other" });
  setNodeSkills(db, host.id, ["ops"]);
  await materializeNode(db, infra, host.id);
  expect(existsSync(join(nodeDir(infra, host.id), ".opencode/skills/ops"))).toBe(true);

  setNodeSkills(db, host.id, []);
  updateNode(db, root.id, { notes: "second" });
  await materializeNode(db, infra, host.id);

  const agents = await read(host.id, "AGENTS.md");
  expect(agents).toContain("second");
  expect(agents).not.toContain("first");
  expect(existsSync(join(nodeDir(infra, host.id), ".opencode/skills/ops"))).toBe(false);
});

test("changing a bastion's jump re-materializes the vm that goes through it", async () => {
  const root = company("Acme");
  const first = vm(root.id, "jump-a", { jumpMode: "direct" });
  const bastion = vm(root.id, "bastion");
  const host = vm(root.id, "vm-01");
  updateNode(db, root.id, { jumpMode: "via", jumpNodeId: bastion.id });
  await materializeAll(db, infra);
  expect(await read(host.id, "AGENTS.md")).toContain("через бастион bastion");

  updateNode(db, bastion.id, { jumpMode: "via", jumpNodeId: first.id });
  await materializeSubtree(db, infra, bastion.id);
  expect(await read(host.id, "AGENTS.md")).toContain("через бастион jump-a → bastion");
});

test("a route that fails to resolve is written as a line, not thrown", async () => {
  const root = company("Acme");
  const host = vm(root.id, "vm-01", { jumpMode: "direct" });
  db.run("UPDATE nodes SET jump_mode = 'via', jump_node_id = id WHERE id = ?", [host.id]);
  await materializeNode(db, infra, host.id);
  expect(await read(host.id, "AGENTS.md")).toContain("Маршрут не настроен: JUMP_CYCLE");
});

test("materializeAll removes folders of nodes that no longer exist", async () => {
  const root = company("Acme");
  const host = vm(root.id, "vm-01");
  await materializeAll(db, infra);
  expect(existsSync(nodeDir(infra, host.id))).toBe(true);

  db.run("DELETE FROM nodes WHERE id = ?", [host.id]);
  await materializeAll(db, infra);
  expect(existsSync(nodeDir(infra, host.id))).toBe(false);
});
