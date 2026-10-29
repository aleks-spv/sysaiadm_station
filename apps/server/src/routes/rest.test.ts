import type { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDb } from "../db";
import { credentialsRoutes } from "./credentials";
import { inventoryRoutes } from "./inventory";
import { createNode } from "../inventory";
import { makeClient } from "../opencode";
import { tasksRoutes } from "./tasks";

const KEY = Buffer.alloc(32, 3);
const infraDir = mkdtempSync(join(tmpdir(), "sysadm-rest-"));
let db: Database;
let app: Hono;

afterAll(() => rmSync(infraDir, { recursive: true, force: true }));

beforeEach(() => {
  db = openDb(":memory:");
  const client = makeClient({ baseUrl: "http://127.0.0.1:1", password: "pw" });
  app = new Hono();
  app.route("/", credentialsRoutes(db, KEY));
  app.route("/", inventoryRoutes({ db, client, infraDir }));
  app.route("/", tasksRoutes({ db, client, infraDir }));
});

const json = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("created credential is listed without any secret material", async () => {
  const created = await json("POST", "/api/credentials", { name: "root key", type: "key", privateKey: "PRIVATE-KEY-BODY" });
  expect(created.status).toBe(201);
  const text = await (await json("GET", "/api/credentials")).text();
  expect(text).toContain("root key");
  for (const forbidden of ["ciphertext", "iv", "tag", "PRIVATE-KEY-BODY", "privateKey"]) {
    expect(text).not.toContain(forbidden);
  }
});

test("a credential in use by a node cannot be deleted", async () => {
  const created = (await (await json("POST", "/api/credentials", { name: "pw", type: "password", password: "x" })).json()) as { id: string };
  createNode(db, { parentId: null, kind: "company", name: "Acme", credentialId: created.id });
  const res = await json("DELETE", `/api/credentials/${created.id}`);
  expect(res.status).toBe(409);
});

test("a credential secret must match its type", async () => {
  const res = await json("POST", "/api/credentials", { name: "bad", type: "key", password: "x" });
  expect(res.status).toBe(400);
});

test("a node with a missing parent is refused, and an unknown node is 404", async () => {
  const bad = await json("POST", "/api/nodes", { kind: "company", name: "x", parentId: "nope" });
  expect(bad.status).toBe(409);
  const missing = await json("GET", "/api/nodes/unknown");
  expect(missing.status).toBe(404);
});

test("a vm without an address is 422", async () => {
  const company = (await (await json("POST", "/api/nodes", { kind: "company", name: "Acme" })).json()) as { id: string };
  const res = await json("POST", "/api/nodes", { kind: "vm", name: "vm-01", parentId: company.id });
  expect(res.status).toBe(422);
});

test("moving a node into its own subtree is 409", async () => {
  const company = (await (await json("POST", "/api/nodes", { kind: "company", name: "Acme" })).json()) as { id: string };
  const vm = (await (await json("POST", "/api/nodes", { kind: "vm", name: "vm-01", address: "10.0.0.5", parentId: company.id })).json()) as { id: string };
  const res = await json("POST", `/api/nodes/${company.id}/move`, { parentId: vm.id });
  expect(res.status).toBe(409);
});

test("a builtin skill is read-only", async () => {
  db.run("INSERT INTO skills (id, name, description, content, builtin) VALUES ('linux-common', 'n', 'd', 'c', 1)");
  const res = await json("DELETE", "/api/skills/linux-common");
  expect(res.status).toBe(403);
});
