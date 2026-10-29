import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db";
import { createNode } from "../inventory";
import { importRoutes } from "./import";

const INI = "[web]\n10.1.0.1\n10.1.0.2\n";
let infra: string;
let app: ReturnType<typeof importRoutes>;

beforeEach(() => {
  infra = mkdtempSync(join(tmpdir(), "sysadm-import-"));
  const db = openDb(":memory:");
  createNode(db, { parentId: null, kind: "company", name: "Acme" });
  app = importRoutes({ db, infraDir: infra });
});

afterEach(() => rmSync(infra, { recursive: true, force: true }));

function upload(source: string, content: string, path = "inventory.ini"): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([content], path));
  form.append("source", source);
  return Promise.resolve(app.request("/api/import/preview", { method: "POST", body: form }));
}

function apply(body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request("/api/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("import routes", () => {
  test("preview returns a token and items; apply creates them once", async () => {
    const preview = await upload("ansible", INI);
    expect(preview.status).toBe(200);
    const { token, preview: data } = (await preview.json()) as { token: string; preview: { items: unknown[] } };
    expect(data.items.length).toBeGreaterThan(0);

    const first = await apply({ token, skipKeys: [] });
    expect(first.status).toBe(200);
    const result = (await first.json()) as { created: number; skipped: number };
    expect(result.created).toBeGreaterThan(0);

    const replay = await apply({ token, skipKeys: [] });
    expect(replay.status).toBe(409);
  });

  test("unknown source is rejected", async () => {
    const res = await upload("putty", INI);
    expect(res.status).toBe(400);
  });

  test("mremoteng with a DOCTYPE is rejected without echoing content", async () => {
    const bad = '<!DOCTYPE Connections [<!ENTITY a "x">]><Connections/>';
    const res = await upload("mremoteng", bad, "confCons.xml");
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("<!DOCTYPE");
  });

  test("apply without a token is rejected", async () => {
    expect((await apply({ skipKeys: [] })).status).toBe(409);
  });
});
