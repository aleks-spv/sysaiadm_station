import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { TaskStatus } from "@sysadm/shared";
import { events, listPending, type OpenCodeClient } from "../opencode";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// Status changes that a session event implies for its task.
const STATUS_BY_EVENT: Record<string, TaskStatus> = {
  "session.execution.started": "running",
  "session.idle": "idle",
  "session.execution.interrupted": "stopped",
  "session.execution.failed": "error",
  "permission.asked": "waiting_permission",
  "permission.replied": "running",
};

export interface Bus {
  publish(message: { type: string; [key: string]: unknown }): void;
  subscribe(fn: (data: string) => void): () => void;
}

export function createBus(): Bus {
  const subscribers = new Set<(data: string) => void>();
  return {
    publish(message) {
      const data = JSON.stringify(message);
      for (const fn of subscribers) fn(data);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

// Session id of an event: data.sessionID for most events, durable.aggregateID for execution events.
function sessionOf(event: object): string | undefined {
  if ("data" in event && typeof event.data === "object" && event.data !== null && "sessionID" in event.data) {
    return typeof event.data.sessionID === "string" ? event.data.sessionID : undefined;
  }
  if ("durable" in event && typeof event.durable === "object" && event.durable !== null && "aggregateID" in event.durable) {
    return typeof event.durable.aggregateID === "string" ? event.durable.aggregateID : undefined;
  }
  return undefined;
}

interface Deps {
  db: Database;
  client: OpenCodeClient;
  bus: Bus;
  sleep?: (ms: number) => Promise<void>;
}

function setStatusBySession(db: Database, sessionID: string, status: TaskStatus): string | null {
  const row = db.query<{ id: string; node_id: string }, [string]>("SELECT id, node_id FROM tasks WHERE session_id = ?").get(sessionID);
  if (!row) return null;
  db.run("UPDATE tasks SET status = ? WHERE id = ?", [status, row.id]);
  return row.id;
}

// After a reconnect, events were lost: re-read pending permissions and fix task status from them.
async function resync(deps: Deps): Promise<void> {
  const tasks = deps.db
    .query<{ session_id: string; id: string }, []>("SELECT session_id, id FROM tasks WHERE status IN ('running','idle','waiting_permission')")
    .all();
  for (const task of tasks) {
    const pending = await listPending(deps.client, task.session_id).catch(() => null);
    if (!pending) continue;
    setStatusBySession(deps.db, task.session_id, pending.length > 0 ? "waiting_permission" : "running");
  }
  deps.bus.publish({ type: "resync" });
}

// One background subscriber for the whole process. Reconnects with backoff, never replays.
export function startEventBridge(deps: Deps): () => void {
  const controller = new AbortController();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  void (async () => {
    let delay = BACKOFF_MIN_MS;
    while (!controller.signal.aborted) {
      try {
        for await (const event of events(deps.client, controller.signal)) {
          delay = BACKOFF_MIN_MS;
          const sessionID = sessionOf(event);
          const status = STATUS_BY_EVENT[event.type];
          // Only status changes reach browsers; text deltas stay server-side.
          if (sessionID && status) {
            const taskId = setStatusBySession(deps.db, sessionID, status);
            if (taskId) deps.bus.publish({ type: "task.status", taskId, status });
          }
        }
      } catch {
        // Fall through to backoff; the stream error is not surfaced to clients.
      }
      if (controller.signal.aborted) break;
      await sleep(delay);
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      await resync(deps).catch(() => {});
    }
  })();
  return () => controller.abort();
}

export function eventsRoutes(bus: Bus): Hono {
  const app = new Hono();
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = bus.subscribe((data) => {
        stream.writeSSE({ data }).catch(() => unsubscribe());
      });
      stream.onAbort(() => unsubscribe());
      await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
    }),
  );
  return app;
}
