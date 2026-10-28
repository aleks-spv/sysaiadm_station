import type { ImportGroup, ImportHost, ImportTree } from "@sysadm/shared";
import { ImportError } from "./error";

// Text only: dynamic inventory scripts are never executed.
// Never read: ansible_password, ansible_ssh_pass, ansible_become_pass.
type Vars = Record<string, string>;

interface Builder {
  groups: Map<string, { vars: Vars; parent: string | null }>;
  hosts: Map<string, { vars: Vars; groups: string[] }>;
  warnings: string[];
}

const newBuilder = (): Builder => ({ groups: new Map(), hosts: new Map(), warnings: [] });

function ensureGroup(b: Builder, name: string, parent: string | null): void {
  const g = b.groups.get(name);
  if (!g) b.groups.set(name, { vars: {}, parent });
  else if (g.parent === null) g.parent = parent;
}

function addHost(b: Builder, name: string, vars: Vars, group: string | null): void {
  const h = b.hosts.get(name);
  if (!h) {
    b.hosts.set(name, { vars, groups: group ? [group] : [] });
  } else if (group && !h.groups.includes(group)) {
    h.groups.push(group);
  }
}

export function parseAnsible(content: string): ImportTree {
  const first = content
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("#") && !s.startsWith(";"));
  let yamlDoc: unknown = null;
  if (first && !first.startsWith("[")) {
    try {
      yamlDoc = Bun.YAML.parse(content);
    } catch {
      yamlDoc = null;
    }
  }
  const b = newBuilder();
  if (yamlDoc && typeof yamlDoc === "object") fromYaml(b, yamlDoc as Record<string, unknown>);
  else fromIni(b, content);
  return toTree(b);
}

function fromIni(b: Builder, content: string): void {
  let section: { name: string; kind: "hosts" | "vars" | "children" } | null = null;
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s[#;].*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      const h = header[1];
      if (h.endsWith(":vars")) section = { name: h.slice(0, -5), kind: "vars" };
      else if (h.endsWith(":children")) section = { name: h.slice(0, -9), kind: "children" };
      else section = { name: h, kind: "hosts" };
      ensureGroup(b, section.name, null);
      continue;
    }

    if (section?.kind === "vars") {
      const g = b.groups.get(section.name);
      if (g) Object.assign(g.vars, parseKv(line));
    } else if (section?.kind === "children") {
      ensureGroup(b, line, section.name);
    } else {
      const name = line.split(/\s+/)[0];
      addHost(b, name, parseKv(line.slice(name.length)), section?.name ?? null);
    }
  }
}

// key=value pairs; values may be quoted with ' or " and contain spaces.
function parseKv(text: string): Vars {
  const out: Vars = {};
  for (const m of text.matchAll(/([\w.-]+)=(?:'([^']*)'|"([^"]*)"|(\S+))/g)) {
    out[m[1]] = m[2] ?? m[3] ?? m[4];
  }
  return out;
}

function fromYaml(b: Builder, doc: Record<string, unknown>): void {
  const all = (doc.all ?? doc) as Record<string, unknown>;
  if (all.vars) b.warnings.push("all:vars ignored");
  const walk = (name: string, node: Record<string, unknown> | null, parent: string | null): void => {
    ensureGroup(b, name, parent);
    if (!node) return;
    const g = b.groups.get(name)!;
    Object.assign(g.vars, stringify(node.vars));
    for (const [hostName, hv] of Object.entries((node.hosts ?? {}) as Record<string, unknown>)) {
      addHost(b, hostName, stringify(hv), name);
    }
    for (const [childName, child] of Object.entries((node.children ?? {}) as Record<string, unknown>)) {
      walk(childName, (child ?? null) as Record<string, unknown> | null, name);
    }
  };
  for (const [name, node] of Object.entries((all.children ?? {}) as Record<string, unknown>)) {
    walk(name, (node ?? null) as Record<string, unknown> | null, null);
  }
  for (const hostName of Object.keys((all.hosts ?? {}) as Record<string, unknown>)) {
    addHost(b, hostName, stringify((all.hosts as Record<string, unknown>)[hostName]), null);
  }
}

function stringify(v: unknown): Vars {
  if (!v || typeof v !== "object") return {};
  const out: Vars = {};
  for (const [k, val] of Object.entries(v)) if (val !== null && val !== undefined) out[k] = String(val);
  return out;
}

function toTree(b: Builder): ImportTree {
  const groups: ImportGroup[] = [];
  for (const [name, g] of b.groups) {
    groups.push({
      key: name,
      name,
      parentKey: g.parent,
      user: g.vars.ansible_user || undefined,
      port: g.vars.ansible_port ? Number(g.vars.ansible_port) : undefined,
    });
  }

  const hosts: ImportHost[] = [];
  for (const [name, h] of b.hosts) {
    if (h.groups.length > 1) b.warnings.push(`${name} also in ${h.groups.slice(1).join(", ")}`);
    const v = h.vars;
    const windows = v.ansible_connection === "winrm" || v.ansible_connection === "psrp" || v.ansible_shell_type === "powershell";
    const proxy = v.ansible_ssh_common_args?.match(/ProxyJump=(\S+)|-J\s*(\S+)/);
    const jump = proxy ? (proxy[1] ?? proxy[2]) : undefined;
    hosts.push({
      key: name,
      name,
      address: v.ansible_host || name,
      port: windows ? 22 : Number(v.ansible_port) || 22,
      user: v.ansible_user || undefined,
      os: windows ? "windows" : "other",
      parentKey: h.groups[0] ?? null,
      jumpRef: jump ? { raw: jump } : undefined,
      keyPathHint: v.ansible_ssh_private_key_file || undefined,
    });
  }

  if (groups.length === 0 && hosts.length === 0) throw new ImportError("no hosts found in Ansible inventory");
  return { source: "ansible", groups, hosts, warnings: b.warnings };
}
