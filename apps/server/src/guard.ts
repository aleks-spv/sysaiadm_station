import type { Database } from "bun:sqlite";
import { isReadOnly } from "./readonly";

export type Verdict = "deny" | "read" | "dangerous" | "normal";

// Best-effort only: regexes over the whole command line, case-insensitive. Not a shell parser.
const DENY = [
  /rm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/i,
  /\bmkfs(\.|\s)/i,
  /\bdd\b.*\bof=\/dev\/(sd|nvme|vd)/i,
  /:\(\)\s*\{/,
  />\s*\/dev\/(sd|nvme|vd)/i,
  /Format-Volume/i,
  /Remove-Item\s+.*C:\\?\s*-Recurse/i,
];

const DANGEROUS = [
  /\b(reboot|shutdown|poweroff|halt)\b/i,
  /Restart-Computer|Stop-Computer/i,
  /\bqm\s+(destroy|stop)\b/i,
  /\bpct\s+(destroy|stop)\b/i,
  /\bsystemctl\s+(stop|disable|mask)\b/i,
  /\bapt(-get)?\s+(remove|purge|dist-upgrade)\b/i,
  /\bzfs\s+destroy\b/i,
  /\biptables\b|\bnft\b|\bufw\b/i,
  // obfuscation markers: anything that can hide what actually runs
  /base64\s+(-d|--decode)/i,
  /\beval\b/i,
  /\b(ba)?sh\s+-c\b/i,
  /\|\s*(ba)?sh\b/i,
  /\$\(/,
  /`/,
  /\biex\b|Invoke-Expression/i,
  /-EncodedCommand|-enc\b/i,
  /\b(curl|wget)\b.*\|/i,
  /\bpython3?\s+-c\b/i,
  /\bperl\s+-e\b/i,
];

export interface GuardExtra {
  deny?: RegExp[];
  dangerous?: RegExp[];
}

export function classify(command: string, extra: GuardExtra = {}): Verdict {
  if ([...DENY, ...(extra.deny ?? [])].some((re) => re.test(command))) return "deny";
  const extraDangerous = (extra.dangerous ?? []).some((re) => re.test(command));
  // Before DANGEROUS on purpose: `iptables -L` and `ufw status` only read.
  if (!extraDangerous && isReadOnly(command)) return "read";
  if (extraDangerous || DANGEROUS.some((re) => re.test(command))) return "dangerous";
  return "normal";
}

const DETAIL_LIMIT = 4096;

export interface AuditEntry {
  actor: string;
  action: string;
  nodeId?: string | null;
  taskId?: string | null;
  detail?: unknown;
}

export function audit(db: Database, e: AuditEntry): void {
  const detail = e.detail === undefined ? null : JSON.stringify(e.detail).slice(0, DETAIL_LIMIT);
  db.run(
    "INSERT INTO audit (ts, actor, action, node_id, task_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
    [Date.now(), e.actor, e.action, e.nodeId ?? null, e.taskId ?? null, detail],
  );
}
