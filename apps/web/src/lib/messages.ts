// Reads opencode V2 session messages (message.list) defensively: unknown shapes are skipped.
// All text is rendered as plain text, never as HTML.

import { t } from "../i18n/app";

export interface ToolCall {
  id: string;
  name: string;
  status: "streaming" | "running" | "completed" | "error";
  command: string;
  // Whole tool result as the model saw it.
  output: string;
  // remote_exec result split back into its parts; exitCode is null for other tools or unparsed output.
  exitCode: number | null;
  stdout: string;
  stderr: string;
  // Trailing service lines: "[output truncated]", the compression note.
  notes: string[];
  raw: boolean;
  started: number | null;
  finished: number | null;
}

export type ChatItem =
  | { kind: "user"; id: string; messageId: string; text: string; time: number }
  | { kind: "text"; id: string; messageId: string; text: string; time: number }
  | { kind: "reasoning"; id: string; text: string; started: number | null; finished: number | null }
  | { kind: "tool"; id: string; call: ToolCall }
  | { kind: "error"; id: string; text: string };

export interface Usage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  // Prompt size of the latest step: what currently sits in the model's context window.
  lastContext: number;
  model: { providerID: string; id: string } | null;
  agent: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function toolText(state: Obj): string {
  const content = Array.isArray(state.content) ? state.content : [];
  const text = content.map((c) => (obj(c)?.type === "text" ? str(obj(c)?.text) : "")).filter(Boolean).join("\n");
  if (state.status === "error") return text || str(obj(state.error)?.message) || t("msg.error");
  return text;
}

// Splits the text remote_exec returns: "exit=N\n--- stdout ---\n…\n--- stderr ---\n…[\n[note]…]".
export function splitExec(output: string): Pick<ToolCall, "exitCode" | "stdout" | "stderr" | "notes"> | null {
  const m = /^exit=(-?\d+|null)\n--- stdout ---\n([\s\S]*?)\n--- stderr ---\n([\s\S]*)$/.exec(output);
  if (!m) return null;
  const tail = m[3].split("\n");
  const notes: string[] = [];
  while (tail.length && (tail[tail.length - 1] === "" || /^\[.*\]$/.test(tail[tail.length - 1]))) {
    const line = tail.pop()!;
    if (line) notes.unshift(line);
  }
  return { exitCode: m[1] === "null" ? null : Number(m[1]), stdout: m[2], stderr: tail.join("\n"), notes };
}

const time = (v: unknown): number | null => (num(v) > 0 ? num(v) : null);

function toolCommand(input: Obj | null): string {
  if (!input) return "";
  if (typeof input.command === "string") return input.command;
  return JSON.stringify(input);
}

// Key of a streamed part: opencode numbers text and reasoning parts separately within a message.
export const streamKey = (messageId: string, part: "text" | "reasoning", ordinal: number) => `${messageId}:${part}:${ordinal}`;

