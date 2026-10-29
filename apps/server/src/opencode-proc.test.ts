import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, startOpencode, writeOpencodeConfig, type OpencodeProc, type ProcOptions } from "./opencode-proc";

let dir: string;
const procs: OpencodeProc[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-proc-"));
});

afterEach(async () => {
  for (const p of procs.splice(0)) await p.stop();
  rmSync(dir, { recursive: true, force: true });
});

// Fake `opencode`: an executable that dumps its env, answers /api/info, and optionally crashes or ignores SIGTERM.
function fakeBin(mode: "serve" | "crash" | "ignoreTerm"): { bin: string; dump: string } {
  const dump = join(dir, `env-${mode}.json`);
  const bin = join(dir, `opencode-${mode}`);
  writeFileSync(
    bin,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));
if (${JSON.stringify(mode)} === "crash") process.exit(1);
if (${JSON.stringify(mode)} === "ignoreTerm") process.on("SIGTERM", () => {});
const port = Number(Bun.argv[Bun.argv.indexOf("--port") + 1]);
Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({ ok: true }) });
`,
  );
  chmodSync(bin, 0o755);
  return { bin, dump };
}

function start(over: Partial<ProcOptions> & { bin: string }): OpencodeProc {
  const proc = startOpencode({
    port: 20_000 + Math.floor(Math.random() * 20_000),
    home: join(dir, "home"),
    infraDir: dir,
    internalUrl: "http://127.0.0.1:3001",
    internalToken: "internal-token",
    password: "pw",
    ...over,
  });
  procs.push(proc);
  return proc;
}

async function waitFor(cond: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await Bun.sleep(50);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("child env is an allowlist: no master key or DB path, password exported", async () => {
  const { bin, dump } = fakeBin("serve");
  process.env.SYSADM_MASTER_KEY = "master-secret";
  process.env.DB_PATH = "/data/sysadm.sqlite";
  try {
    const proc = start({ bin });
    await waitFor(() => proc.status().state === "running");
    const env = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
    expect(env.SYSADM_MASTER_KEY).toBeUndefined();
    expect(env.DB_PATH).toBeUndefined();
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("pw");
    expect(env.SYSADM_INTERNAL_TOKEN).toBe("internal-token");
    expect(env.XDG_DATA_HOME).toBe(join(dir, "home", "data"));
  } finally {
    delete process.env.SYSADM_MASTER_KEY;
    delete process.env.DB_PATH;
  }
}, 20_000);

test("fake binary becomes running after /api/info answers 200", async () => {
  const { bin } = fakeBin("serve");
  const proc = start({ bin });
  await waitFor(() => proc.status().state === "running");
  expect(proc.status().pid).toBeNumber();
  expect(proc.headers).toEqual({ authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` });
}, 20_000);

test("crashing binary goes to backoff and restarts count up", async () => {
  const { bin } = fakeBin("crash");
  const proc = start({ bin, minBackoffMs: 2_000, maxBackoffMs: 4_000 });
  await waitFor(() => proc.status().restarts >= 1 && proc.status().state === "backoff");
  expect(proc.status().lastExitCode).toBe(1);
  await proc.stop();
  expect(proc.status().state).toBe("stopped");
}, 20_000);

test("stop resolves after the child is gone and does not restart it", async () => {
  const { bin } = fakeBin("serve");
  const proc = start({ bin });
  await waitFor(() => proc.status().state === "running");
  const pid = proc.status().pid!;
  await proc.stop();
  expect(alive(pid)).toBe(false);
  await Bun.sleep(300);
  expect(proc.status().restarts).toBe(0);
  expect(proc.status().pid).toBeNull();
}, 20_000);

test("child that ignores SIGTERM is killed after about 5 s", async () => {
  const { bin } = fakeBin("ignoreTerm");
  const proc = start({ bin });
  await waitFor(() => proc.status().state === "running");
  const pid = proc.status().pid!;
  const began = Date.now();
  await proc.stop();
  expect(Date.now() - began).toBeGreaterThanOrEqual(4_500);
  expect(alive(pid)).toBe(false);
}, 20_000);

test("missing binary does not throw: it goes to backoff and counts a restart", async () => {
  const proc = start({ bin: join(dir, "no-such-opencode"), minBackoffMs: 2_000, maxBackoffMs: 4_000 });
  await waitFor(() => proc.status().state === "backoff");
  expect(proc.status().restarts).toBe(1);
  expect(proc.status().lastExitCode).toBe(-1);
  await proc.stop();
}, 20_000);

test("password null: no OPENCODE_SERVER_PASSWORD in env and no auth header", async () => {
  const { bin, dump } = fakeBin("serve");
  const proc = start({ bin, password: null });
  await waitFor(() => proc.status().state === "running");
  const env = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
  expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
  expect(proc.headers).toBeUndefined();
  expect(childEnv({ home: "/h", password: null, internalUrl: "u", internalToken: "t" }).OPENCODE_SERVER_PASSWORD).toBeUndefined();
}, 20_000);

test("writeOpencodeConfig writes valid JSON with the plugin path and keeps base keys", () => {
  const infra = join(dir, "infra");
  writeOpencodeConfig(infra, "/app/packages/plugin/dist/index.js", { $schema: "x", policies: [] });
  const cfg = JSON.parse(readFileSync(join(infra, "opencode.json"), "utf8"));
  expect(cfg.plugins).toEqual([{ package: "/app/packages/plugin/dist/index.js" }]);
  expect(cfg.policies).toEqual([]);
  expect(existsSync(join(infra, "opencode.json.tmp"))).toBe(false);
});
