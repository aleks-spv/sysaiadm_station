import type { ChatCommand, Credential, EffectiveNode, ImportPreview, ImportSource, InventoryNode, JumpMode, NodeFacts, OsKind, ShellKind, Task, TaskStatus } from "@sysadm/shared";

export interface NodeDetail {
  node: InventoryNode;
  effective: EffectiveNode | null;
  routeError: string | null;
  facts: NodeFacts | null;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  builtin: boolean;
  // "github:owner/repo@ref:path" for skills installed from GitHub.
  source?: string | null;
  // An original ships with the image: an edited copy (builtin false) can be reset to it.
  shipped?: boolean;
}

export interface SkillScan {
  owner: string;
  repo: string;
  ref: string;
  skills: Array<{ path: string; id: string; name: string; description: string; exists: boolean }>;
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

// Fired after any saved change to settings (providers, models, agents, commands, skills, credentials, search),
// so open pages re-read their lists instead of waiting for a reload.
export const CONFIG_CHANGED = "sysadm:config-changed";
const CONFIG_PATH = /^\/api\/(settings\/|commands$|skills|credentials)/;

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
  if (method !== "GET" && CONFIG_PATH.test(path)) window.dispatchEvent(new Event(CONFIG_CHANGED));
  return data as T;
}

export const api = {
  authStatus: () => request<{ setup: boolean; authed: boolean; dev: boolean }>("GET", "/api/auth/status"),
  setup: (password: string) => request<{ otpauth: string }>("POST", "/api/auth/setup", { password }),
  login: (password: string, code: string) => request<{ ok: true }>("POST", "/api/auth/login", { password, code }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),

  tree: () => request<InventoryNode[]>("GET", "/api/tree"),
  node: (id: string) => request<NodeDetail>("GET", `/api/nodes/${id}`),
  collectFacts: (id: string) => request<NodeFacts>("POST", `/api/nodes/${id}/facts`),
  commands: () => request<{ commands: ChatCommand[]; defaults: ChatCommand[]; reserved: string[] }>("GET", "/api/commands"),
  saveCommands: (commands: ChatCommand[]) => request<{ commands: ChatCommand[] }>("PUT", "/api/commands", { commands }),
  createNode: (body: { kind: string; name: string; parentId: string | null } & NodeFields) =>
    request<InventoryNode>("POST", "/api/nodes", body),
  updateNode: (id: string, fields: NodeFields) => request<InventoryNode>("PATCH", `/api/nodes/${id}`, fields),
  moveNode: (id: string, parentId: string | null) => request<InventoryNode>("POST", `/api/nodes/${id}/move`, { parentId }),
  deleteNode: (id: string, recursive = false) => request<{ ok: true }>("DELETE", `/api/nodes/${id}${recursive ? "?recursive=1" : ""}`),
  resetHostKey: (id: string) => request<{ ok: true }>("POST", `/api/nodes/${id}/reset-hostkey`),
  setNodeSkills: (id: string, skills: string[]) => request<{ ok: true }>("PUT", `/api/nodes/${id}/skills`, { skills }),

  skills: () => request<Skill[]>("GET", "/api/skills"),
  createSkill: (body: { id: string; name: string; description: string; content: string }) =>
    request<Skill>("POST", "/api/skills", body),
  updateSkill: (id: string, body: { name: string; description: string; content: string }) => request<{ id: string }>("PUT", `/api/skills/${id}`, body),
  deleteSkill: (id: string) => request<{ ok: true }>("DELETE", `/api/skills/${id}`),
  resetSkill: (id: string) => request<{ id: string }>("POST", `/api/skills/${id}/reset`),
  scanSkills: (repo: string, ref?: string) => request<SkillScan>("POST", "/api/skills/github/scan", { repo, ref: ref || undefined }),
  installSkills: (repo: string, ref: string, paths: string[]) =>
    request<{ installed: string[]; updated: string[]; skipped: Array<{ id: string; reason: string }> }>("POST", "/api/skills/github/install", { repo, ref, paths }),

  audit: (params: { nodeId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.nodeId) q.set("nodeId", params.nodeId);
    if (params.limit) q.set("limit", String(params.limit));
    return request<AuditRow[]>("GET", `/api/audit?${q.toString()}`);
  },

  credentials: () => request<Credential[]>("GET", "/api/credentials"),
  createCredential: (body: { name: string; type: "key" | "password"; user?: string; privateKey?: string; passphrase?: string; password?: string }) =>
    request<Credential>("POST", "/api/credentials", body),
  deleteCredential: (id: string) => request<{ ok: true }>("DELETE", `/api/credentials/${id}`),

  tasks: (status?: TaskStatus) => request<Task[]>("GET", status ? `/api/tasks?status=${status}` : "/api/tasks"),
  archivedTasks: () => request<Task[]>("GET", "/api/tasks?archived=1"),
  archiveTask: (id: string) => request<Task>("POST", `/api/tasks/${id}/archive`),
  unarchiveTask: (id: string) => request<Task>("POST", `/api/tasks/${id}/unarchive`),
  taskRetention: () => request<{ days: number }>("GET", "/api/settings/task-retention"),
  setTaskRetention: (days: number) => request<{ days: number }>("PUT", "/api/settings/task-retention", { days }),
  task: (id: string, tail?: number) =>
    request<{ task: Task; messages: unknown[] }>("GET", `/api/tasks/${id}${tail ? `?tail=${tail}` : ""}`),
  createTask: (nodeId: string, body: { title: string; prompt: string; agent?: string; model?: { providerID: string; modelID: string } }) =>
    request<Task>("POST", `/api/nodes/${nodeId}/tasks`, body),
  promptTask: (id: string, text: string) => request<{ ok: true }>("POST", `/api/tasks/${id}/prompt`, { text }),
  stopTask: (id: string) => request<{ ok: true }>("POST", `/api/tasks/${id}/stop`),
  taskForms: (id: string) => request<AgentForm[]>("GET", `/api/tasks/${id}/forms`),
  replyForm: (id: string, formID: string, answer: FormAnswer) => request<{ ok: true }>("POST", `/api/tasks/${id}/forms/${formID}/reply`, { answer }),
  cancelForm: (id: string, formID: string) => request<{ ok: true }>("POST", `/api/tasks/${id}/forms/${formID}/cancel`),
  taskPins: (id: string) => request<{ messageId: string; text: string }[]>("GET", `/api/tasks/${id}/pins`),
  pin: (id: string, messageId: string, text: string) => request<{ ok: true }>("PUT", `/api/tasks/${id}/pins/${encodeURIComponent(messageId)}`, { text }),
  unpin: (id: string, messageId: string) => request<{ ok: true }>("DELETE", `/api/tasks/${id}/pins/${encodeURIComponent(messageId)}`),
  pendingPermissions: (id: string) => request<PendingPermission[]>("GET", `/api/tasks/${id}/permissions`),
  replyPermission: (id: string, requestID: string, decision: "once" | "always" | "reject") =>
    request<{ ok: true }>("POST", `/api/tasks/${id}/permissions/${requestID}`, { decision }),

  providers: () => request<{ data: ProviderInfo[] }>("GET", "/api/settings/providers"),
  setProviderKey: (id: string, key: string) => request<{ ok: true }>("POST", `/api/settings/providers/${id}/key`, { key }),
  disabledProviders: () => request<string[]>("GET", "/api/settings/disabled-providers"),
  setDisabledProviders: (providers: string[]) => request<string[]>("PUT", "/api/settings/disabled-providers", { providers }),
  models: () => request<{ data: ModelInfo[] }>("GET", "/api/settings/models"),
  agents: () => request<{ data: AgentInfo[] }>("GET", "/api/settings/agents"),
  integrations: () => request<{ data: IntegrationInfo[] }>("GET", "/api/settings/integrations"),
  opencodeConfig: () => request<{ overlay: OpencodeOverlay; locked: string[] }>("GET", "/api/settings/opencode-config"),
  saveOpencodeConfig: (overlay: OpencodeOverlay) => request<{ overlay: OpencodeOverlay }>("PUT", "/api/settings/opencode-config", { overlay }),
  opencodePlugins: () => request<{ data: OpencodePluginInfo[] }>("GET", "/api/settings/opencode-plugins"),
  hiddenModels: () => request<string[]>("GET", "/api/settings/hidden-models"),
  setHiddenModels: (models: string[]) => request<string[]>("PUT", "/api/settings/hidden-models", { models }),

  plugins: () => request<PluginInfo[]>("GET", "/api/plugins"),
  setPluginEnabled: (id: string, enabled: boolean) => request<PluginInfo>("PUT", `/api/plugins/${id}`, { enabled }),
  plugin: <T>(id: string, method: string, path: string, body?: unknown) => request<T>(method, `/api/plugins/${id}${path}`, body),
  agentsMd: (id: string) => request<{ content: string }>("GET", `/api/nodes/${id}/agents-md`),

  importPreview: (file: File, source: ImportSource, parentId: string | null) => {
    const form = new FormData();
    form.set("file", file);
    form.set("source", source);
    if (parentId) form.set("parentId", parentId);
    return fetchForm<ImportResult>("/api/import/preview", form);
  },
  importApply: (token: string, skipKeys: string[]) =>
    request<ApplyResult>("POST", "/api/import/apply", { token, skipKeys }),

  tokens: () => request<ApiToken[]>("GET", "/api/tokens"),
  createToken: (body: { name: string; scopes: string[]; ttlDays: number }) =>
    request<{ id: string; token: string; name: string; scopes: string[] }>("POST", "/api/tokens", body),
  revokeToken: (id: string) => request<{ ok: true }>("DELETE", `/api/tokens/${id}`),

  systemHealth: () => request<SystemHealth>("GET", "/api/system/health"),
  systemLogs: (params: { source?: string; level?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.source) q.set("source", params.source);
    if (params.level) q.set("level", params.level);
    if (params.limit) q.set("limit", String(params.limit));
    return request<LogEntry[]>("GET", `/api/system/logs?${q.toString()}`);
  },
  restartOpencode: () => request<{ ok: true }>("POST", "/api/system/opencode/restart"),
  exportInventory: (body: { rootId: string | null; withSecrets: boolean; passphrase: string }) =>
    request<unknown>("POST", "/api/inventory/export", body),
  importInventory: (file: File, passphrase: string, parentId: string | null) => {
    const form = new FormData();
    form.set("file", file);
    form.set("passphrase", passphrase);
    if (parentId) form.set("parentId", parentId);
    return fetchForm<{ nodes: number; credentials: number; warnings: string[] }>("/api/inventory/import", form);
  },
  backups: () => request<{ settings: BackupSettings; backups: BackupFile[] }>("GET", "/api/backups"),
  saveBackupSettings: (settings: BackupSettings) => request<BackupSettings>("PUT", "/api/backups/settings", settings),
  createBackup: () => request<BackupFile>("POST", "/api/backups"),
  deleteBackup: (name: string) => request<{ ok: true }>("DELETE", `/api/backups/${encodeURIComponent(name)}`),
  webSearch: () => request<WebSearchSettings>("GET", "/api/settings/websearch"),
  saveWebSearch: (settings: WebSearchSettings) => request<WebSearchSettings>("PUT", "/api/settings/websearch", settings),
  testWebSearch: (query: string) => request<{ provider: string; results: WebSearchResult[] }>("POST", "/api/settings/websearch/test", { query }),
  opencodeVersion: (refresh = false) => request<OpencodeVersion>("GET", `/api/system/opencode/version${refresh ? "?refresh=1" : ""}`),
  upgradeOpencode: () => request<OpencodeVersion>("POST", "/api/system/opencode/upgrade"),
};

