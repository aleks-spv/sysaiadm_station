import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { TaskStatus } from "@sysadm/shared";
import { audit } from "../guard";
import { cancelForm, events, listForms, listPending, type OpenCodeClient } from "../opencode";
import { createQuestionGuard, questionGuard } from "../question-guard";

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
  // The question tool waits for the admin just like a permission does.
  "form.created": "waiting_permission",
  "form.replied": "running",
  "form.cancelled": "running",
};

// Events that mean new content appeared in the session (text, reasoning, tool output).
const MESSAGE_EVENTS = new Set([
  "session.step.started",
  "session.tool.input.started",
  "session.tool.called",
  "session.text.ended",
  "session.reasoning.ended",
  "session.tool.success",
  "session.tool.failed",
  "session.step.ended",
]);

// Streamed tokens: the message list holds a part's text only once the part ends, so these are relayed as is.
const DELTA_EVENTS: Record<string, "text" | "reasoning"> = {
  "session.text.delta": "text",
  "session.reasoning.delta": "reasoning",
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
  // form.created carries the whole form: data.form.sessionID.
  if ("data" in event && typeof event.data === "object" && event.data !== null && "form" in event.data) {
    const form = event.data.form as { sessionID?: unknown } | null;
    if (typeof form?.sessionID === "string") return form.sessionID;
  }
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
  guard?: ReturnType<typeof createQuestionGuard>;
}

function setStatusBySession(db: Database, sessionID: string, status: TaskStatus): string | null {
  const row = db.query<{ id: string; node_id: string }, [string]>("SELECT id, node_id FROM tasks WHERE session_id = ?").get(sessionID);
  if (!row) return null;
  db.run("UPDATE tasks SET status = ? WHERE id = ?", [status, row.id]);
  return row.id;
}

// A repeated or over-the-limit question is cancelled with a message for the model instead of reaching the admin.
async function autoAnswer(deps: Deps, sessionID: string, event: object): Promise<boolean> {
  const form = (event as { data: { form: { id: string; title?: string; fields?: [] } } }).data.form;
  const message = (deps.guard ?? questionGuard).created({ ...form, sessionID });
  if (message === null) return false;
  await cancelForm(deps.client, sessionID, form.id, message).catch(() => {});
  const row = deps.db.query<{ id: string; node_id: string }, [string]>("SELECT id, node_id FROM tasks WHERE session_id = ?").get(sessionID);
  if (row) audit(deps.db, { actor: "system", action: "question_auto", nodeId: row.node_id, taskId: row.id, detail: { formID: form.id } });
  return true;
}

// After a reconnect, events were lost: re-read pending permissions and questions and fix task status from them.
async function resync(deps: Deps): Promise<void> {
  const tasks = deps.db
    .query<{ session_id: string; id: string }, []>("SELECT session_id, id FROM tasks WHERE status IN ('running','idle','waiting_permission')")
    .all();
  for (const task of tasks) {
    const pending = await listPending(deps.client, task.session_id).catch(() => null);
    if (!pending) continue;
    const forms = await listForms(deps.client, task.session_id).catch(() => []);
    setStatusBySession(deps.db, task.session_id, pending.length + forms.length > 0 ? "waiting_permission" : "running");
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
          if (event.type === "form.created" && sessionID && (await autoAnswer(deps, sessionID, event))) continue;
          const status = STATUS_BY_EVENT[event.type];
          // Status changes reach browsers immediately; message events notify them to reload the conversation.
          if (sessionID && status) {
            const taskId = setStatusBySession(deps.db, sessionID, status);
            if (taskId) deps.bus.publish({ type: "task.status", taskId, status });
          }
          // New content (text, reasoning, tool) finished: tell the browser to refresh messages.
          if (sessionID && MESSAGE_EVENTS.has(event.type)) {
            const row = deps.db.query<{ id: string }, [string]>("SELECT id FROM tasks WHERE session_id = ?").get(sessionID);
            if (row) deps.bus.publish({ type: "task.message", taskId: row.id });
          }
          const part = DELTA_EVENTS[event.type];
          if (sessionID && part) {
            const data = (event as { data: { assistantMessageID?: unknown; ordinal?: unknown; delta?: unknown } }).data;
            const row = deps.db.query<{ id: string }, [string]>("SELECT id FROM tasks WHERE session_id = ?").get(sessionID);
            if (row && typeof data.assistantMessageID === "string" && typeof data.ordinal === "number" && typeof data.delta === "string") {
              deps.bus.publish({ type: "task.delta", taskId: row.id, messageId: data.assistantMessageID, ordinal: data.ordinal, part, delta: data.delta });
            }
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
