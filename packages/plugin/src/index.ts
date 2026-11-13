import type { Plugin } from "@opencode/plugin";
import { applyWrite, DESCRIPTION as TODO_DESCRIPTION, isOpen, renderForModel, SCHEMA as TODO_SCHEMA, validate, type Todo } from "./todos";

// Tools the model may call. Calls to anything else are refused in the execute.before hook.
// compress comes from the bundled DCP plugin: it only rewrites the session's own history.
export const ALLOW = new Set(["remote_exec", "skill", "question", "web_search", "todowrite", "compress"]);
const SEARCH_REFRESH_MS = 15_000;
const STUB = "Not available in SysAiAdm Station. Never call this tool.";
// opencode 2.x puts plugin tools into Code Mode (behind `execute`, which the hook below refuses), so the model could not call them.
const DIRECT = { codemode: false } as const;

type Verdict = {
  verdict: "deny" | "read" | "dangerous" | "normal";
  reason?: string;
  node?: string;
  address?: string;
  via?: string[];
  autopilot?: boolean;
};

type ExecResult = { exitCode: number; stdout: string; stderr: string; truncated: boolean; note?: string };

const SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1, maxLength: 4096 },
    timeoutSec: { type: "integer", minimum: 1, maximum: 600 },
    raw: { type: "boolean", description: "полный вывод без сжатия; только если сжатый вывод скрыл нужное" },
  },
  required: ["command"],
  additionalProperties: false,
};

const DESCRIPTION =
  "выполняет команду на сервере этой сессии по SSH (при необходимости через бастион); на Windows — PowerShell";

const SEARCH_SCHEMA = {
  type: "object",
  properties: { query: { type: "string", minLength: 2, maxLength: 400 } },
  required: ["query"],
  additionalProperties: false,
};

const SEARCH_DESCRIPTION =
  "ищет в интернете документацию, release notes, известные ошибки и их решения; в запрос не включай адреса, имена серверов, клиентов и секреты";

export function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export default {
  id: "sysadm",
  async setup(ctx: Plugin.Context) {
    const baseUrl = requireEnv(process.env, "SYSADM_INTERNAL_URL");
    const token = requireEnv(process.env, "SYSADM_INTERNAL_TOKEN");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const post = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `sysadm responded ${res.status}`);
      return data;
    };

    // Whether the admin turned web search on; read by the synchronous hooks below.
    let searchOn = false;
    const refreshSearch = () =>
      fetch(`${baseUrl}/internal/websearch`, { headers })
        .then((r) => r.json() as Promise<{ enabled?: boolean }>)
        .then((d) => void (searchOn = d.enabled === true))
        .catch(() => void (searchOn = false));
    await refreshSearch();
    setInterval(() => void refreshSearch(), SEARCH_REFRESH_MS).unref?.();

    // shortcut: lists live in this process only; after an opencode restart the next write starts fresh ids,
    // the web still shows the last list from the history. Persist via ctx.storage if that ever matters.
    const todos = new Map<string, Todo[]>();

    await ctx.tool.transform((draft) => {
      draft.add({
        name: "todowrite",
        description: TODO_DESCRIPTION,
        input: TODO_SCHEMA,
        options: DIRECT,
        execute: async (input, context) => {
          const next = applyWrite(todos.get(context.sessionID) ?? [], validate(input), Date.now());
          todos.set(context.sessionID, next);
          return { content: renderForModel(next) };
        },
      });
      draft.add({
        name: "web_search",
        description: SEARCH_DESCRIPTION,
        input: SEARCH_SCHEMA,
        options: DIRECT,
        execute: async (input, context) => {
          const { query } = input as { query: string };
          await context.progress({ status: query });
          const res = await post<{ content: string }>("/internal/websearch", { sessionID: context.sessionID, query }, context.signal);
          return { content: res.content };
        },
      });
      draft.add({
        name: "remote_exec",
        description: DESCRIPTION,
        input: SCHEMA,
        options: DIRECT,
        execute: async (input, context) => {
          const { command, timeoutSec, raw } = input as { command: string; timeoutSec?: number; raw?: boolean };

          const check = await post<Verdict>("/internal/check", { sessionID: context.sessionID, command }, context.signal);
          if (check.verdict === "deny") throw new Error(check.reason ?? "command denied by policy");

          const dangerous = check.verdict === "dangerous";
          const action = check.verdict === "read" ? "remote_exec_read" : dangerous ? "remote_exec_dangerous" : "remote_exec";
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action,
            resources: [command],
            save: action === "remote_exec" ? [`${command.trim().split(/\s+/)[0]} *`] : [],
            metadata: { node: check.node, address: check.address, via: check.via },
          });

          await context.progress({ status: command });
          const res = await post<ExecResult>(
            "/internal/exec",
            { sessionID: context.sessionID, command, timeoutSec, raw, toolCallId: context.id },
            context.signal,
          );
          const content = [
            `exit=${res.exitCode}`,
            "--- stdout ---",
            res.stdout,
            "--- stderr ---",
            res.stderr,
            res.truncated ? "[output truncated]" : "",
            res.note ?? "",
          ].join("\n");
          return { content };
        },
      });
    });

    // Built-in tools stay in the model request (Zen refuses free models when the tool list is cut, 2026-11-13),
    // so the whitelist is enforced on the call instead; the base policies deny shell/edit/read/... as well.
    await ctx.tool.hook("execute.before", (e) => {
      if (!ALLOW.has(e.tool) || (e.tool === "web_search" && !searchOn))
        throw new Error(`Tool "${e.tool}" is not available in SysAiAdm Station. Use only: ${[...ALLOW].join(", ")}.`);
    });

    await ctx.session.hook("context", (e) => {
      // Names stay for Zen; descriptions and schemas shrink to a stub so the model spends no context on them.
      for (const key of Object.keys(e.tools))
        if (!ALLOW.has(key) || (key === "web_search" && !searchOn)) e.tools[key] = { description: STUB, input: { type: "object", properties: {} } };
      // After a compaction the model no longer sees its last todowrite call: give the open plan back.
      const list = todos.get(e.sessionID);
      if (!list || !isOpen(list)) return;
      const seen = e.messages.some((m) => m.content.some((part) => part.type === "tool-call" && part.name === "todowrite"));
      if (!seen) e.system.push({ type: "text", text: `# Current todo list\nYour plan for this task, as last written with todowrite:\n\n${renderForModel(list)}` });
    });
  },
};
