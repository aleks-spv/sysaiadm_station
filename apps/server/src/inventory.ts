import type { Database } from "bun:sqlite";
import type { EffectiveNode, InventoryNode, JumpMode, NodeKind, OsKind, ShellKind } from "@sysadm/shared";

const MAX_JUMP_HOPS = 3;
const DEFAULT_PORT = 22;
const ROW_COLUMNS =
  "id, parent_id, kind, name, os, address, port, user, shell, credential_id, jump_mode, jump_node_id, notes, autopilot_until";

interface Row {
  id: string;
  parent_id: string | null;
  kind: NodeKind;
  name: string;
  os: OsKind;
  address: string | null;
  port: number | null;
  user: string | null;
  shell: ShellKind | null;
  credential_id: string | null;
  jump_mode: JumpMode;
  jump_node_id: string | null;
  notes: string | null;
  autopilot_until: number | null;
}

interface Ctx {
  rows: Map<string, Row>;
  skills: Map<string, string[]>;
}

export interface NodeInput {
  parentId: string | null;
  kind: NodeKind;
  name: string;
  os?: OsKind;
  address?: string | null;
  port?: number | null;
  user?: string | null;
  shell?: ShellKind | null;
  credentialId?: string | null;
  jumpMode?: JumpMode;
  jumpNodeId?: string | null;
  notes?: string | null;
  importSource?: string | null;
  importKey?: string | null;
}

export type NodePatch = Partial<Omit<NodeInput, "parentId" | "kind" | "importSource" | "importKey">> & {
  autopilotUntil?: number | null;
};

const PATCH_COLUMNS: Record<keyof NodePatch, string> = {
  name: "name",
  os: "os",
  address: "address",
  port: "port",
  user: "user",
  shell: "shell",
  credentialId: "credential_id",
  jumpMode: "jump_mode",
  jumpNodeId: "jump_node_id",
  notes: "notes",
  autopilotUntil: "autopilot_until",
};

function loadCtx(db: Database): Ctx {
  const rows = new Map<string, Row>();
  for (const row of db.query<Row, []>(`SELECT ${ROW_COLUMNS} FROM nodes ORDER BY sort, name`).all()) {
    rows.set(row.id, row);
  }
  const skills = new Map<string, string[]>();
  const pairs = db
    .query<{ node_id: string; skill_id: string }, []>("SELECT node_id, skill_id FROM node_skills ORDER BY skill_id")
    .all();
  for (const { node_id, skill_id } of pairs) {
    skills.set(node_id, [...(skills.get(node_id) ?? []), skill_id]);
  }
  return { rows, skills };
}

// Path from the node up to the root, node first.
function ancestors(ctx: Ctx, id: string): Row[] {
  const out: Row[] = [];
  let cur = ctx.rows.get(id);
  while (cur) {
    if (out.includes(cur)) throw new Error("TREE_CYCLE");
    out.push(cur);
    cur = cur.parent_id ? ctx.rows.get(cur.parent_id) : undefined;
  }
  if (out.length === 0) throw new Error("NOT_FOUND");
  return out;
}

// The node itself and every node below it.
function subtreeRows(ctx: Ctx, id: string): Row[] {
  return [...ctx.rows.values()].filter((row) => ancestors(ctx, row.id).some((a) => a.id === id));
}

function osSkills(os: OsKind): string[] {
  switch (os) {
    case "ubuntu":
    case "debian":
      return ["linux-common", "debian-ubuntu"];
    case "proxmox":
      return ["linux-common", "debian-ubuntu", "proxmox"];
    case "windows":
      return ["windows-server"];
    default:
      return [];
  }
}

interface JumpRule {
  mode: JumpMode;
  from: string;
  target: string | null;
}

