import { XMLParser } from "fast-xml-parser";
import type { ImportGroup, ImportHost, ImportTree } from "@sysadm/shared";
import { ImportError } from "./error";

// Never read: the Password attribute and any encrypted fields.
interface MrNode {
  Id?: string;
  Name?: string;
  Type?: string;
  Hostname?: string;
  Port?: string;
  Username?: string;
  Descr?: string;
  Protocol?: string;
  Node?: MrNode | MrNode[];
}

const SSH_PROTOCOLS = new Set(["SSH1", "SSH2"]);

export function parseMremoteng(content: string): ImportTree {
  // Reject before parsing: DTD and entity declarations are how XXE and billion-laughs attacks arrive.
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) {
    throw new ImportError("XML with DOCTYPE or ENTITY declarations is refused");
  }

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", processEntities: false });
  let doc: { Connections?: { FullFileEncryption?: string } & MrNode };
  try {
    doc = parser.parse(content);
  } catch {
    throw new ImportError("not a mRemoteNG confCons.xml file");
  }
  const root = doc?.Connections;
  if (!root) throw new ImportError("not a mRemoteNG confCons.xml file");
  if (String(root.FullFileEncryption).toLowerCase() === "true") {
    throw new ImportError("encrypted file: export without encryption (mRemoteNG: Export without password)");
  }

  const groups: ImportGroup[] = [];
  const hosts: ImportHost[] = [];
  const warnings: string[] = [];
  let seq = 0;

  const walk = (node: MrNode, parentKey: string | null): void => {
    const children = node.Node === undefined ? [] : Array.isArray(node.Node) ? node.Node : [node.Node];
    for (const child of children) {
      const key = child.Id || `${parentKey ?? ""}/${child.Name ?? ""}#${seq++}`;
      const name = child.Name ?? "";
      if (child.Type === "Container") {
        groups.push({ key, name, parentKey });
        walk(child, key);
      } else if (child.Type === "Connection") {
        if (!child.Hostname) {
          warnings.push(`skipped ${name}: empty hostname`);
          continue;
        }
        const proto = (child.Protocol ?? "").toUpperCase();
        let os: ImportHost["os"];
        let port: number;
        if (SSH_PROTOCOLS.has(proto)) {
          os = "other";
          port = Number(child.Port) || 22;
        } else if (proto === "RDP") {
          os = "windows";
          port = 22;
        } else {
          warnings.push(`skipped ${name}: ${child.Protocol ?? "unknown protocol"}`);
          continue;
        }
        hosts.push({
          key,
          name,
          address: child.Hostname,
          port,
          user: child.Username || undefined,
          os,
          parentKey,
          notes: child.Descr || undefined,
        });
      }
    }
  };

  walk(root, null);
  return { source: "mremoteng", groups, hosts, warnings };
}
