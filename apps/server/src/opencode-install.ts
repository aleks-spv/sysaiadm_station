import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { OpencodeProc } from "./opencode-proc";

// opencode is not baked into the image: it lives in <OPENCODE_HOME>/bin (a volume) and is installed and upgraded
// from the npm platform package, like OpenChamber does. Only 2.x: @opencode/client is built against that API.
const REGISTRY = "https://registry.npmjs.org";
const SUPPORTED = /^2\.\d+\.\d+$/;
const CHECK_EVERY_MS = 6 * 3600_000;
const READY_WAIT_MS = 60_000;
const TIMEOUT_MS = 5 * 60_000;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface OpencodeVersionInfo {
  // external: OPENCODE_BIN points to a binary someone else manages, so no install or upgrade here.
  mode: "managed" | "external";
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  busy: boolean;
  error: string | null;
  checkedAt: number | null;
}

// x64 takes the baseline build so hosts without AVX2 still run it.
export function platformPackage(platform = process.platform, arch = process.arch): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  if (!os || (arch !== "x64" && arch !== "arm64")) throw new Error(`opencode: платформа ${platform}/${arch} не поддерживается`);
  return arch === "x64" ? `@opencode/cli-${os}-x64-baseline` : `@opencode/cli-${os}-arm64`;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export async function binaryVersion(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if ((await proc.exited) !== 0) return null;
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function latestVersion(fetchFn: FetchFn = fetch): Promise<string> {
  const res = await fetchFn(`${REGISTRY}/@opencode%2Fcli/latest`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`npm registry ответил ${res.status}`);
  const { version } = (await res.json()) as { version?: unknown };
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("npm registry вернул непонятную версию");
  return version;
}

// Downloads the platform package, checks npm's sha512, unpacks it and swaps <dir>/opencode atomically.
// The previous binary stays as opencode.prev for rollback(). Throws without touching the current binary.
export async function installVersion(dir: string, version: string, fetchFn: FetchFn = fetch, pkg = platformPackage()): Promise<string> {
  if (!SUPPORTED.test(version)) throw new Error(`opencode ${version} не поддерживается: нужна версия 2.x`);
  mkdirSync(dir, { recursive: true });
  const work = join(dir, ".install");
  try {
    mkdirSync(work);
  } catch {
    throw new Error("установка opencode уже идёт");
  }
  try {
    const meta = await fetchFn(`${REGISTRY}/${pkg.replace("/", "%2F")}/${version}`, { signal: AbortSignal.timeout(15_000) });
    if (!meta.ok) throw new Error(`пакет ${pkg}@${version} не найден в npm (${meta.status})`);
    const { dist } = (await meta.json()) as { dist?: { tarball?: unknown; integrity?: unknown } };
    if (typeof dist?.tarball !== "string" || typeof dist.integrity !== "string" || !dist.integrity.startsWith("sha512-")) {
      throw new Error("npm не отдал ссылку и контрольную сумму пакета");
    }
    if (new URL(dist.tarball).origin !== REGISTRY) throw new Error("пакет opencode отдаётся не с registry.npmjs.org");
    const res = await fetchFn(dist.tarball, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`не удалось скачать opencode (${res.status})`);
    const archive = Buffer.from(await res.arrayBuffer());
    if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== dist.integrity) {
      throw new Error("скачанный opencode не прошёл проверку контрольной суммы");
    }
    await Bun.write(join(work, "pkg.tgz"), archive);
    const tar = Bun.spawn(["tar", "-xzf", "pkg.tgz"], { cwd: work, stdout: "ignore", stderr: "ignore" });
    if ((await tar.exited) !== 0) throw new Error("не удалось распаковать пакет opencode");
    // Platform packages ship bin/opencode; the umbrella @opencode/cli package names it opencode.exe.
    const fresh = ["opencode", "opencode.exe"].map((name) => join(work, "package", "bin", name)).find((p) => existsSync(p));
    if (!fresh) throw new Error("в пакете нет бинарника opencode");
    chmodSync(fresh, 0o755);
    const got = await binaryVersion(fresh);
    if (got !== version) throw new Error(`скачанный opencode сообщает версию ${got ?? "?"}, ожидалась ${version}`);
    const bin = join(dir, "opencode");
    if (existsSync(bin)) renameSync(bin, join(dir, "opencode.prev"));
    renameSync(fresh, bin);
    return bin;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function rollback(dir: string): boolean {
  const prev = join(dir, "opencode.prev");
  if (!existsSync(prev)) return false;
  renameSync(prev, join(dir, "opencode"));
  return true;
}

export interface OpencodeInstaller {
  bin: string;
  // Installs the latest 2.x when the managed binary is missing (first start of a fresh volume).
  ensure(): Promise<void>;
  info(refresh?: boolean): Promise<OpencodeVersionInfo>;
  // Installs the latest version, restarts opencode, and rolls back if it does not come up.
  upgrade(proc: Pick<OpencodeProc, "status" | "restart">): Promise<OpencodeVersionInfo>;
}

export function createOpencodeInstaller(opts: {
  home: string;
  external?: string;
  fetchFn?: FetchFn;
  pkg?: string;
  readyWaitMs?: number;
  log: (level: "info" | "warn" | "error", line: string) => void;
}): OpencodeInstaller {
  const dir = join(opts.home, "bin");
  const bin = opts.external ?? join(dir, "opencode");
  const fetchFn = opts.fetchFn ?? fetch;
  let latest: string | null = null;
  let checkedAt: number | null = null;
  let busy = false;
  let error: string | null = null;

  const pickLatest = async (): Promise<string> => {
    const v = await latestVersion(fetchFn);
    latest = v;
    checkedAt = Date.now();
    return v;
  };

  const info = async (refresh = false): Promise<OpencodeVersionInfo> => {
    const current = await binaryVersion(bin);
    if (!opts.external && (refresh || checkedAt === null || Date.now() - checkedAt > CHECK_EVERY_MS)) {
      try {
        await pickLatest();
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        checkedAt = Date.now();
      }
    }
    const usable = latest !== null && SUPPORTED.test(latest);
    return {
      mode: opts.external ? "external" : "managed",
      current,
      latest,
      updateAvailable: !opts.external && usable && (current === null || compareVersions(latest!, current) > 0),
      busy,
      error,
      checkedAt,
    };
  };

  const install = async (): Promise<string> => {
    const version = await pickLatest();
    if (!SUPPORTED.test(version)) throw new Error(`последняя версия opencode ${version} не 2.x, автообновление остановлено`);
    opts.log("info", `installing opencode ${version} into ${dir}`);
    await installVersion(dir, version, fetchFn, opts.pkg);
    return version;
  };

  const waitRunning = async (proc: Pick<OpencodeProc, "status">): Promise<boolean> => {
    const deadline = Date.now() + (opts.readyWaitMs ?? READY_WAIT_MS);
    while (Date.now() < deadline) {
      if (proc.status().state === "running") return true;
      await Bun.sleep(250);
    }
    return false;
  };

  return {
    bin,
    ensure: async () => {
      if (opts.external || existsSync(bin)) return;
      busy = true;
      try {
        await install();
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        opts.log("error", `opencode install failed: ${error}`);
      } finally {
        busy = false;
      }
    },
    info,
    upgrade: async (proc) => {
      if (opts.external) throw new Error("opencode задан через OPENCODE_BIN, обновляйте его там, откуда он установлен");
      if (busy) throw new Error("установка opencode уже идёт");
      busy = true;
      try {
        const version = await install();
        await proc.restart();
        if (!(await waitRunning(proc))) {
          const restored = rollback(dir);
          if (restored) await proc.restart();
          throw new Error(`opencode ${version} не запустился${restored ? ", возвращена прежняя версия" : ""}`);
        }
        error = null;
        opts.log("info", `opencode upgraded to ${version}`);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        opts.log("error", `opencode upgrade failed: ${error}`);
        throw e;
      } finally {
        busy = false;
      }
      return info();
    },
  };
}