// Subsets of the opencode V2 shapes the UI reads; the server passes them through unchanged.
export interface ModelInfo {
  id: string;
  providerID: string;
  name: string;
  enabled?: boolean;
  limit?: { context: number; output: number };
  variants?: Array<{ id: string }>;
}

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
  model?: { id: string; providerID: string };
  system?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  activation: "auto" | "enabled" | "disabled";
  package: string;
  settings?: Record<string, unknown>;
}

// Entry of the `agents` map in opencode.json (V2). model is "provider/model#variant".
export interface AgentConfig {
  description?: string;
  mode?: "primary" | "subagent" | "all";
  model?: string;
  system?: string;
  color?: string;
  steps?: number;
  hidden?: boolean;
  disabled?: boolean;
  request?: { body?: Record<string, unknown>; headers?: Record<string, string> };
}

// Entry of the `providers` map: a custom OpenAI-compatible endpoint such as a local llama.cpp.
export interface ProviderConfig {
  name?: string;
  package?: string;
  env?: string[];
  settings?: Record<string, unknown>;
  models?: Record<string, { name?: string; modelID?: string; limit?: { context?: number; output?: number }; disabled?: boolean }>;
  [key: string]: unknown;
}

export interface OpencodeOverlay {
  default_agent?: string;
  agents?: Record<string, AgentConfig>;
  providers?: Record<string, ProviderConfig>;
  plugins?: Array<string | { package: string }>;
  [key: string]: unknown;
}

