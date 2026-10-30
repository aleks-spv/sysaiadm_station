import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { authHeaders } from "./opencode";
import type { LogLevel } from "./log";

// Supervises `opencode serve` as a child: allowlisted env, readiness probe, restart with backoff.
// stop() resolves only after the child has exited.
const READY_POLL_MS = 100;
const KILL_AFTER_MS = 5_000;
const STABLE_MS = 60_000;

export type ProcState = "starting" | "running" | "backoff" | "stopped";

export interface ProcStatus {
  state: ProcState;
  pid: number | null;
  restarts: number;
  lastExitCode: number | null;
  startedAt: number | null;
}

export interface ProcOptions {
  bin: string;
  port: number;
  home: string;
  infraDir: string;
  internalUrl: string;
  internalToken: string;
  // null when authMode=none: no OPENCODE_SERVER_PASSWORD is exported and no header is sent.
  password: string | null;
  onLine?: (source: "opencode", line: string, level: LogLevel) => void;
  readyTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface OpencodeProc {
  status(): ProcStatus;
  restart(): Promise<void>;
  stop(): Promise<void>;
  headers: Record<string, string> | undefined;
}

// The child never inherits process.env: master key and DB path stay in the parent.
export function childEnv(opts: Pick<ProcOptions, "home" | "password" | "internalUrl" | "internalToken">): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: opts.home,
    XDG_DATA_HOME: join(opts.home, "data"),
    XDG_CONFIG_HOME: join(opts.home, "config"),
    XDG_STATE_HOME: join(opts.home, "state"),
    XDG_CACHE_HOME: join(opts.home, "cache"),
    SYSADM_INTERNAL_URL: opts.internalUrl,
    SYSADM_INTERNAL_TOKEN: opts.internalToken,
  };
  if (opts.password !== null) env.OPENCODE_SERVER_PASSWORD = opts.password;
  return env;
}

function pipeLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): void {
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    if (buffer) onLine(buffer);
  })().catch(() => {});
}

export function startOpencode(opts: ProcOptions): OpencodeProc {
  mkdirSync(opts.home, { recursive: true });
  const env = childEnv(opts);
  const headers = opts.password === null ? undefined : authHeaders(opts.password);
  const minBackoff = opts.minBackoffMs ?? 1_000;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  const readyTimeout = opts.readyTimeoutMs ?? 30_000;
  const onLine = opts.onLine ?? (() => {});

  let current: ReturnType<typeof Bun.spawn> | null = null;
  let state: ProcState = "stopped";
  let stopping = false;
  let restarts = 0;
  let lastExit: number | null = null;
  let startedAt: number | null = null;
  let delay = minBackoff;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const waitReady = async (proc: ReturnType<typeof Bun.spawn>) => {
    const deadline = Date.now() + readyTimeout;
    while (current === proc && Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${opts.port}/api/info`, { headers });
        if (res.ok) {
          if (current === proc) state = "running";
          return;
        }
      } catch {
        // not listening yet
      }
      await Bun.sleep(READY_POLL_MS);
    }
  };

  const scheduleRestart = () => {
    restarts++;
    state = "backoff";
    timer = setTimeout(() => {
      timer = undefined;
      launch();
    }, delay);
    delay = Math.min(delay * 2, maxBackoff);
  };

  const launch = () => {
    if (stopping) return;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([opts.bin, "serve", "--hostname", "127.0.0.1", "--port", String(opts.port)], {
        cwd: opts.infraDir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      // A missing or unexecutable binary must not take sysadm down: it backs off like any crash.
      onLine("opencode", `spawn failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      lastExit = -1;
      scheduleRestart();
      return;
    }
    const began = Date.now();
    current = proc;
    startedAt = began;
    state = "starting";
    pipeLines(proc.stdout as ReadableStream<Uint8Array>, (line) => onLine("opencode", line, "info"));
    pipeLines(proc.stderr as ReadableStream<Uint8Array>, (line) => onLine("opencode", line, "warn"));
    void waitReady(proc);
    void proc.exited.then((code) => {
      if (current !== proc) return; // stopped or restarted on purpose
      current = null;
      lastExit = code;
      if (stopping) {
        state = "stopped";
        return;
      }
      if (Date.now() - began >= STABLE_MS) delay = minBackoff;
      scheduleRestart();
    });
  };

  // SIGTERM, then SIGKILL after 5 s; resolves once the child is gone.
  const terminate = async (proc: ReturnType<typeof Bun.spawn>) => {
    current = null;
    proc.kill("SIGTERM");
    const force = setTimeout(() => proc.kill("SIGKILL"), KILL_AFTER_MS);
    await proc.exited;
    clearTimeout(force);
  };

  launch();

  return {
    headers,
    status: (): ProcStatus => ({
      state,
      pid: current?.pid ?? null,
      restarts,
      lastExitCode: lastExit,
      startedAt,
    }),
    restart: async () => {
      if (stopping) return;
      clearTimeout(timer);
      timer = undefined;
      if (current) await terminate(current);
      launch();
    },
    stop: async () => {
      stopping = true;
      clearTimeout(timer);
      timer = undefined;
      if (current) await terminate(current);
      state = "stopped";
    },
  };
}
