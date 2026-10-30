import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { ImportSource, ImportTree } from "@sysadm/shared";
import { applyImport, previewImport } from "../import/apply";
import { ImportError } from "../import/error";
import { parseAnsible } from "../import/ansible";
import { parseMremoteng } from "../import/mremoteng";
import { parseRdm } from "../import/rdm";
import { parseRustconn } from "../import/rustconn";
import { getNode } from "../inventory";
import { materializeSubtree } from "../materialize";

const MAX_FILE = 5 * 1024 * 1024;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const SOURCES: Record<ImportSource, (content: string) => ImportTree> = {
  rustconn: parseRustconn,
  rdm: parseRdm,
  mremoteng: parseMremoteng,
  ansible: parseAnsible,
};

interface Pending {
  tree: ImportTree;
  parentId: string | null;
  expires: number;
}

export function importRoutes(deps: { db: Database; infraDir: string; now?: () => number }): Hono {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, Pending>();
  const app = new Hono();

  const prune = () => {
    const t = now();
    for (const [token, entry] of pending) if (entry.expires <= t) pending.delete(token);
  };

  // Uploaded file is parsed in memory and never written to disk or echoed back.
  app.post("/api/import/preview", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    const source = body.source;
    const parentRaw = typeof body.parentId === "string" && body.parentId !== "" ? body.parentId : null;

    if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
    if (file.size > MAX_FILE) return c.json({ error: "payload too large" }, 413);
    if (typeof source !== "string" || !(source in SOURCES)) return c.json({ error: "unknown source" }, 400);
    if (parentRaw !== null && getNode(deps.db, parentRaw) === null) return c.json({ error: "parent not found" }, 404);

    let tree: ImportTree;
    try {
      tree = SOURCES[source as ImportSource](await file.text());
    } catch (err) {
      if (err instanceof ImportError) return c.json({ error: err.message }, 400);
      throw err;
    }

    prune();
    const token = crypto.randomUUID();
    pending.set(token, { tree, parentId: parentRaw, expires: now() + TOKEN_TTL_MS });
    return c.json({ token, preview: previewImport(deps.db, tree, parentRaw) });
  });

  app.post("/api/import/apply", async (c) => {
    const { token, skipKeys } = (await c.req.json().catch(() => ({}))) as { token?: unknown; skipKeys?: unknown };
    // Take the token before any further await: a second or parallel apply finds nothing.
    const entry = typeof token === "string" ? pending.get(token) : undefined;
    if (typeof token === "string") pending.delete(token);
    if (!entry || entry.expires <= now()) return c.json({ error: "token used or expired" }, 409);
    const keys = Array.isArray(skipKeys) ? skipKeys.filter((k): k is string => typeof k === "string") : [];

    let result;
    try {
      result = applyImport(deps.db, entry.tree, entry.parentId, { skipKeys: keys, actor: c.get("actor") });
    } catch (err) {
      const message = err instanceof Error ? err.message : "import failed";
      if (message.startsWith("JUMP_")) return c.json({ error: message }, 422);
      if (err instanceof ImportError) return c.json({ error: message }, 400);
      throw err;
    }
    for (const id of result.createdIds) await materializeSubtree(deps.db, deps.infraDir, id);
    return c.json({ created: result.created, skipped: result.skipped, warnings: result.warnings });
  });

  return app;
}
