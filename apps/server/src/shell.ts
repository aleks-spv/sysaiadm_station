import type { Database } from "bun:sqlite";
import { getNode } from "./inventory";
import { pinHostKeys, planHops } from "./routes/internal";
import { HostKeyMismatch, openShell, SshHopError, type Hop, type ShellSession } from "./ssh";

export interface NodeShell {
  session: ShellSession;
  node: string;
  via: string[];
}

// Same route, credentials and host-key pinning as the agent's remote_exec, but an interactive PTY.
// Errors are short Russian messages for the terminal UI.
export async function openNodeShell(
  db: Database,
  masterKey: Buffer,
  nodeId: string,
  cols: number,
  rows: number,
  open: (input: { hops: Hop[]; cols: number; rows: number }) => Promise<ShellSession> = openShell,
): Promise<NodeShell> {
  if (!getNode(db, nodeId)) throw new Error("узел не найден");
  let planned: ReturnType<typeof planHops>;
  try {
    planned = planHops(db, masterKey, nodeId);
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (code === "NO_USER") throw new Error("у узла не задан пользователь SSH");
    if (code === "NO_CREDENTIAL" || code === "BAD_CREDENTIAL") throw new Error("у узла нет SSH-кредов");
    if (code.startsWith("JUMP_")) throw new Error(`маршрут через бастион не строится: ${code}`);
    throw err;
  }
  const { hops } = planned;
  const via = hops.slice(0, -1).map((h) => h.name);
  let session: ShellSession;
  try {
    session = await open({ hops: hops.map((h) => h.hop), cols, rows });
  } catch (err) {
    if (err instanceof HostKeyMismatch) throw new Error(`ключ хоста «${hops[err.hop]?.name}» изменился; сбросьте его в настройках узла, если это ожидаемо`);
    if (err instanceof SshHopError) throw new Error(`не удалось подключиться к «${hops[err.hop]?.name}»: ${err.message.replace(/^SSH_HOP_ERROR hop=\d+: /, "")}`);
    throw err;
  }
  const raced = pinHostKeys(db, hops, session.hostKeys);
  if (raced !== null) {
    session.close();
    throw new Error(`ключ хоста «${hops[raced]?.name}» не совпал с сохранённым`);
  }
  return { session, node: hops[hops.length - 1].name, via };
}
