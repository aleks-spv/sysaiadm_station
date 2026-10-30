import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRtkInstaller, findBinary, latestRelease } from "./install";

const ASSET = "rtk-oss-x86_64-unknown-linux-musl.tar.gz";
const URL_BASE = "https://github.com/rtk-ai/rtk/releases/download";

async function fakeRelease(version: string) {
  const src = mkdtempSync(join(tmpdir(), "rtk-src-"));
  writeFileSync(join(src, "rtk"), `#!/bin/sh\necho "rtk ${version}"\n`, { mode: 0o755 });
  const tar = Bun.spawn(["tar", "-czf", "rtk.tgz", "rtk"], { cwd: src });
  await tar.exited;
  const archive = readFileSync(join(src, "rtk.tgz"));
  const sha = createHash("sha256").update(archive).digest("hex");
  const url = `${URL_BASE}/v${version}/${ASSET}`;
  const fetchFn = async (u: string) => {
    if (u.startsWith("https://api.github.com/")) {
      return Response.json({ tag_name: `v${version}`, assets: [{ name: ASSET, browser_download_url: url, digest: `sha256:${sha}` }] });
    }
    return u === url ? new Response(archive) : new Response("no", { status: 404 });
  };
  return fetchFn;
}

test("latestRelease refuses assets without a digest or from elsewhere", async () => {
  const json = (assets: unknown[]) => async () => Response.json({ tag_name: "v1.2.0", assets });
  await expect(latestRelease(json([{ name: ASSET, browser_download_url: `${URL_BASE}/v1.2.0/${ASSET}` }]), ASSET)).rejects.toThrow("контрольной суммой");
  await expect(
    latestRelease(json([{ name: ASSET, browser_download_url: "https://evil.example/rtk.tgz", digest: `sha256:${"a".repeat(64)}` }]), ASSET),
  ).rejects.toThrow("github.com");
});

test("installer finds an update, installs it and switches the binary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtk-bin-"));
  const old = join(dir, "old-rtk");
  writeFileSync(old, `#!/bin/sh\necho "rtk 1.1.0"\n`, { mode: 0o755 });
  let current = findBinary(null, null, old);
  expect(current).toEqual({ path: old, version: "1.1.0" });

  const installer = createRtkInstaller({
    dir,
    external: false,
    current: () => current,
    onInstalled: (path) => (current = findBinary(path, null, old)),
    fetchFn: await fakeRelease("1.2.0"),
    asset: ASSET,
  });
  expect(await installer.info()).toMatchObject({ mode: "managed", current: "1.1.0", latest: "1.2.0", updateAvailable: true });
  expect(await installer.upgrade()).toMatchObject({ current: "1.2.0", path: join(dir, "rtk"), updateAvailable: false, error: null });
});

test("a bad checksum leaves the current binary alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtk-bin-"));
  const good = await fakeRelease("1.2.0");
  const tampered = async (u: string) => (u.startsWith("https://api.github.com/") ? good(u) : new Response("tampered"));
  const installer = createRtkInstaller({ dir, external: false, current: () => null, onInstalled: () => {}, fetchFn: tampered, asset: ASSET });
  await expect(installer.upgrade()).rejects.toThrow("контрольной суммы");
  expect(findBinary(join(dir, "rtk"), null, null)).toBeNull();
});

test("an external RTK_BIN is never upgraded", async () => {
  const installer = createRtkInstaller({ dir: tmpdir(), external: true, current: () => null, onInstalled: () => {}, asset: ASSET });
  expect(await installer.info(true)).toMatchObject({ mode: "external", updateAvailable: false });
  await expect(installer.upgrade()).rejects.toThrow("RTK_BIN");
});
