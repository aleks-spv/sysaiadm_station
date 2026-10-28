import type { ImportGroup, ImportHost, ImportTree } from "@sysadm/shared";
import { ImportError } from "./error";

// Passwords and password_source are never read. Only structure, addresses and hints are mapped.
interface RcGroup {
  id: string;
  name: string;
  parent_id?: string | null;
  username?: string;
  ssh_proxy_jump?: string;
}

interface RcConnection {
  id: string;
  name: string;
  host: string;
  port?: number;
  username?: string;
  group_id?: string | null;
  description?: string;
  tags?: string[];
  protocol_config?: {
    type?: string;
    jump_host_id?: string;
    proxy_jump?: string;
    key_path?: string;
  };
}

const SUPPORTED_VERSION = 3;

export function parseRustconn(content: string): ImportTree {
  let doc: { version?: number; connections?: RcConnection[]; groups?: RcGroup[] };
  try {
    doc = JSON.parse(content);
  } catch {
    throw new ImportError("not a RustConn .rcn file");
  }
  if (!doc || !Array.isArray(doc.connections) || !Array.isArray(doc.groups)) {
    throw new ImportError("not a RustConn .rcn file");
  }

  const warnings: string[] = [];
  if (typeof doc.version === "number" && doc.version > SUPPORTED_VERSION) {
    warnings.push(`unknown rcn version ${doc.version}, parsed anyway`);
  }

  const groups: ImportGroup[] = doc.groups.map((g) => ({
    key: g.id,
    name: g.name,
    parentKey: g.parent_id ?? null,
    user: g.username || undefined,
    jumpRef: g.ssh_proxy_jump ? { raw: g.ssh_proxy_jump } : undefined,
  }));

  const hosts: ImportHost[] = [];
  for (const c of doc.connections) {
    const type = c.protocol_config?.type ?? "";
    let os: ImportHost["os"];
    let port: number;
    if (type === "Ssh" || type === "Sftp") {
      os = "other";
      port = c.port ?? 22;
    } else if (type === "Rdp") {
      os = "windows";
      port = 22;
    } else {
      warnings.push(`skipped ${c.name}: ${type || "unknown protocol"}`);
      continue;
    }

    const pc: NonNullable<RcConnection["protocol_config"]> = c.protocol_config ?? {};
    const jumpRef = pc.jump_host_id
      ? { key: pc.jump_host_id }
      : pc.proxy_jump
        ? { raw: pc.proxy_jump }
        : undefined;
    const notes = [c.description, c.tags?.length ? `tags: ${c.tags.join(", ")}` : ""]
      .filter(Boolean)
      .join("\n");

    hosts.push({
      key: c.id,
      name: c.name,
      address: c.host,
      port,
      user: c.username || undefined,
      os,
      parentKey: c.group_id ?? null,
      jumpRef,
      notes: notes || undefined,
      keyPathHint: pc.key_path || undefined,
    });
  }

  return { source: "rustconn", groups, hosts, warnings };
}