// The nearest non-inherit jump rule. A rule inherited from an ancestor that points
// at this very node is skipped (a bastion must not route through itself).
function jumpRule(ctx: Ctx, id: string): JumpRule {
  const path = ancestors(ctx, id);
  for (const row of path) {
    if (row.jump_mode === "inherit") continue;
    if (row.jump_mode === "via" && row.jump_node_id === id) {
      if (row.id === id) throw new Error("JUMP_CYCLE");
      continue;
    }
    return { mode: row.jump_mode, from: row.id, target: row.jump_node_id };
  }
  return { mode: "direct", from: path[path.length - 1].id, target: null };
}

function jumpChain(ctx: Ctx, id: string, stack: string[]): { chain: string[]; from: string } {
  if (stack.includes(id)) throw new Error("JUMP_CYCLE");
  const rule = jumpRule(ctx, id);
  if (rule.mode !== "via" || rule.target === null) return { chain: [], from: rule.from };
  const bastion = ctx.rows.get(rule.target);
  if (!bastion) throw new Error("NOT_FOUND");
  if (bastion.address === null) throw new Error("JUMP_NO_ADDRESS");
  const chain = [...jumpChain(ctx, rule.target, [...stack, id]).chain, rule.target];
  if (chain.length > MAX_JUMP_HOPS) throw new Error("JUMP_TOO_DEEP");
  return { chain, from: rule.from };
}

function resolveIn(ctx: Ctx, id: string): EffectiveNode {
  const path = ancestors(ctx, id);
  const node = path[0];
  const inherited = (field: "credential_id" | "user" | "port" | "shell") => path.find((row) => row[field] !== null);
  const cred = inherited("credential_id");
  const user = inherited("user");
  const port = inherited("port");
  const shell = inherited("shell");
  const { chain, from } = jumpChain(ctx, id, []);

  const skillSources = new Map<string, string>();
  for (const row of path) {
    for (const skill of ctx.skills.get(row.id) ?? []) {
      if (!skillSources.has(skill)) skillSources.set(skill, row.id);
    }
  }
  for (const skill of osSkills(node.os)) {
    if (!skillSources.has(skill)) skillSources.set(skill, "os");
  }

  return {
    id,
    name: node.name,
    kind: node.kind,
    os: node.os,
    address: node.address ?? "",
    port: port?.port ?? DEFAULT_PORT,
    user: user?.user ?? null,
    shell: shell?.shell ?? (node.os === "windows" ? "powershell" : "bash"),
    credentialId: cred?.credential_id ?? null,
    credentialFrom: cred?.id ?? null,
    jumpFrom: from,
    jumpChain: chain,
    skillSources: Object.fromEntries(skillSources),
    notesChain: [...path].reverse().flatMap((row) => (row.notes ? [row.notes] : [])),
  };
}

function toNode(row: Row, skills: string[]): InventoryNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    name: row.name,
    os: row.os,
    address: row.address,
    port: row.port,
    user: row.user,
    shell: row.shell,
    credentialId: row.credential_id,
    jumpMode: row.jump_mode,
    jumpNodeId: row.jump_node_id,
    notes: row.notes,
    skills,
    autopilotUntil: row.autopilot_until,
  };
}

// Every write runs this inside its transaction, so a broken route rolls the write back.
function validateSubtree(db: Database, id: string): void {
  const ctx = loadCtx(db);
  if (!ctx.rows.has(id)) throw new Error("NOT_FOUND");
  for (const row of subtreeRows(ctx, id)) {
    if (row.kind === "vm" && row.address === null) throw new Error("VM_NO_ADDRESS");
    resolveIn(ctx, row.id);
  }
}

function requireNode(db: Database, id: string): InventoryNode {
  const node = getNode(db, id);
  if (!node) throw new Error("NOT_FOUND");
  return node;
}

export function getNode(db: Database, id: string): InventoryNode | null {
  const ctx = loadCtx(db);
  const row = ctx.rows.get(id);
  return row ? toNode(row, ctx.skills.get(id) ?? []) : null;
}

export function getTree(db: Database): InventoryNode[] {
  const ctx = loadCtx(db);
  return [...ctx.rows.values()].map((row) => toNode(row, ctx.skills.get(row.id) ?? []));
}

