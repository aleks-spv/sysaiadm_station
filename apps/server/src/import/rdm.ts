import type { ImportGroup, ImportHost, ImportTree } from "@sysadm/shared";
import { ImportError } from "./error";

// Never read: Password, PasswordList, DefaultPassword, CredentialsMapping. Credential records are skipped.
interface RdmRecord {
  ID?: string;
  Name?: string;
  ConnectionType?: number | string;
  Host?: string;
  Url?: string;
  HostName?: string;
  Server?: string;
  Port?: number | string;
  Username?: string;
  UserName?: string;
  Description?: string;
  Group?: string;
  ParentID?: string;
}

const NUMERIC_TYPES: Record<number, string> = { 1: "rdp", 8: "putty", 25: "group", 26: "credential", 77: "sshshell", 100: "sftp" };
const SSH_TYPES = new Set(["putty", "sshshell", "sftp", "ssh"]);

const HINT = "RDM: File → Export → Export All (.json)";

// Number or token ConnectionType, normalised to a lowercase token.
const typeName = (r: RdmRecord): string =>
  typeof r.ConnectionType === "number"
    ? (NUMERIC_TYPES[r.ConnectionType] ?? "")
    : String(r.ConnectionType ?? "").toLowerCase();

export function parseRdm(content: string): ImportTree {
  let doc: { Connections?: RdmRecord[]; connections?: RdmRecord[]; Folders?: RdmRecord[]; folders?: RdmRecord[] };
  try {
    doc = JSON.parse(content);
  } catch {
    throw new ImportError(`not an RDM JSON export. ${HINT}`);
  }
  const connections = doc?.Connections ?? doc?.connections;
  const folders = doc?.Folders ?? doc?.folders;
  if (!Array.isArray(connections) && !Array.isArray(folders)) {
    throw new ImportError(`not an RDM JSON export. ${HINT}`);
  }

  const warnings: string[] = [];
  const groups = new Map<string, ImportGroup>();
  const idToPath = new Map<string, string>();

  // Group key = full backslash path, so the same path always yields the same group.
  const ensureGroup = (path: string): void => {
    if (groups.has(path)) return;
    const cut = path.lastIndexOf("\\");
    const parentKey = cut === -1 ? null : path.slice(0, cut);
    if (parentKey) ensureGroup(parentKey);
    groups.set(path, { key: path, name: path.slice(cut + 1), parentKey });
  };

  const addFolder = (r: RdmRecord): void => {
    const parent = r.Group || (r.ParentID ? idToPath.get(r.ParentID) : undefined);
    const path = parent ? `${parent}\\${r.Name ?? ""}` : (r.Name ?? "");
    ensureGroup(path);
    if (r.ID) idToPath.set(r.ID, path);
  };

  // Folders and group records first, so host paths can resolve ParentID.
  for (const r of folders ?? []) addFolder(r);
  for (const r of connections ?? []) if (typeName(r) === "group") addFolder(r);

  const hosts: ImportHost[] = [];
  for (const r of connections ?? []) {
    const raw = typeName(r);
    if (raw === "group") continue;
    if (raw === "credential") continue; // never imported, and no warning that could echo its content

    let os: ImportHost["os"];
    let port: number | undefined;
    if (raw === "rdp") {
      os = "windows";
      port = 22;
    } else if (SSH_TYPES.has(raw)) {
      os = "other";
      port = Number(r.Port) || 22;
    } else {
      warnings.push(`skipped ${r.Name ?? "unnamed"}: ${raw || "unknown type"}`);
      continue;
    }

    const parentPath = r.Group || (r.ParentID ? idToPath.get(r.ParentID) : undefined) || null;
    if (parentPath) ensureGroup(parentPath);
    const address = r.Host || r.Url || r.HostName || r.Server || "";
    hosts.push({
      key: r.ID ?? `${r.Name ?? address}@${address}`,
      name: r.Name || address,
      address,
      port,
      user: (r.Username || r.UserName) || undefined,
      os,
      parentKey: parentPath,
      notes: r.Description || undefined,
    });
  }

  return { source: "rdm", groups: [...groups.values()], hosts, warnings };
}
