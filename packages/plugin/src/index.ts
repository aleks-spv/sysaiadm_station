import type { Plugin } from "@opencode/plugin";

// Tools the model may see. Everything else is removed from the context hook.
export const ALLOW = new Set(["remote_exec", "skill", "question", "read", "glob", "grep"]);

type Verdict = {
  verdict: "deny" | "dangerous" | "normal";
  reason?: string;
  node?: string;
  address?: string;
  via?: string[];
  autopilot?: boolean;
};

type ExecResult = { exitCode: number; stdout: string; stderr: string; truncated: boolean };

const SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1, maxLength: 4096 },
    timeoutSec: { type: "integer", minimum: 1, maximum: 600 },
  },
  required: ["command"],
  additionalProperties: false,
};

const DESCRIPTION =
  "выполняет команду на сервере этой сессии по SSH (при необходимости через бастион); на Windows — PowerShell";

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

    await ctx.tool.transform((draft) => {
      draft.add({
        name: "remote_exec",
        description: DESCRIPTION,
        input: SCHEMA,
        execute: async (input, context) => {
          const { command, timeoutSec } = input as { command: string; timeoutSec?: number };

          const check = await post<Verdict>("/internal/check", { sessionID: context.sessionID, command }, context.signal);
          if (check.verdict === "deny") throw new Error(check.reason ?? "command denied by policy");

          const dangerous = check.verdict === "dangerous";
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: dangerous ? "remote_exec_dangerous" : "remote_exec",
            resources: [command],
            save: dangerous ? [] : [`${command.trim().split(/\s+/)[0]} *`],
            metadata: { node: check.node, address: check.address, via: check.via },
          });

          await context.progress({ status: command });
          const res = await post<ExecResult>(
            "/internal/exec",
            { sessionID: context.sessionID, command, timeoutSec, toolCallId: context.id },
            context.signal,
          );
          const content = [
            `exit=${res.exitCode}`,
            "--- stdout ---",
            res.stdout,
            "--- stderr ---",
            res.stderr,
            res.truncated ? "[output truncated]" : "",
          ].join("\n");
          return { content };
        },
      });
    });

    await ctx.session.hook("context", (e) => {
      for (const key of Object.keys(e.tools)) if (!ALLOW.has(key)) delete e.tools[key];
    });
  },
};
