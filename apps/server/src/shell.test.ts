import { expect, test } from "bun:test";
import { openDb } from "./db";
import { createNode, updateNode } from "./inventory";
import { openNodeShell } from "./shell";
import { HostKeyMismatch, type Hop, type ShellSession } from "./ssh";
import { seal } from "./vault";

const KEY = Buffer.alloc(32, 7);

function setup() {
  const db = openDb(":memory:");
  const sealed = seal(KEY, JSON.stringify({ password: "pw" }), "cred-1");
  db.run("INSERT INTO credentials (id, name, type, ciphertext, iv, tag, created_at) VALUES ('cred-1', 'k', 'password', ?, ?, ?, 0)", [
    sealed.ciphertext,
    sealed.iv,
    sealed.tag,
  ]);
  const company = createNode(db, { parentId: null, kind: "company", name: "Acme" });
  const bastion = createNode(db, { parentId: company.id, kind: "vm", name: "bastion", address: "bastion.test", os: "ubuntu" });
  const host = createNode(db, { parentId: company.id, kind: "vm", name: "vm-01", address: "10.0.0.5", os: "ubuntu", jumpMode: "via", jumpNodeId: bastion.id });
  return { db, company, bastion, host };
}

const fakeSession = (hops: Hop[], closed: { n: number }): ShellSession =>
  ({ stream: {}, hostKeys: hops.map((h) => `SHA256:${h.host}`), resize() {}, close: () => closed.n++ }) as unknown as ShellSession;

test("opens through the bastion and pins host keys on first use", async () => {
  const { db, company, bastion, host } = setup();
  await expect(openNodeShell(db, KEY, host.id, 80, 24)).rejects.toThrow("пользователь");
  updateNode(db, company.id, { credentialId: "cred-1", user: "root" });

  const seen: Hop[][] = [];
  const closed = { n: 0 };
  const shell = await openNodeShell(db, KEY, host.id, 100, 30, async (input) => {
    seen.push(input.hops);
    return fakeSession(input.hops, closed);
  });
  expect(shell.node).toBe("vm-01");
  expect(shell.via).toEqual(["bastion"]);
  expect(seen[0].map((h) => h.host)).toEqual(["bastion.test", "10.0.0.5"]);
  expect(db.query<{ host_key: string }, [string]>("SELECT host_key FROM nodes WHERE id = ?").get(bastion.id)!.host_key).toBe("SHA256:bastion.test");

  // A different key on the next connection is refused and the session closed.
  db.run("UPDATE nodes SET host_key = 'SHA256:other' WHERE id = ?", [host.id]);
  await expect(openNodeShell(db, KEY, host.id, 80, 24, async (input) => fakeSession(input.hops, closed))).rejects.toThrow("не совпал");
  expect(closed.n).toBe(1);

  await expect(
    openNodeShell(db, KEY, host.id, 80, 24, async () => {
      throw new HostKeyMismatch(1);
    }),
  ).rejects.toThrow("vm-01");
});
