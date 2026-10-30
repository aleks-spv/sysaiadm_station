import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { openDb } from "../db";
import { createNode, updateNode } from "../inventory";
import { HostKeyMismatch, type ExecInput, type ExecOutput } from "../ssh";
import { seal } from "../vault";
import { createInternalApp } from "./internal";

const KEY = Buffer.alloc(32, 7);
const TOKEN = "t".repeat(40);

let db: Database;
let execImpl: (input: ExecInput) => Promise<ExecOutput>;
const calls: ExecInput[] = [];
let app: ReturnType<typeof createInternalApp>;

const okOutput = (input: ExecInput): ExecOutput => ({
  stdout: "up 1 day\n",
  stderr: "",
  exitCode: 0,
  truncated: false,
  hostKeys: input.hops.map((h) => `SHA256:${h.host}`),
});

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, open: release };
}

beforeEach(() => {
  db = openDb(":memory:");
  calls.length = 0;
  execImpl = async (input) => okOutput(input);

  const sealed = seal(KEY, JSON.stringify({ password: "pw" }), "cred-1");
  db.run("INSERT INTO credentials (id, name, type, ciphertext, iv, tag, created_at) VALUES ('cred-1', 'k', 'password', ?, ?, ?, 0)", [
    sealed.ciphertext,
    sealed.iv,
    sealed.tag,
  ]);

  const company = createNode(db, { parentId: null, kind: "company", name: "Acme" });
  updateNode(db, company.id, { credentialId: "cred-1", user: "root" });
  const bastion = createNode(db, { parentId: company.id, kind: "vm", name: "bastion", address: "bastion.example.test", os: "ubuntu" });
  const host = createNode(db, {
    parentId: company.id,
    kind: "vm",
    name: "vm-01",
    address: "10.0.0.5",
    os: "ubuntu",
    jumpMode: "via",
    jumpNodeId: bastion.id,
  });
  db.run("INSERT INTO tasks (id, node_id, session_id, title, status, created_at) VALUES ('task-1', ?, 'ses-1', 't', 'idle', 0)", [host.id]);

  app = createInternalApp({
    db,
    token: TOKEN,
    masterKey: KEY,
    exec: (input) => {
      calls.push(input);
      return execImpl(input);
    },
    filterOutput: async (o) => ({ stdout: o.stdout.toUpperCase(), stderr: o.stderr, note: "[filtered]" }),
  });
});

async function post(path: string, body: unknown, token = TOKEN): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const exec = (command: string, extra: Record<string, unknown> = {}) =>
  post("/internal/exec", { sessionID: "ses-1", command, toolCallId: "call-1", ...extra });

test("requests without the internal token get 401", async () => {
  const res = await post("/internal/check", { sessionID: "ses-1", command: "uptime" }, "wrong");
  expect(res.status).toBe(401);
});

test("an unknown session gets 404", async () => {
  const res = await post("/internal/check", { sessionID: "nope", command: "uptime" });
  expect(res.status).toBe(404);
});

test("check returns the route from inventory, not from the request", async () => {
  const res = await post("/internal/check", { sessionID: "ses-1", command: "uptime", host: "evil.example" });
  const body = (await res.json()) as { verdict: string; address: string; via: string[] };
  expect(body.verdict).toBe("normal");
  expect(body.address).toBe("10.0.0.5");
  expect(body.via).toEqual(["bastion"]);
});

test("a denied command is refused by check and exec never runs", async () => {
  const check = (await (await post("/internal/check", { sessionID: "ses-1", command: "rm -rf /" })).json()) as { verdict: string };
  expect(check.verdict).toBe("deny");

  const res = await exec("rm -rf /");
  expect(res.status).toBe(403);
  expect(calls).toHaveLength(0);
});

test("GET on an internal path is not served", async () => {
  const res = await app.request("/internal/exec", { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(404);
});

test("exec through a bastion sends two hops in order and pins both host keys", async () => {
  const res = await exec("uptime");
  expect(res.status).toBe(200);
  expect(calls[0].hops.map((h) => h.host)).toEqual(["bastion.example.test", "10.0.0.5"]);

  const keys = db.query<{ name: string; host_key: string }, []>("SELECT name, host_key FROM nodes WHERE name IN ('bastion','vm-01') ORDER BY name").all();
  expect(keys).toEqual([
    { name: "bastion", host_key: "SHA256:bastion.example.test" },
    { name: "vm-01", host_key: "SHA256:10.0.0.5" },
  ]);

  const audit = db.query<{ action: string; detail: string }, []>("SELECT action, detail FROM audit WHERE action = 'exec'").get();
  expect(audit?.action).toBe("exec");
  expect(JSON.parse(audit?.detail ?? "{}")).toMatchObject({ via: ["bastion"], exitCode: 0 });
});

test("plugin output filters apply unless the model asks for raw output", async () => {
  const filtered = (await (await exec("uptime")).json()) as { stdout: string; note?: string };
  expect(filtered).toMatchObject({ stdout: "UP 1 DAY\n", note: "[filtered]" });
  const raw = (await (await exec("uptime", { raw: true })).json()) as { stdout: string; note?: string };
  expect(raw.stdout).toBe("up 1 day\n");
  expect(raw.note).toBeUndefined();
});

test("a host key mismatch on the bastion is a 409 that names the bastion", async () => {
  execImpl = async () => {
    throw new HostKeyMismatch(0);
  };
  const res = await exec("uptime");
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "HOST_KEY_MISMATCH", node: "bastion" });
});

test("the fifth concurrent exec on one node gets 429", async () => {
  const g = gate();
  execImpl = async (input) => {
    await g.wait;
    return okOutput(input);
  };
  const requests = Array.from({ length: 5 }, () => exec("uptime"));
  const first = await Promise.race(requests);
  expect(first.status).toBe(429);
  g.open();
  const statuses = (await Promise.all(requests)).map((r) => r.status).sort();
  expect(statuses).toEqual([200, 200, 200, 200, 429]);
});

test("two parallel first connections: one pins, the other gets 409", async () => {
  const g = gate();
  let n = 0;
  let bothInside!: () => void;
  const bothReady = new Promise<void>((resolve) => {
    bothInside = resolve;
  });
  execImpl = async (input) => {
    n++;
    const key = `SHA256:key-${n}`;
    if (n === 2) bothInside();
    await g.wait;
    return { ...okOutput(input), hostKeys: input.hops.map(() => key) };
  };
  const requests = [exec("uptime"), exec("uptime")];
  await bothReady;
  g.open();
  const statuses = (await Promise.all(requests)).map((r) => r.status).sort();
  expect(statuses).toEqual([200, 409]);

  const stored = db.query<{ host_key: string }, []>("SELECT host_key FROM nodes WHERE name = 'vm-01'").get();
  expect(["SHA256:key-1", "SHA256:key-2"]).toContain(stored?.host_key ?? "");
});
