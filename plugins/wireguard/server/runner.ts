// Runs the root wrapper. sudo is allowed only for /usr/local/sbin/sysadm-wg, which takes a tunnel name, not a path.
export interface WgResult {
  ok: boolean;
  out: string;
  err: string;
}

export type WgRunner = (args: ["up" | "down", string] | ["dump"]) => Promise<WgResult>;

export const DEFAULT_COMMAND = ["sudo", "-n", "/usr/local/sbin/sysadm-wg"];

export function commandRunner(command: string[] = DEFAULT_COMMAND, timeoutMs = 30_000): WgRunner {
  return async (args) => {
    try {
      const proc = Bun.spawn([...command, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { ok: code === 0, out, err: err.trim() || (code === 0 ? "" : `exit ${code}`) };
    } catch (err) {
      return { ok: false, out: "", err: err instanceof Error ? err.message : String(err) };
    }
  };
}