// `streamed` holds text from live deltas; it fills parts the message list still has empty
// and adds parts of messages the list does not show yet.
export function parseMessages(messages: unknown[], streamed: Record<string, string> = {}): ChatItem[] {
  const items: ChatItem[] = [];
  const used = new Set<string>();
  messages.forEach((raw, i) => {
    const m = obj(raw);
    if (!m) return;
    const id = str(m.id) || String(i);
    const created = num(obj(m.time)?.created);
    if (m.type === "user") {
      items.push({ kind: "user", id, messageId: id, text: str(m.text), time: created });
      return;
    }
    if (m.type !== "assistant") return;
    const content = Array.isArray(m.content) ? m.content : [];
    const ordinals = { text: 0, reasoning: 0 };
    content.forEach((rawPart, j) => {
      const part = obj(rawPart);
      if (!part) return;
      const pid = `${id}:${j}`;
      if (part.type === "text" || part.type === "reasoning") {
        const key = streamKey(id, part.type, ordinals[part.type]++);
        used.add(key);
        const text = str(part.text) || (streamed[key] ?? "");
        if (!text.trim()) return;
        // Stable id across streamed and stored states, so React keeps the node instead of remounting it.
        if (part.type === "text") items.push({ kind: "text", id: key, messageId: id, text, time: created });
        else {
          const t = obj(part.time);
          items.push({ kind: "reasoning", id: key, text, started: time(t?.created), finished: time(t?.completed) });
        }
      }
      if (part.type === "tool") {
        const state = obj(part.state) ?? {};
        const status = (["streaming", "running", "completed", "error"] as const).find((s) => s === state.status) ?? "running";
        const input = obj(state.input);
        const output = toolText(state);
        const t = obj(part.time);
        items.push({
          kind: "tool",
          id: pid,
          call: {
            id: str(part.id) || pid,
            name: str(part.name),
            status,
            command: toolCommand(input),
            output,
            ...(splitExec(output) ?? { exitCode: null, stdout: output, stderr: "", notes: [] }),
            raw: input?.raw === true,
            started: time(t?.ran) ?? time(t?.created),
            finished: time(t?.completed),
          },
        });
      }
    });
    const error = obj(m.error);
    if (error) items.push({ kind: "error", id: `${id}:error`, text: str(error.message) || t("msg.modelError") });
  });
  // Parts streaming ahead of the message list go last, in arrival order.
  for (const [key, text] of Object.entries(streamed)) {
    if (used.has(key) || !text.trim()) continue;
    const [messageId, part] = key.split(":");
    if (part === "text") items.push({ kind: "text", id: key, messageId, text, time: Date.now() });
    else items.push({ kind: "reasoning", id: key, text, started: null, finished: null });
  }
  return items;
}

// Puts a fresh tail of the history over the loaded one. Null when the tail does not reach the loaded
// messages (more arrived than the tail holds): then the whole history has to be read again.
export function mergeTail(prev: unknown[], tail: unknown[]): unknown[] | null {
  if (tail.length === 0) return prev.length === 0 ? tail : null;
  const first = str(obj(tail[0])?.id);
  const at = prev.findIndex((m) => str(obj(m)?.id) === first);
  if (at === -1) return null;
  // Unchanged messages keep their objects, so an idle refresh re-renders nothing.
  const merged = [...prev.slice(0, at), ...tail.map((m, i) => (JSON.stringify(m) === JSON.stringify(prev[at + i]) ? prev[at + i] : m))];
  return merged.length === prev.length && merged.every((m, i) => m === prev[i]) ? prev : merged;
}

export function usageOf(messages: unknown[]): Usage {
  const usage: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, lastContext: 0, model: null, agent: null };
  for (const raw of messages) {
    const m = obj(raw);
    if (m?.type !== "assistant") continue;
    const tokens = obj(m.tokens);
    const cache = obj(tokens?.cache);
    if (tokens) {
      usage.input += num(tokens.input);
      usage.output += num(tokens.output);
      usage.reasoning += num(tokens.reasoning);
      usage.cacheRead += num(cache?.read);
      usage.cacheWrite += num(cache?.write);
      usage.lastContext = num(tokens.input) + num(cache?.read) + num(cache?.write);
    }
    usage.cost += num(m.cost);
    const model = obj(m.model);
    if (model) usage.model = { providerID: str(model.providerID), id: str(model.id) };
    if (typeof m.agent === "string") usage.agent = m.agent;
  }
  return usage;
}

export function toolCalls(items: ChatItem[]): ToolCall[] {
  return items.flatMap((item) => (item.kind === "tool" ? [item.call] : []));
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

// The list a todowrite call sent; null while its input is still streaming or malformed.
export function todoList(call: ToolCall): TodoItem[] | null {
  try {
    const todos = obj(JSON.parse(call.command))?.todos;
    if (!Array.isArray(todos)) return null;
    return todos.flatMap((raw) => {
      const todo = obj(raw);
      const status = (["pending", "in_progress", "completed", "cancelled"] as const).find((s) => s === todo?.status);
      return todo && status && str(todo.content).trim() ? [{ content: str(todo.content).trim(), status }] : [];
    });
  } catch {
    return null;
  }
}

// The agent's current plan: the last todowrite call that went through.
export function latestTodos(calls: ToolCall[]): TodoItem[] | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].name === "todowrite" && calls[i].status === "completed") return todoList(calls[i]);
  }
  return null;
}
