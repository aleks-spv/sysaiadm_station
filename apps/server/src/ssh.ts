import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { Client, type ClientChannel } from "ssh2";

const MAX_OUTPUT = 256 * 1024;
const READY_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export type Secret = { privateKey: string; passphrase?: string } | { password: string };

// Hops are ordered from the outermost bastion to the target.
export interface Hop {
  host: string;
  port: number;
  user: string;
  secret: Secret;
  knownHostKey: string | null;
}

export interface ExecInput {
  hops: Hop[];
  command: string;
  shell: "bash" | "powershell";
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  hostKeys: string[];
}

export class HostKeyMismatch extends Error {
  constructor(readonly hop: number) {
    super(`HOST_KEY_MISMATCH hop=${hop}`);
  }
}

export class SshHopError extends Error {
  constructor(
    readonly hop: number,
    message: string,
  ) {
    super(`SSH_HOP_ERROR hop=${hop}: ${message}`);
  }
}

export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function toExecCommand(shell: "bash" | "powershell", command: string): string {
  if (shell === "bash") return command;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

class Capture {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  push(data: Buffer): void {
    const room = MAX_OUTPUT - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const part = data.length > room ? data.subarray(0, room) : data;
    if (part.length < data.length) this.truncated = true;
    this.chunks.push(part);
    this.size += part.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function connectHop(
  hop: Hop,
  index: number,
  sock: Readable | undefined,
  clients: Client[],
): Promise<{ client: Client; hostKey: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    clients.push(client);
    let hostKey = "";
    let mismatch = false;
    client.on("ready", () => resolve({ client, hostKey }));
    client.on("error", (err) => reject(mismatch ? new HostKeyMismatch(index) : new SshHopError(index, err.message)));
    const auth =
      "password" in hop.secret
        ? { password: hop.secret.password }
        : { privateKey: hop.secret.privateKey, passphrase: hop.secret.passphrase };
    client.connect({
      host: hop.host,
      port: hop.port,
      username: hop.user,
      ...auth,
      sock,
      readyTimeout: READY_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        hostKey = fingerprint(key);
        if (hop.knownHostKey === null || hop.knownHostKey === hostKey) return true;
        mismatch = true;
        return false;
      },
    });
  });
}

function forward(client: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut("127.0.0.1", 0, host, port, (err, channel) => {
      if (err) reject(err);
      else resolve(channel);
    });
  });
}

function runCommand(client: Client, command: string, onChannel?: (channel: ClientChannel) => void): Promise<Omit<ExecOutput, "hostKeys">> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      onChannel?.(stream);
      const stdout = new Capture();
      const stderr = new Capture();
      stream.on("data", (data: Buffer) => stdout.push(data));
      stream.stderr.on("data", (data: Buffer) => stderr.push(data));
      stream.on("close", (code: number | null) => {
        resolve({
          stdout: stdout.text(),
          stderr: stderr.text(),
          exitCode: code,
          truncated: stdout.truncated || stderr.truncated,
        });
      });
      stream.on("error", reject);
    });
  });
}

// Dials every hop through the previous one; `until` lets the caller abort a hanging step.
async function connectChain(hops: Hop[], clients: Client[], until: <T>(work: Promise<T>) => Promise<T>) {
  const hostKeys: string[] = [];
  let previous: Client | undefined;
  for (const [i, hop] of hops.entries()) {
    let sock: Readable | undefined;
    if (previous) {
      sock = await until(
        forward(previous, hop.host, hop.port).catch((err: Error) => {
          throw new SshHopError(i, err.message);
        }),
      );
    }
    const connected = await until(connectHop(hop, i, sock, clients));
    hostKeys.push(connected.hostKey);
    previous = connected.client;
  }
  if (!previous) throw new Error("NO_HOPS");
  return { target: previous, hostKeys };
}

export interface ShellSession {
  stream: ClientChannel;
  hostKeys: string[];
  resize(cols: number, rows: number): void;
  close(): void;
}

// Interactive PTY for a human admin (terminal plugin). The caller pins hostKeys and owns close().
export async function openShell(input: { hops: Hop[]; cols: number; rows: number }): Promise<ShellSession> {
  const clients: Client[] = [];
  const close = () => {
    for (const client of [...clients].reverse()) client.end();
  };
  try {
    const { target, hostKeys } = await connectChain(input.hops, clients, (work) => work);
    const stream = await new Promise<ClientChannel>((resolve, reject) =>
      target.shell({ term: "xterm-256color", cols: input.cols, rows: input.rows }, (err, channel) => (err ? reject(err) : resolve(channel))),
    );
    stream.on("close", close);
    return { stream, hostKeys, resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0), close };
  } catch (err) {
    close();
    throw err;
  }
}

// Connect-per-exec: every hop is dialed fresh, pinned to its own host key, and torn down after.
export async function execRemote(input: ExecInput): Promise<ExecOutput> {
  const clients: Client[] = [];
  let aborted = false;
  let timedOut = false;
  let stopWith: (err: Error) => void = () => {};
  // Races every await so an abort returns at once even if a stream never closes.
  const stopped = new Promise<never>((_, reject) => {
    stopWith = reject;
  });
  stopped.catch(() => {});
  const until = <T>(work: Promise<T>): Promise<T> => Promise.race([work, stopped]);

  let channel: ClientChannel | null = null;
  const abort = () => {
    aborted = true;
    stopWith(new Error("ABORTED"));
    // A dropped connection alone leaves a non-pty command running until it writes; OpenSSH >= 7.9 delivers
    // the signal to the command's process group. Give it a moment to leave the socket before tearing down.
    if (channel) {
      try {
        channel.signal("KILL");
      } catch {
        // channel already gone
      }
      setTimeout(() => {
        for (const client of [...clients].reverse()) client.destroy();
      }, 300);
      return;
    }
    for (const client of [...clients].reverse()) client.destroy();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  input.signal?.addEventListener("abort", abort, { once: true });

  try {
    const { target, hostKeys } = await connectChain(input.hops, clients, until);
    const result = await until(runCommand(target, toExecCommand(input.shell, input.command), (ch) => (channel = ch)));
    return { ...result, hostKeys };
  } catch (err) {
    if (timedOut) throw new Error("EXEC_TIMEOUT");
    if (aborted) throw new Error("ABORTED");
    throw err;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    for (const client of [...clients].reverse()) client.end();
  }
}
