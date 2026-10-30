import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "../../../apps/server/src/opencode-install";
import type { RtkVersion } from "../web/types";

// The image ships a pinned rtk; newer releases go into the plugin's data dir (a volume) and win when they are newer.
const LATEST = "https://api.github.com/repos/rtk-ai/rtk/releases/latest";
const DOWNLOADS = "https://github.com/rtk-ai/rtk/releases/download/";
const CHECK_EVERY_MS = 6 * 3600_000;
const TIMEOUT_MS = 2 * 60_000;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface Release {
  version: string;
  url: string;
  sha256: string;
}

// The Apache-2.0 "oss" build, the same assets the Dockerfile pins.
export function assetName(platform = process.platform, arch = process.arch): string {
  if (platform === "linux" && arch === "x64") return "rtk-oss-x86_64-unknown-linux-musl.tar.gz";
  if (platform === "linux" && arch === "arm64") return "rtk-oss-aarch64-unknown-linux-gnu.tar.gz";
  throw new Error(`rtk: платформа ${platform}/${arch} не поддерживается`);
}

// GitHub publishes a sha256 digest for every release asset; without it the release is refused.
export async function latestRelease(fetchFn: FetchFn = fetch, asset = assetName()): Promise<Release> {
  const res = await fetchFn(LATEST, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const body = (await res.json()) as { tag_name?: unknown; assets?: Array<{ name?: unknown; browser_download_url?: unknown; digest?: unknown }> };
  const version = typeof body.tag_name === "string" ? /^v?(\d+\.\d+\.\d+)$/.exec(body.tag_name)?.[1] : undefined;
  if (!version) throw new Error("GitHub вернул непонятную версию rtk");
  const found = body.assets?.find((a) => a.name === asset);
  const sha256 = typeof found?.digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(found.digest)?.[1] : undefined;
  const url = found?.browser_download_url;
  if (typeof url !== "string" || !sha256) throw new Error(`в релизе rtk ${version} нет ${asset} с контрольной суммой`);
  if (!url.startsWith(DOWNLOADS)) throw new Error("rtk отдаётся не из github.com/rtk-ai/rtk");
  return { version, url, sha256 };
}

export function versionOf(path: string): string | null {
  try {
    const res = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 5000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    return res.exitCode === 0 ? (/(\d+\.\d+\.\d+)/.exec(res.stdout.toString())?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

// Downloads, checks the digest and the reported version, then swaps <dir>/rtk atomically. Throws without touching it.
export async function installRelease(dir: string, release: Release, fetchFn: FetchFn = fetch): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const work = join(dir, ".install");
  try {
    mkdirSync(work);
  } catch {
    throw new Error("установка rtk уже идёт");
  }
  try {
    const res = await fetchFn(release.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`не удалось скачать rtk (${res.status})`);
    const archive = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(archive).digest("hex") !== release.sha256) throw new Error("скачанный rtk не прошёл проверку контрольной суммы");
    await Bun.write(join(work, "rtk.tgz"), archive);
    const tar = Bun.spawn(["tar", "-xzf", "rtk.tgz", "rtk"], { cwd: work, stdout: "ignore", stderr: "ignore" });
    if ((await tar.exited) !== 0) throw new Error("в архиве нет бинарника rtk");
    const fresh = join(work, "rtk");
    chmodSync(fresh, 0o755);
    const got = versionOf(fresh);
    if (got !== release.version) throw new Error(`скачанный rtk сообщает версию ${got ?? "?"}, ожидалась ${release.version}`);
    const bin = join(dir, "rtk");
    renameSync(fresh, bin);
    return bin;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface Binary {
  path: string;
  version: string;
}

// RTK_BIN pins one binary (external, no upgrades); otherwise the newer of the installed one and the image's `rtk`.
export function findBinary(managed: string | null, external = process.env.RTK_BIN || null, system = Bun.which("rtk")): Binary | null {
  const candidates = external ? [Bun.which(external)] : [managed && existsSync(managed) ? managed : null, system];
  let best: Binary | null = null;
  for (const path of candidates) {
    const version = path ? versionOf(path) : null;
    if (path && version && (!best || compareVersions(version, best.version) > 0)) best = { path, version };
  }
  return best;
}

export function createRtkInstaller(opts: {
  dir: string;
  external: boolean;
  current: () => Binary | null;
  onInstalled: (path: string) => void;
  fetchFn?: FetchFn;
  asset?: string;
}) {
  const fetchFn = opts.fetchFn ?? fetch;
  let latest: Release | null = null;
  let checkedAt: number | null = null;
  let busy = false;
  let error: string | null = null;

  const check = async () => {
    try {
      latest = await latestRelease(fetchFn, opts.asset ?? assetName());
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    checkedAt = Date.now();
  };

  const info = async (refresh = false): Promise<RtkVersion> => {
    if (!opts.external && (refresh || checkedAt === null || Date.now() - checkedAt > CHECK_EVERY_MS)) await check();
    const bin = opts.current();
    return {
      mode: opts.external ? "external" : "managed",
      current: bin?.version ?? null,
      path: bin?.path ?? null,
      latest: latest?.version ?? null,
      updateAvailable: !opts.external && latest !== null && (!bin || compareVersions(latest.version, bin.version) > 0),
      busy,
      error,
      checkedAt,
    };
  };

  return {
    info,
    upgrade: async (): Promise<RtkVersion> => {
      if (opts.external) throw new Error("rtk задан через RTK_BIN, обновляйте его там, откуда он установлен");
      if (busy) throw new Error("установка rtk уже идёт");
      busy = true;
      try {
        latest = await latestRelease(fetchFn, opts.asset ?? assetName());
        checkedAt = Date.now();
        opts.onInstalled(await installRelease(opts.dir, latest, fetchFn));
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        busy = false;
      }
      return info();
    },
  };
}
