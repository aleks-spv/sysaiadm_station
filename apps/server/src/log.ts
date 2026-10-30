export type LogSource = "app" | "opencode";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  source: LogSource;
  level: LogLevel;
  msg: string;
}

export interface LogQuery {
  source?: LogSource;
  level?: LogLevel;
  since?: number;
  limit?: number;
}

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;
const TOKEN_RE = /sat_[A-Za-z0-9_-]{20,}/g;
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Unset or empty means info; an unrecognised value returns null so the caller can warn instead of guessing.
export function parseLevel(value: string | undefined): LogLevel | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return "info";
  return v in ORDER ? (v as LogLevel) : null;
}

// In memory only: the buffer is lost on restart by design.
export function createLog({ capacity = 5000, secrets, minLevel = "info" }: { capacity?: number; secrets: string[]; minLevel?: LogLevel }) {
  const known = secrets.filter((s) => s.length > 0);
  const entries: LogEntry[] = [];

  const redact = (msg: string): string => {
    let out = msg;
    for (const secret of known) out = out.split(secret).join("[redacted]");
    return out.replace(PEM_RE, "[redacted]").replace(TOKEN_RE, "[redacted]");
  };

  return {
    write(source: LogSource, level: LogLevel, msg: string): void {
      if (ORDER[level] < ORDER[minLevel]) return;
      const clean = redact(msg);
      entries.push({ ts: Date.now(), source, level, msg: clean });
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
      const line = `[${level}] [${source}] ${clean}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    },
    query(q: LogQuery = {}): LogEntry[] {
      const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const matched = entries.filter(
        (e) => (q.source === undefined || e.source === q.source) && (q.level === undefined || e.level === q.level) && (q.since === undefined || e.ts >= q.since),
      );
      return matched.slice(-limit);
    },
  };
}

export type Log = ReturnType<typeof createLog>;
