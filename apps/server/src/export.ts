import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { JumpMode, NodeKind, OsKind, ShellKind } from "@sysadm/shared";
import { createNode, descendants, setNodeSkills, updateNode } from "./inventory";
import { open, seal } from "./vault";

// Inventory export: a JSON envelope whose body is AES-256-GCM under a key derived from the admin's passphrase.
// The file is useless without the passphrase, with or without secrets inside. Host keys are not exported:
// the new instance pins them again on first contact.
export const EXPORT_FORMAT = "sysaiadm-export";
export const MIN_PASSPHRASE = 12;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KINDS: NodeKind[] = ["company", "group", "hypervisor", "vm"];
const OSES: OsKind[] = ["ubuntu", "debian", "proxmox", "windows", "other"];
const JUMPS: JumpMode[] = ["inherit", "direct", "via"];

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: 1;
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  iv: string;
  tag: string;
  data: string;
}

interface ExportNode {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  name: string;
  os: OsKind;
  address: string | null;
  port: number | null;
  user: string | null;
  shell: ShellKind | null;
  credentialId: string | null;
  jumpMode: JumpMode;
  jumpNodeId: string | null;
  notes: string | null;
  skills: string[];
}

interface ExportCredential {
  id: string;
  name: string;
  type: "key" | "password";
  // The vault payload ({password} or {privateKey, passphrase?}); absent when exported without secrets.
  secret?: unknown;
}

export interface ExportPayload {
  exportedAt: number;
  withSecrets: boolean;
  nodes: ExportNode[];
  credentials: ExportCredential[];
}

export interface ImportResult {
  nodes: number;
  credentials: number;
  warnings: string[];
}

export class ExportError extends Error {}

function deriveKey(passphrase: string, salt: Buffer, kdf: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase, salt, 32, { ...kdf, maxmem: SCRYPT.maxmem });
}

