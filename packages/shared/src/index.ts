// Contract between server and web. Secret fields are intentionally absent.

export type NodeKind = "company" | "group" | "hypervisor" | "vm";
export type OsKind = "ubuntu" | "debian" | "proxmox" | "windows" | "other";
export type ShellKind = "bash" | "powershell";
export type JumpMode = "inherit" | "direct" | "via";

export interface InventoryNode {
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
  autopilotUntil: number | null;
}

export interface EffectiveNode {
  id: string;
  name: string;
  kind: NodeKind;
  os: OsKind;
  address: string;
  port: number;
  user: string | null;
  shell: ShellKind;
  credentialId: string | null;
  credentialFrom: string | null;
  jumpFrom: string | null;
  jumpChain: string[];
  skillSources: Record<string, string>;
  notesChain: string[];
}

export interface Credential {
  id: string;
  name: string;
  type: "key" | "password";
  // SSH login used when the node does not set its own.
  user: string | null;
  createdAt: number;
}

export type TaskStatus = "running" | "idle" | "waiting_permission" | "stopped" | "error";

export interface Task {
  id: string;
  nodeId: string;
  sessionID: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  archivedAt: number | null;
}

export interface ExecVerdict {
  verdict: "deny" | "read" | "dangerous" | "normal";
  reason?: string;
  node?: string;
  address?: string;
  via: string[];
  autopilot: boolean;
}

export type ImportSource = "rustconn" | "rdm" | "mremoteng" | "ansible";

export type JumpRef = { key: string } | { raw: string };

export interface ImportGroup {
  key: string;
  name: string;
  parentKey: string | null;
  user?: string;
  port?: number;
  jumpRef?: JumpRef;
}

export interface ImportHost {
  key: string;
  name: string;
  address: string;
  port?: number;
  user?: string;
  os: OsKind;
  parentKey: string | null;
  jumpRef?: JumpRef;
  notes?: string;
  keyPathHint?: string;
}

export interface ImportTree {
  source: ImportSource;
  groups: ImportGroup[];
  hosts: ImportHost[];
  warnings: string[];
}

export interface ImportPreview {
  items: Array<{
    key: string;
    kind: "company" | "group" | "vm";
    name: string;
    address?: string;
    parentKey: string | null;
    action: "create" | "skip";
    reason?: string;
  }>;
  warnings: string[];
}

// Server card (/init): hardware and network facts sysadm collects over SSH with a fixed script, no model involved.
export interface NodeFacts {
  collectedAt: number;
  hostname: string;
  os: string;
  kernel: string | null;
  uptimeSec: number | null;
  // "kvm", "vmware", "microsoft", "none"…; null when unknown.
  virtualization: string | null;
  vendor: string | null; // system manufacturer and product, e.g. "Dell Inc. PowerEdge R640"
  cpu: { model: string; sockets: number | null; cores: number | null; threads: number | null };
  memory: { totalBytes: number; availableBytes: number | null; swapBytes: number | null };
  disks: Array<{ name: string; model: string | null; sizeBytes: number; rotational: boolean | null }>;
  filesystems: Array<{ mount: string; fstype: string; sizeBytes: number; usedBytes: number }>;
  // Container and VM plumbing (docker0, br-*, veth*, tap*, fwbr*…) is left out.
  interfaces: Array<{ name: string; mac: string | null; up: boolean; addresses: string[] }>;
  gateway: string | null;
  dns: string[];
}

// Chat slash command: "/name args" sends the template with $ARGUMENTS replaced.
export interface ChatCommand {
  name: string;
  description: string;
  template: string;
  // Agent for a new task started by the command; null keeps the composer's choice.
  agent: string | null;
}