export function resolveEffective(db: Database, id: string): EffectiveNode {
  return resolveIn(loadCtx(db), id);
}

export function createNode(db: Database, input: NodeInput): InventoryNode {
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.run(
      `INSERT INTO nodes (id, parent_id, kind, name, os, address, port, user, shell, credential_id, jump_mode, jump_node_id, notes, import_source, import_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.parentId,
        input.kind,
        input.name,
        input.os ?? "other",
        input.address ?? null,
        input.port ?? null,
        input.user ?? null,
        input.shell ?? null,
        input.credentialId ?? null,
        input.jumpMode ?? "inherit",
        input.jumpNodeId ?? null,
        input.notes ?? null,
        input.importSource ?? null,
        input.importKey ?? null,
      ],
    );
    validateSubtree(db, id);
  })();
  return requireNode(db, id);
}

export function updateNode(db: Database, id: string, patch: NodePatch): InventoryNode {
  db.transaction(() => {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of Object.keys(PATCH_COLUMNS) as (keyof NodePatch)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${PATCH_COLUMNS[key]} = ?`);
      values.push(value);
    }
    if (sets.length > 0) db.run(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
    validateSubtree(db, id);
  })();
  return requireNode(db, id);
}

export function moveNode(db: Database, id: string, parentId: string): InventoryNode {
  db.transaction(() => {
    if (subtreeRows(loadCtx(db), id).some((row) => row.id === parentId)) throw new Error("MOVE_CYCLE");
    db.run("UPDATE nodes SET parent_id = ? WHERE id = ?", [parentId, id]);
    validateSubtree(db, id);
  })();
  return requireNode(db, id);
}

export function setNodeSkills(db: Database, id: string, skillIds: string[]): InventoryNode {
  db.transaction(() => {
    db.run("DELETE FROM node_skills WHERE node_id = ?", [id]);
    for (const skillId of skillIds) {
      db.run("INSERT INTO node_skills (node_id, skill_id) VALUES (?, ?)", [id, skillId]);
    }
  })();
  return requireNode(db, id);
}

export function deleteNode(db: Database, id: string): void {
  db.transaction(() => {
    if (db.query<{ one: number }, [string]>("SELECT 1 AS one FROM nodes WHERE parent_id = ? LIMIT 1").get(id) !== null) {
      throw new Error("HAS_CHILDREN");
    }
    if (db.query<{ one: number }, [string]>("SELECT 1 AS one FROM nodes WHERE jump_node_id = ? LIMIT 1").get(id) !== null) {
      throw new Error("IS_JUMP_HOST");
    }
    db.run("DELETE FROM node_skills WHERE node_id = ?", [id]);
    db.run("DELETE FROM nodes WHERE id = ?", [id]);
  })();
}

export function descendants(db: Database, id: string): string[] {
  return subtreeRows(loadCtx(db), id)
    .filter((row) => row.id !== id)
    .map((row) => row.id);
}

// Nodes whose effective jump chain goes through `id`. A node that fails to resolve
// is skipped here; its error surfaces when the node itself is validated.
export function dependentsOfJump(db: Database, id: string): string[] {
  const ctx = loadCtx(db);
  const dependents: string[] = [];
  for (const nodeId of ctx.rows.keys()) {
    if (nodeId === id) continue;
    try {
      if (resolveIn(ctx, nodeId).jumpChain.includes(id)) dependents.push(nodeId);
    } catch {
      continue;
    }
  }
  return dependents;
}

export function findByAddress(db: Database, address: string, port = DEFAULT_PORT): InventoryNode | null {
  const row = db
    .query<{ id: string }, [string, number]>(
      `SELECT id FROM nodes WHERE address = ? AND COALESCE(port, ${DEFAULT_PORT}) = ? ORDER BY id LIMIT 1`,
    )
    .get(address, port);
  return row ? getNode(db, row.id) : null;
}
