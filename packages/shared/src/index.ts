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
}

export interface ExecVerdict {
  verdict: "deny" | "dangerous" | "normal";
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
    kind: "group" | "vm";
    name: string;
    address?: string;
    parentKey: string | null;
    action: "create" | "skip";
    reason?: string;
  }>;
  warnings: string[];
}
