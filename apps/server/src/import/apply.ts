import type { Database } from "bun:sqlite";
import type { ImportHost, ImportPreview, ImportTree, JumpRef } from "@sysadm/shared";
import { audit } from "../guard";
import { createNode, findByAddress, updateNode } from "../inventory";
import { ImportError } from "./error";

const DEFAULT_PORT = 22;

// Existing node for each imported item: by (source, key) first, then by address for hosts.
function findExisting(db: Database, tree: ImportTree): Map<string, string> {
  const found = new Map<string, string>();
  const byKey = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM nodes WHERE import_source = ? AND import_key = ?",
  );
  for (const g of tree.groups) {
    const row = byKey.get(tree.source, g.key);
    if (row) found.set(g.key, row.id);
  }
  for (const h of tree.hosts) {
    const row = byKey.get(tree.source, h.key);
    const node = row ?? findByAddress(db, h.address, h.port ?? DEFAULT_PORT);
    if (node) found.set(h.key, node.id);
  }
  return found;
}

// `[user@]host[:port]` → host and port; the user part is ignored.
export function parseRaw(raw: string): { host: string; port: number } {
  const hostPart = raw.slice(raw.lastIndexOf("@") + 1);
  const m = /^(.*):(\d+)$/.exec(hostPart);
  return m ? { host: m[1], port: Number(m[2]) } : { host: hostPart, port: DEFAULT_PORT };
}

export function previewImport(db: Database, tree: ImportTree): ImportPreview {
  const existing = findExisting(db, tree);
  const items: ImportPreview["items"] = [];
  for (const g of tree.groups) {
    const exists = existing.has(g.key);
    items.push({
      key: g.key,
      kind: "group",
      name: g.name,
      parentKey: g.parentKey,
      action: exists ? "skip" : "create",
      reason: exists ? "exists" : undefined,
    });
  }
  for (const h of tree.hosts) {
    const exists = existing.has(h.key);
    items.push({
      key: h.key,
      kind: "vm",
      name: h.name,
      address: h.address,
      parentKey: h.parentKey,
      action: exists ? "skip" : "create",
      reason: exists ? "exists" : undefined,
    });
  }
  return { items, warnings: tree.warnings };
}

export interface ApplyResult {
  created: number;
  skipped: number;
  warnings: string[];
  createdIds: string[];
}

// One transaction: any error (including JUMP_* from updateNode) rolls back the whole import.
export function applyImport(
  db: Database,
  tree: ImportTree,
  targetParentId: string | null,
  options: { skipKeys: string[]; actor?: string },
): ApplyResult {
  return db.transaction((): ApplyResult => {
    const existing = findExisting(db, tree);
    const userSkip = new Set(options.skipKeys);
    const parentOf = new Map<string, string | null>();
    for (const g of tree.groups) parentOf.set(g.key, g.parentKey);
    for (const h of tree.hosts) parentOf.set(h.key, h.parentKey);

    // A key is skipped when it or any ancestor was unchecked by the user.
    const skippedByUser = (key: string | null): boolean => {
      const seen = new Set<string>();
      for (let k = key; k !== null && !seen.has(k); k = parentOf.get(k) ?? null) {
        if (userSkip.has(k)) return true;
        seen.add(k);
      }
      return false;
    };

    const warnings = [...tree.warnings];
    const ids = new Map<string, string>(existing);
    const createdIds: string[] = [];
    const created: string[] = [];
    let skipped = 0;

    const groupsByKey = new Map(tree.groups.map((g) => [g.key, g]));
    const resolving = new Set<string>();
    // Creates a group after its parent; reuses existing groups without counting them as skipped.
    const ensureGroup = (key: string): string | null => {
      const known = ids.get(key);
      if (known) return known;
      const g = groupsByKey.get(key);
      if (!g) return null;
      if (resolving.has(key)) throw new ImportError("group cycle in import tree");
      resolving.add(key);
      const parentId = g.parentKey ? ensureGroup(g.parentKey) : targetParentId;
      const node = createNode(db, {
        parentId,
        kind: "group",
        name: g.name,
        user: g.user ?? null,
        port: g.port ?? null,
        importSource: tree.source,
        importKey: g.key,
      });
      ids.set(key, node.id);
      created.push(node.id);
      if (parentId === targetParentId) createdIds.push(node.id);
      resolving.delete(key);
      return node.id;
    };

    for (const g of tree.groups) {
      if (skippedByUser(g.key)) continue;
      ensureGroup(g.key);
    }

    for (const h of tree.hosts) {
      if (existing.has(h.key) || skippedByUser(h.key)) {
        skipped++;
        continue;
      }
      const parentId = h.parentKey ? ensureGroup(h.parentKey) : targetParentId;
      const node = createNode(db, hostInput(h, parentId, tree.source));
      ids.set(h.key, node.id);
      created.push(node.id);
      if (parentId === targetParentId) createdIds.push(node.id);
    }

    // Jumps after all nodes exist, so a bastion can be a sibling created later.
    const createdSet = new Set(created);
    const addressIds = new Map<string, string>();
    for (const h of tree.hosts) {
      const id = ids.get(h.key);
      if (id && createdSet.has(id)) addressIds.set(`${h.address}:${h.port ?? DEFAULT_PORT}`, id);
    }
    const applyJump = (nodeId: string, ref: JumpRef | undefined, label: string): void => {
      if (!ref) return;
      if ("key" in ref) {
        const target = ids.get(ref.key);
        if (!target) {
          warnings.push(`${label}: jump ${ref.key} not found`);
          return;
        }
        updateNode(db, nodeId, { jumpMode: "via", jumpNodeId: target });
        return;
      }
      const { host, port } = parseRaw(ref.raw);
      const target = addressIds.get(`${host}:${port}`) ?? findByAddress(db, host, port)?.id;
      if (!target) {
        warnings.push(`${label}: jump ${ref.raw} not found`);
        return;
      }
      updateNode(db, nodeId, { jumpMode: "via", jumpNodeId: target });
    };
    for (const g of tree.groups) {
      const id = ids.get(g.key);
      if (id && createdSet.has(id)) applyJump(id, g.jumpRef, g.name);
    }
    for (const h of tree.hosts) {
      const id = ids.get(h.key);
      if (id && createdSet.has(id)) applyJump(id, h.jumpRef, h.name);
    }

    audit(db, {
      actor: options.actor ?? "admin",
      action: "import",
      detail: { source: tree.source, created: created.length, skipped },
    });
    return { created: created.length, skipped, warnings, createdIds };
  })();
}

function hostInput(h: ImportHost, parentId: string | null, source: ImportTree["source"]) {
  const keyLine = h.keyPathHint ? `ключ в исходной системе: ${h.keyPathHint}` : null;
  const notes = [h.notes, keyLine].filter(Boolean).join("\n") || null;
  return {
    parentId,
    kind: "vm" as const,
    name: h.name,
    os: h.os,
    address: h.address,
    port: h.port ?? null,
    user: h.user ?? null,
    notes,
    importSource: source,
    importKey: h.key,
  };
}
