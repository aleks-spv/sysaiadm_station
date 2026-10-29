import type { Database } from "bun:sqlite";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EffectiveNode, InventoryNode, OsKind, ShellKind } from "@sysadm/shared";
import { dependentsOfJump, descendants, getNode, getTree, resolveEffective } from "./inventory";

const JUMP_ERRORS = ["JUMP_CYCLE", "JUMP_TOO_DEEP", "JUMP_NO_ADDRESS"];
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function safeId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error("BAD_ID");
  return id;
}

export function nodeDir(infraDir: string, nodeId: string): string {
  return join(infraDir, "nodes", safeId(nodeId));
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tmp, content);
  await rename(tmp, path);
}

async function pruneDir(dir: string, keep: Set<string>): Promise<void> {
  const entries = await readdir(dir).catch(() => []);
  for (const entry of entries) {
    if (!keep.has(entry)) await rm(join(dir, entry), { recursive: true, force: true });
  }
}

function treePath(byId: Map<string, InventoryNode>, id: string): string[] {
  const names: string[] = [];
  let cur = byId.get(id);
  while (cur) {
    names.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return names;
}

function defaultShell(os: OsKind): ShellKind {
  return os === "windows" ? "powershell" : "bash";
}

function agentsMd(
  node: InventoryNode,
  byId: Map<string, InventoryNode>,
  eff: EffectiveNode | null,
  routeError: string | null,
): string {
  const address = eff?.address || node.address || "не задан";
  const shell = eff?.shell ?? node.shell ?? defaultShell(node.os);
  let route: string;
  if (routeError) route = `Маршрут не настроен: ${routeError}`;
  else if (eff && eff.jumpChain.length > 0) {
    const bastions = eff.jumpChain.map((bid) => byId.get(bid)?.name ?? bid);
    route = `через бастион ${bastions.join(" → ")}`;
  } else route = "напрямую";
  const notes = eff?.notesChain.length ? eff.notesChain.join("\n\n") : "нет";

  return [
    `Ты сисадмин-агент. Сервер этой сессии: ${node.name}, ${address}, ОС ${node.os}, оболочка ${shell}.`,
    `Доступ: ${route}.`,
    "Команды выполняй только инструментом `remote_exec`. Локальной машины нет.",
    "",
    `Путь в дереве: ${treePath(byId, node.id).join(" / ")}`,
    "",
    "## Заметки",
    notes,
    "",
  ].join("\n");
}

export async function removeNode(infraDir: string, nodeId: string): Promise<void> {
  await rm(nodeDir(infraDir, nodeId), { recursive: true, force: true });
}

export async function materializeNode(db: Database, infraDir: string, nodeId: string): Promise<void> {
  const node = getNode(db, nodeId);
  if (!node) return removeNode(infraDir, nodeId);

  const byId = new Map(getTree(db).map((n) => [n.id, n]));
  let eff: EffectiveNode | null = null;
  let routeError: string | null = null;
  try {
    eff = resolveEffective(db, nodeId);
  } catch (err) {
    if (err instanceof Error && JUMP_ERRORS.includes(err.message)) routeError = err.message;
    else throw err;
  }

  const skills = new Map<string, string>();
  for (const skillId of eff ? Object.keys(eff.skillSources) : []) {
    const row = db.query<{ content: string }, [string]>("SELECT content FROM skills WHERE id = ?").get(safeId(skillId));
    if (row) skills.set(skillId, row.content);
  }

  const dir = nodeDir(infraDir, nodeId);
  await writeAtomic(join(dir, "AGENTS.md"), agentsMd(node, byId, eff, routeError));
  const skillsRoot = join(dir, ".opencode", "skills");
  for (const [skillId, content] of skills) {
    await writeAtomic(join(skillsRoot, skillId, "SKILL.md"), content);
  }
  await pruneDir(skillsRoot, new Set(skills.keys()));
}

// A node, its subtree, and every node whose jump chain goes through it.
export async function materializeSubtree(db: Database, infraDir: string, nodeId: string): Promise<void> {
  const ids = new Set([nodeId, ...descendants(db, nodeId), ...dependentsOfJump(db, nodeId)]);
  for (const id of ids) await materializeNode(db, infraDir, id);
}

export async function materializeAll(db: Database, infraDir: string): Promise<void> {
  const nodes = getTree(db);
  for (const node of nodes) await materializeNode(db, infraDir, node.id);
  await pruneDir(join(infraDir, "nodes"), new Set(nodes.map((n) => n.id)));
}