export function encryptExport(payload: ExportPayload, passphrase: string): ExportFile {
  if (passphrase.length < MIN_PASSPHRASE) throw new ExportError(`пароль файла: не короче ${MIN_PASSPHRASE} символов`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt, SCRYPT), iv);
  cipher.setAAD(Buffer.from(EXPORT_FORMAT));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return {
    format: EXPORT_FORMAT,
    version: 1,
    kdf: { name: "scrypt", salt: salt.toString("base64"), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function decryptExport(raw: unknown, passphrase: string): ExportPayload {
  const file = raw as Partial<ExportFile> | null;
  if (!file || file.format !== EXPORT_FORMAT || file.version !== 1 || file.kdf?.name !== "scrypt") {
    throw new ExportError("это не файл экспорта SysAiAdm Station");
  }
  const { N, r, p } = file.kdf;
  // Bounds keep a crafted file from asking scrypt for gigabytes of memory.
  if (![N, r, p].every(Number.isInteger) || N < 2 ** 14 || N > 2 ** 17 || r < 1 || r > 16 || p < 1 || p > 4) {
    throw new ExportError("неподдерживаемые параметры шифрования файла");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, Buffer.from(file.kdf.salt, "base64"), { N, r, p }), Buffer.from(file.iv ?? "", "base64"));
    decipher.setAAD(Buffer.from(EXPORT_FORMAT));
    decipher.setAuthTag(Buffer.from(file.tag ?? "", "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(file.data ?? "", "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as ExportPayload;
  } catch {
    throw new ExportError("неверный пароль или файл повреждён");
  }
}

// rootId null exports the whole inventory; otherwise the node and everything below it.
export function buildExport(db: Database, masterKey: Buffer, rootId: string | null, withSecrets: boolean, now = Date.now()): ExportPayload {
  const rows = db
    .query<
      {
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
      },
      []
    >("SELECT id, parent_id, kind, name, os, address, port, user, shell, credential_id, jump_mode, jump_node_id, notes FROM nodes ORDER BY sort, name")
    .all();
  const keep = rootId === null ? null : new Set([rootId, ...descendants(db, rootId)]);
  const skills = new Map<string, string[]>();
  for (const { node_id, skill_id } of db.query<{ node_id: string; skill_id: string }, []>("SELECT node_id, skill_id FROM node_skills").all()) {
    skills.set(node_id, [...(skills.get(node_id) ?? []), skill_id]);
  }
  const nodes: ExportNode[] = rows
    .filter((r) => !keep || keep.has(r.id))
    .map((r) => ({
      id: r.id,
      parentId: r.id === rootId ? null : r.parent_id,
      kind: r.kind,
      name: r.name,
      os: r.os,
      address: r.address,
      port: r.port,
      user: r.user,
      shell: r.shell,
      credentialId: r.credential_id,
      jumpMode: r.jump_mode,
      jumpNodeId: r.jump_node_id,
      notes: r.notes,
      skills: skills.get(r.id) ?? [],
    }));
  const used = new Set(nodes.map((n) => n.credentialId).filter((id): id is string => id !== null));
  const credentials = db
    .query<{ id: string; name: string; type: "key" | "password"; ciphertext: Buffer; iv: Buffer; tag: Buffer }, []>(
      "SELECT id, name, type, ciphertext, iv, tag FROM credentials",
    )
    .all()
    .filter((c) => used.has(c.id))
    .map((c): ExportCredential => {
      const base = { id: c.id, name: c.name, type: c.type };
      if (!withSecrets) return base;
      return { ...base, secret: JSON.parse(open(masterKey, { ciphertext: c.ciphertext, iv: c.iv, tag: c.tag }, c.id).toString("utf8")) };
    });
  return { exportedAt: now, withSecrets, nodes, credentials };
}

// Creates everything under parentId with fresh ids, in one transaction: a bad file leaves no half-import behind.
export function applyExport(db: Database, masterKey: Buffer, payload: ExportPayload, parentId: string | null, now = Date.now()): ImportResult & { rootIds: string[] } {
  if (!Array.isArray(payload.nodes) || !Array.isArray(payload.credentials)) throw new ExportError("в файле нет списка узлов");
  for (const n of payload.nodes) {
    const bad = !KINDS.includes(n.kind) || !OSES.includes(n.os) || !JUMPS.includes(n.jumpMode) || typeof n.id !== "string" ||
      typeof n.name !== "string" || n.name.length === 0 || n.name.length > 200 || !Array.isArray(n.skills) ||
      (n.port !== null && (!Number.isInteger(n.port) || n.port < 1 || n.port > 65535)) ||
      (n.shell !== null && n.shell !== "bash" && n.shell !== "powershell");
    if (bad) throw new ExportError(`в файле некорректный узел «${String(n.name).slice(0, 60)}»`);
  }
  for (const cred of payload.credentials) {
    if (typeof cred.id !== "string" || typeof cred.name !== "string" || (cred.type !== "key" && cred.type !== "password")) {
      throw new ExportError("в файле некорректная учётка");
    }
  }
  const warnings: string[] = [];
  const credIds = new Map<string, string>();
  const nodeIds = new Map<string, string>();
  const rootIds: string[] = [];
  const knownSkills = new Set(db.query<{ id: string }, []>("SELECT id FROM skills").all().map((s) => s.id));
  let createdCreds = 0;

  db.transaction(() => {
    for (const cred of payload.credentials) {
      if (cred.secret !== undefined) {
        const id = crypto.randomUUID();
        const sealed = seal(masterKey, JSON.stringify(cred.secret), id);
        db.run("INSERT INTO credentials (id, name, type, ciphertext, iv, tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          id, cred.name, cred.type, sealed.ciphertext, sealed.iv, sealed.tag, now,
        ]);
        credIds.set(cred.id, id);
        createdCreds++;
        continue;
      }
      // Exported without secrets: reuse a credential with the same name and type if this instance has one.
      const local = db.query<{ id: string }, [string, string]>("SELECT id FROM credentials WHERE name = ? AND type = ? LIMIT 1").get(cred.name, cred.type);
      if (local) credIds.set(cred.id, local.id);
      else warnings.push(`учётка «${cred.name}» не найдена, узлы без неё унаследуют учётку от родителя`);
    }

    // Parents before children; jumps are set in a second pass, once every target exists.
    const pending = [...payload.nodes];
    while (pending.length > 0) {
      const index = pending.findIndex((n) => n.parentId === null || nodeIds.has(n.parentId));
      if (index < 0) throw new ExportError("в файле узел ссылается на отсутствующего родителя");
      const [n] = pending.splice(index, 1) as [ExportNode];
      const id = createNode(db, {
        parentId: n.parentId === null ? parentId : nodeIds.get(n.parentId)!,
        kind: n.kind,
        name: n.name,
        os: n.os,
        address: n.address,
        port: n.port,
        user: n.user,
        shell: n.shell,
        credentialId: n.credentialId ? (credIds.get(n.credentialId) ?? null) : null,
        notes: n.notes,
      }).id;
      nodeIds.set(n.id, id);
      if (n.parentId === null) rootIds.push(id);
      const skills = n.skills.filter((s) => knownSkills.has(s));
      if (skills.length) setNodeSkills(db, id, skills);
    }
    for (const n of payload.nodes) {
      if (n.jumpMode === "inherit") continue;
      const target = n.jumpNodeId ? nodeIds.get(n.jumpNodeId) : undefined;
      if (n.jumpMode === "via" && !target) {
        warnings.push(`«${n.name}»: бастион не входит в экспорт, маршрут унаследуется от родителя`);
        continue;
      }
      updateNode(db, nodeIds.get(n.id)!, { jumpMode: n.jumpMode, jumpNodeId: target ?? null });
    }
  })();

  return { nodes: nodeIds.size, credentials: createdCreds, warnings, rootIds };
}
