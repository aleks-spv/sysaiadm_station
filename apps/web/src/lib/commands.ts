import type { ChatCommand } from "@sysadm/shared";
import { t } from "../i18n/app";

// Built into the chat, handled by the app instead of the agent.
export const BUILTIN_COMMANDS: Array<Pick<ChatCommand, "name" | "description">> = [
  { name: "init", description: t("cmd.init") },
];

export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], args: (m[2] ?? "").trim() } : null;
}

// $ARGUMENTS takes what follows the command; a template without it gets the arguments appended.
export function expandCommand(template: string, args: string): string {
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", args).trim();
  return args ? `${template.trim()}\n\n${args}` : template.trim();
}

// Popup suggestions while the first word is being typed: prefix matches first, then substring matches.
export function matchCommands<T extends { name: string; description: string }>(list: T[], query: string): T[] {
  const q = query.toLowerCase();
  const prefix = list.filter((c) => c.name.startsWith(q));
  const rest = list.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.description.toLowerCase().includes(q)));
  return [...prefix, ...rest];
}