export interface OpencodePluginInfo {
  id?: string;
  source: { type: "builtin" } | { type: "package"; target: string; version?: string } | { type: "local"; path: string } | { type: "sdk" };
  state: { status: "active" } | { status: "failed"; error: string };
}

// A sysadm plugin (extension), not an opencode one.
export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface IntegrationInfo {
  id: string;
  name: string;
  methods: Array<{ type: string; label?: string }>;
  connections: unknown[];
}

export interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface SystemHealth {
  version: string;
  uptimeSec: number;
  db: { ok: boolean; schemaVersion: number };
  opencode: { state: "starting" | "running" | "backoff" | "stopped"; pid: number | null; restarts: number; lastExitCode: number | null; startedAt: number | null };
  tasks: { running: number; waiting_permission: number };
}

export type WebSearchProvider = "off" | "searxng" | "exa" | "tavily" | "firecrawl" | "parallel" | "tinyfish";

export interface WebSearchSettings {
  provider: WebSearchProvider;
  searxngUrl: string | null;
  maxResults: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface BackupSettings {
  enabled: boolean;
  intervalHours: number;
  keep: number;
}

export interface BackupFile {
  name: string;
  size: number;
  createdAt: number;
}

export interface OpencodeVersion {
  mode: "managed" | "external";
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  busy: boolean;
  error: string | null;
  checkedAt: number | null;
}

export interface LogEntry {
  ts: number;
  source: "app" | "opencode";
  level: "info" | "warn" | "error";
  msg: string;
}

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

// A question from the agent (opencode V2 form). Subset of the V2 field shapes the UI renders.
interface FieldBase {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<{ key: string; op: "eq" | "neq"; value: string | number | boolean }>;
}
type FormOption = { value: string; label: string; description?: string };
export type FormField =
  | (FieldBase & { type: "string"; options?: FormOption[]; custom?: boolean; placeholder?: string; maxLength?: number; default?: string })
  | (FieldBase & { type: "number" | "integer"; default?: number | string })
  | (FieldBase & { type: "boolean"; default?: boolean })
  | (FieldBase & { type: "multiselect"; options: FormOption[]; custom?: boolean; default?: string[] })
  | { key: string; type: "external"; url: string; title?: string; description?: string };
export type FormAnswer = Record<string, string | number | boolean | string[]>;
export interface AgentForm {
  id: string;
  sessionID: string;
  title: string;
  fields: FormField[];
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
  // task.delta: streamed text of one content part, not yet in the message list.
  messageId?: string;
  ordinal?: number;
  part?: "text" | "reasoning";
  delta?: string;
}

const listeners = new Set<(event: TaskEvent) => void>();
let source: EventSource | null = null;

// One SSE stream shared by the whole app: every extra EventSource holds one of the browser's
// six HTTP/1.1 connections per host and starves the regular requests. Returns an unsubscribe function.
export function subscribeEvents(onEvent: (event: TaskEvent) => void): () => void {
  listeners.add(onEvent);
  if (!source) {
    source = new EventSource("/api/events");
    source.onmessage = (msg: MessageEvent<string>) => {
      let event: TaskEvent;
      try {
        event = JSON.parse(msg.data) as TaskEvent;
      } catch {
        return; // Ignore malformed frames; the next status change resyncs the view.
      }
      for (const fn of listeners) fn(event);
    };
    // A 401 closes the stream for good; check the session, then go to /login like request() does.
    source.onerror = () => {
      if (source?.readyState !== EventSource.CLOSED) return;
      api
        .authStatus()
        .then((s) => {
          if (!s.authed && window.location.pathname !== "/login") window.location.assign("/login");
        })
        .catch(() => {});
    };
  }
  return () => {
    listeners.delete(onEvent);
    if (listeners.size === 0) {
      source?.close();
      source = null;
    }
  };
}
