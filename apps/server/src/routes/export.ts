import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { applyExport, buildExport, decryptExport, encryptExport, ExportError } from "../export";
import { audit } from "../guard";
import { getNode } from "../inventory";
import { materializeSubtree } from "../materialize";

const MAX_FILE = 5 * 1024 * 1024;

export function exportRoutes(deps: { db: Database; masterKey: Buffer; infraDir: string }): Hono {
  const { db, masterKey } = deps;
  const app = new Hono();

  // POST so the passphrase travels in the body, not in a URL that ends up in logs.
  app.post("/api/inventory/export", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { rootId?: unknown; withSecrets?: unknown; passphrase?: unknown } | null;
    const rootId = typeof body?.rootId === "string" ? body.rootId : null;
    const withSecrets = body?.withSecrets === true;
    if (typeof body?.passphrase !== "string") return c.json({ error: "passphrase is required" }, 400);
    const root = rootId === null ? null : getNode(db, rootId);
    if (rootId !== null && !root) return c.json({ error: "not found" }, 404);
    try {
      const payload = buildExport(db, masterKey, rootId, withSecrets);
      const file = encryptExport(payload, body.passphrase);
      audit(db, { actor: c.get("actor"), action: "inventory_export", nodeId: rootId ?? undefined, detail: { nodes: payload.nodes.length, withSecrets } });
      const stamp = new Date().toISOString().slice(0, 10);
      const name = `${(root?.name ?? "inventory").replace(/[^\p{L}\p{N}._-]+/gu, "_")}-${stamp}.sysaiadm`;
      c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      return c.json(file);
    } catch (e) {
      if (e instanceof ExportError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  app.post("/api/inventory/import", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    const parentId = typeof body.parentId === "string" && body.parentId !== "" ? body.parentId : null;
    if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
    if (file.size > MAX_FILE) return c.json({ error: "payload too large" }, 413);
    if (typeof body.passphrase !== "string") return c.json({ error: "passphrase is required" }, 400);
    if (parentId !== null && !getNode(db, parentId)) return c.json({ error: "parent not found" }, 404);
    let result;
    try {
      const raw: unknown = JSON.parse(await file.text());
      result = applyExport(db, masterKey, decryptExport(raw, body.passphrase), parentId);
    } catch (e) {
      if (e instanceof SyntaxError) return c.json({ error: "это не файл экспорта SysAiAdm Station" }, 400);
      if (e instanceof ExportError) return c.json({ error: e.message }, 400);
      const message = e instanceof Error ? e.message : "";
      // Tree rules (company only at the top, jump limits) come from inventory validation.
      if (/^[A-Z_]+$/.test(message)) return c.json({ error: message }, 422);
      throw e;
    }
    for (const id of result.rootIds) await materializeSubtree(db, deps.infraDir, id);
    audit(db, { actor: c.get("actor"), action: "inventory_import", nodeId: parentId ?? undefined, detail: { nodes: result.nodes, credentials: result.credentials } });
    return c.json({ nodes: result.nodes, credentials: result.credentials, warnings: result.warnings });
  });

  return app;
}
