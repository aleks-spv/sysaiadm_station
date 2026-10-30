import { expect, test } from "bun:test";
import { openDb } from "./db";
import { createNode } from "./inventory";
import type { OpenCodeClient } from "./opencode";
import { createInternalApp } from "./routes/internal";
import { setSetting } from "./settings";
import { createWebSearcher, formatResults, leakReason, validateSettings } from "./websearch";

const TOKEN = "w".repeat(40);

function setup(settings: object) {
  const db = openDb(":memory:");
  setSetting(db, "web_search", settings);
  const acme = createNode(db, { parentId: null, kind: "company", name: "Acme" });
  const vm = createNode(db, { parentId: acme.id, kind: "vm", name: "web", address: "db01.acme.local", os: "ubuntu" });
  db.run("INSERT INTO tasks (id, node_id, session_id, title, status, created_at) VALUES ('t1', ?, 's1', 'x', 'running', 0)", [vm.id]);
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    return Response.json({ results: [{ url: "https://pve.proxmox.com/wiki/Roadmap", title: "Roadmap", content: "x".repeat(2000) }, { title: "no url" }] });
  };
  const client = {
    websearch: {
      query: async (input: { query: string; providerID?: string }) => ({
        location: {},
        data: { providerID: input.providerID, results: [{ url: "https://exa.example/a", title: "A", content: "found", time: {} }] },
      }),
    },
  } as unknown as OpenCodeClient;
  return { db, calls, searcher: createWebSearcher({ db, client, directory: "/infra", fetchFn }) };
}

test("settings: SearXNG needs a URL, the URL is normalised, unknown providers are rejected", () => {
  expect(validateSettings({ provider: "searxng" })).toContain("адрес");
  expect(validateSettings({ provider: "searxng", searxngUrl: "http://searx:8080/" })).toEqual({ provider: "searxng", searxngUrl: "http://searx:8080", maxResults: 8 });
  expect(validateSettings({ provider: "google" })).toContain("provider");
  expect(validateSettings({ provider: "searxng", searxngUrl: "file:///etc/passwd" })).toContain("http");
});

test("queries that name our servers or private IPs never leave", () => {
  const { db } = setup({ provider: "off" });
  expect(leakReason(db, "nginx 502 on 10.0.3.4")).toContain("IP");
  expect(leakReason(db, "mysql slow on DB01.acme.local")).toContain("инвентаря");
  expect(leakReason(db, "nginx upstream timed out 110")).toBeNull();
});

test("SearXNG results are clipped and filtered; built-in providers go through opencode", async () => {
  const sx = setup({ provider: "searxng", searxngUrl: "http://searx:8080", maxResults: 5 });
  const r = await sx.searcher.search("proxmox 9 release notes");
  expect(sx.calls[0]).toBe("http://searx:8080/search?q=proxmox%209%20release%20notes&format=json");
  expect(r.results).toHaveLength(1);
  expect(r.results[0]!.content.length).toBeLessThan(700);
  expect(formatResults(r.results)).toContain("1. Roadmap");

  const exa = setup({ provider: "exa" });
  expect(await exa.searcher.search("bun 1.4 changelog")).toEqual({ provider: "exa", results: [{ url: "https://exa.example/a", title: "A", content: "found" }] });
  await expect(setup({ provider: "off" }).searcher.search("x y")).rejects.toThrow("выключен");
});

test("the plugin's internal route searches for a known session and audits the query", async () => {
  const { db, searcher } = setup({ provider: "exa" });
  const app = createInternalApp({ db, token: TOKEN, masterKey: Buffer.alloc(32), webSearch: searcher });
  const call = (body: object) =>
    app.request("/internal/websearch", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  expect(await (await app.request("/internal/websearch", { headers: { authorization: `Bearer ${TOKEN}` } })).json()).toEqual({ enabled: true });
  const ok = await call({ sessionID: "s1", query: "bun 1.4 changelog" });
  expect((await ok.json()).content).toContain("https://exa.example/a");
  expect((await call({ sessionID: "s1", query: "error on 192.168.1.10" })).status).toBe(502);
  expect((await call({ sessionID: "nope", query: "x y" })).status).toBe(404);
  const rows = db.query<{ detail: string }, []>("SELECT detail FROM audit WHERE action = 'web_search' ORDER BY id").all();
  expect(rows.map((r) => JSON.parse(r.detail).query)).toEqual(["bun 1.4 changelog", "error on 192.168.1.10"]);
});
