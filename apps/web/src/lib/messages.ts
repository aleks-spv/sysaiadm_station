// Reads opencode V2 session messages (session.context) defensively: unknown shapes are skipped.
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
  | { kind: "user"; id: string; text: string; time: number }
  | { kind: "text"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string; started: number | null; finished: number | null }
  | { kind: "tool"; id: string; call: ToolCall }
  | { kind: "error"; id: string; text: string };

export type StepItem = Extract<ChatItem, { kind: "reasoning" | "tool" }>;

// What the chat draws: consecutive reasoning and tool calls form one collapsible run of steps.
export type ChatBlock = Exclude<ChatItem, StepItem> | { kind: "steps"; id: string; steps: StepItem[] };

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

export function parseMessages(messages: unknown[]): ChatItem[] {
  const items: ChatItem[] = [];
  messages.forEach((raw, i) => {
    const m = obj(raw);
    if (!m) return;
    const id = str(m.id) || String(i);
    if (m.type === "user") {
      items.push({ kind: "user", id, text: str(m.text), time: num(obj(m.time)?.created) });
      return;
    }
    if (m.type !== "assistant") return;
    const content = Array.isArray(m.content) ? m.content : [];
    content.forEach((rawPart, j) => {
      const part = obj(rawPart);
      if (!part) return;
      const pid = `${id}:${j}`;
      if (part.type === "text" && str(part.text).trim()) items.push({ kind: "text", id: pid, text: str(part.text) });
      if (part.type === "reasoning" && str(part.text).trim()) {
        const t = obj(part.time);
        items.push({ kind: "reasoning", id: pid, text: str(part.text), started: time(t?.created), finished: time(t?.completed) });
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
  return items;
}

export function groupItems(items: ChatItem[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (const item of items) {
    if (item.kind === "reasoning" || item.kind === "tool") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "steps") last.steps.push(item);
      else blocks.push({ kind: "steps", id: item.id, steps: [item] });
    } else blocks.push(item);
  }
  return blocks;
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
