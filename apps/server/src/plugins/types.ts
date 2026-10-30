import type { Database } from "bun:sqlite";
import type { InventoryNode, ShellKind, Task } from "@sysadm/shared";
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { LogLevel } from "../log";
import type { NodeShell } from "../shell";

export interface Sealed {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

export interface PluginTaskInput {
  nodeId: string;
  title: string;
  prompt: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  // Turns the node's autopilot on (4 h) before the task starts.
  autopilot?: boolean;
}

// What the host hands to a sysadm plugin. Plugins live in <repo>/plugins/<id> and import only this file from the app.
// They never touch process.env, the master key, SSH credentials or other plugins' state.
export interface PluginContext {
  id: string;
  db: Database;
  // Vault bound to this plugin: the aad is prefixed with the plugin id, the master key never leaves the host.
  encrypt(plaintext: string, aad: string): Sealed;
  decrypt(sealed: Sealed, aad: string): string;
  // Private directory for the plugin's files: <DATA_DIR>/plugins/<id> unless the plugin picks its own.
  dataDir: string;
  log(level: LogLevel, message: string): void;
  audit(actor: string, action: string, detail?: unknown, ref?: { nodeId?: string; taskId?: string }): void;
  // Append-only schema for the plugin's own tables; version is kept in settings `plugin_schema:<id>`.
  migrate(migrations: string[]): void;
  nodes: {
    get(id: string): InventoryNode | null;
    list(): InventoryNode[];
  };
  tasks: {
    // Starts an agent task exactly like the UI does; throws if opencode is unavailable.
    create(input: PluginTaskInput, actor: string): Promise<Task>;
    get(id: string): Task | null;
  };
  // Interactive SSH shell on a node through its bastion route; credentials stay in the host.
  ssh: {
    openShell(nodeId: string, cols: number, rows: number): Promise<NodeShell>;
  };
  upgradeWebSocket: UpgradeWebSocket;
}

// Output of one remote_exec, after the SSH run and before the model reads it.
export interface ExecOutputView {
  nodeId: string;
  taskId: string;
  command: string;
  shell: ShellKind;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface FilteredOutput {
  stdout: string;
  stderr: string;
  // One line appended for the model, e.g. how much was cut and how to get the raw output.
  note?: string;
}

export interface ServerPlugin {
  id: string;
  name: string;
  description: string;
  // Mounted at /api/plugins/<id>; only an admin cookie session reaches it, API tokens get 403.
  routes(ctx: PluginContext): Hono;
  // Background work while the plugin is enabled and the app runs with background=true. Returns its stop.
  start?(ctx: PluginContext): () => void | Promise<void>;
  // Rewrites command output for the model (e.g. compression). null keeps it as is; a throw is logged and ignored.
  filterOutput?(ctx: PluginContext, output: ExecOutputView): Promise<FilteredOutput | null>;
}
