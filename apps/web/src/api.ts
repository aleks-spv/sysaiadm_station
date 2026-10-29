import type { Credential, EffectiveNode, ImportPreview, ImportSource, InventoryNode, JumpMode, OsKind, ShellKind, Task, TaskStatus } from "@sysadm/shared";

export interface NodeDetail {
  node: InventoryNode;
  effective: EffectiveNode | null;
  routeError: string | null;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  nodeId: string | null;
  taskId: string | null;
  detail: unknown;
}

export interface NodeFields {
  name?: string;
  os?: OsKind;
  address?: string | null;
  port?: number | null;
  user?: string | null;
  shell?: ShellKind | null;
  credentialId?: string | null;
  jumpMode?: JumpMode;
  jumpNodeId?: string | null;
  notes?: string | null;
  autopilot?: boolean;
}

export interface ImportResult {
  token: string;
  preview: ImportPreview;
}

export interface ApplyResult {
  created: number;
  skipped: number;
  warnings: string[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

// The session is an HttpOnly cookie; the only client state is the CSRF-guard header.
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: { "X-Requested-With": "sysadm", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  if (res.status === 401 && !path.startsWith("/api/auth/") && window.location.pathname !== "/login") {
    window.location.assign("/login");
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = typeof (data as { error?: unknown })?.error === "string" ? (data as { error: string }).error : `HTTP ${res.status}`;
    throw new ApiError(res.status, code);
  }
  return data as T;
}

export const api = {
  authStatus: () => request<{ setup: boolean; authed: boolean }>("GET", "/api/auth/status"),
  setup: (password: string) => request<{ otpauth: string }>("POST", "/api/auth/setup", { password }),
  login: (password: string, code: string) => request<{ ok: true }>("POST", "/api/auth/login", { password, code }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),

  tree: () => request<InventoryNode[]>("GET", "/api/tree"),
  node: (id: string) => request<NodeDetail>("GET", `/api/nodes/${id}`),
  createNode: (body: { kind: string; name: string; parentId: string | null } & NodeFields) =>
    request<InventoryNode>("POST", "/api/nodes", body),
  updateNode: (id: string, fields: NodeFields) => request<InventoryNode>("PATCH", `/api/nodes/${id}`, fields),
  moveNode: (id: string, parentId: string | null) => request<InventoryNode>("POST", `/api/nodes/${id}/move`, { parentId }),
  deleteNode: (id: string) => request<{ ok: true }>("DELETE", `/api/nodes/${id}`),
  resetHostKey: (id: string) => request<{ ok: true }>("POST", `/api/nodes/${id}/reset-hostkey`),
  setNodeSkills: (id: string, skills: string[]) => request<{ ok: true }>("PUT", `/api/nodes/${id}/skills`, { skills }),

  skills: () => request<Skill[]>("GET", "/api/skills"),
  createSkill: (body: { id: string; name: string; description: string; content: string }) =>
    request<Skill>("POST", "/api/skills", body),
  deleteSkill: (id: string) => request<{ ok: true }>("DELETE", `/api/skills/${id}`),

  audit: (params: { nodeId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.nodeId) q.set("nodeId", params.nodeId);
    if (params.limit) q.set("limit", String(params.limit));
    return request<AuditRow[]>("GET", `/api/audit?${q.toString()}`);
  },

  credentials: () => request<Credential[]>("GET", "/api/credentials"),
  createCredential: (body: { name: string; type: "key" | "password"; privateKey?: string; passphrase?: string; password?: string }) =>
    request<Credential>("POST", "/api/credentials", body),
  deleteCredential: (id: string) => request<{ ok: true }>("DELETE", `/api/credentials/${id}`),

  tasks: (status?: TaskStatus) => request<Task[]>("GET", status ? `/api/tasks?status=${status}` : "/api/tasks"),
  task: (id: string) =>
    request<{ task: Task; messages: unknown[] }>("GET", `/api/tasks/${id}`),
  createTask: (nodeId: string, body: { title: string; prompt: string }) =>
    request<Task>("POST", `/api/nodes/${nodeId}/tasks`, body),
  promptTask: (id: string, text: string) => request<{ ok: true }>("POST", `/api/tasks/${id}/prompt`, { text }),
  stopTask: (id: string) => request<{ ok: true }>("POST", `/api/tasks/${id}/stop`),
  pendingPermissions: (id: string) => request<PendingPermission[]>("GET", `/api/tasks/${id}/permissions`),
  replyPermission: (id: string, requestID: string, decision: "once" | "always" | "reject") =>
    request<{ ok: true }>("POST", `/api/tasks/${id}/permissions/${requestID}`, { decision }),

  providers: () => request<unknown>("GET", "/api/settings/providers"),
  setProviderKey: (id: string, key: string) => request<{ ok: true }>("POST", `/api/settings/providers/${id}/key`, { key }),
  models: () => request<unknown>("GET", "/api/settings/models"),

  importPreview: (file: File, source: ImportSource, parentId: string | null) => {
    const form = new FormData();
    form.set("file", file);
    form.set("source", source);
    if (parentId) form.set("parentId", parentId);
    return fetchForm<ImportResult>("/api/import/preview", form);
  },
  importApply: (token: string, skipKeys: string[]) =>
    request<ApplyResult>("POST", "/api/import/apply", { token, skipKeys }),
};

// Multipart uploads cannot carry a JSON Content-Type, so the request is built here.
async function fetchForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-Requested-With": "sysadm" },
    body: form,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = typeof (data as { error?: unknown })?.error === "string" ? (data as { error: string }).error : `HTTP ${res.status}`;
    throw new ApiError(res.status, code);
  }
  return data as T;
}

export interface PendingPermission {
  id: string;
  action: string;
  resources: string[];
  metadata?: { node?: string; address?: string; via?: string[] };
}

export interface TaskEvent {
  type: string;
  taskId?: string;
  status?: TaskStatus;
}

// One SSE stream for the whole app. Returns an unsubscribe function.
export function subscribeEvents(onEvent: (event: TaskEvent) => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (msg: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(msg.data) as TaskEvent);
    } catch {
      // Ignore malformed frames; the next status change resyncs the view.
    }
  };
  return () => source.close();
}
