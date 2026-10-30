import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, createOpencodeInstaller, installVersion, rollback } from "./opencode-install";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "oc-install-"));
  dirs.push(d);
  return d;
}

// A fake platform package: package/bin/opencode.exe is a script printing the version, like `opencode --version`.
async function fakePackage(version: string): Promise<Buffer> {
  const src = tmp();
  mkdirSync(join(src, "package", "bin"), { recursive: true });
  writeFileSync(join(src, "package", "bin", "opencode"), `#!/bin/sh\necho "opencode v${version}"\n`, { mode: 0o755 });
  const tar = Bun.spawn(["tar", "-czf", "pkg.tgz", "package"], { cwd: src });
  await tar.exited;
  return readFileSync(join(src, "pkg.tgz"));
}

function registry(packages: Record<string, Buffer>, latest: string, corrupt = false) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (url.endsWith("/@opencode%2Fcli/latest")) return Response.json({ version: latest });
    const meta = /\/@opencode%2Fcli-test\/(.+)$/.exec(url);
    if (meta) {
      const pkg = packages[meta[1]!];
      if (!pkg) return new Response("not found", { status: 404 });
      const integrity = `sha512-${createHash("sha512").update(corrupt ? Buffer.from("x") : pkg).digest("base64")}`;
      return Response.json({ dist: { tarball: `https://registry.npmjs.org/tgz/${meta[1]}`, integrity } });
    }
    const tgz = /\/tgz\/(.+)$/.exec(url);
    if (tgz) return new Response(new Uint8Array(packages[tgz[1]!]!));
    return new Response("unexpected", { status: 500 });
  };
  return { fetchFn, calls };
}

test("compareVersions orders semver numerically", () => {
  expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
  expect(compareVersions("2.2.0", "2.2.0")).toBe(0);
  expect(compareVersions("2.2.0", "2.2.2")).toBeLessThan(0);
});

test("installVersion swaps the binary, keeps the previous one, rollback restores it", async () => {
  const dir = tmp();
  const { fetchFn } = registry({ "2.2.0": await fakePackage("2.2.0"), "2.2.2": await fakePackage("2.2.2") }, "2.2.2");
  const bin = await installVersion(dir, "2.2.0", fetchFn, "@opencode/cli-test");
  await installVersion(dir, "2.2.2", fetchFn, "@opencode/cli-test");
  expect(readFileSync(bin, "utf8")).toContain("2.2.2");
  expect(rollback(dir)).toBe(true);
  expect(readFileSync(bin, "utf8")).toContain("2.2.0");
});

test("a checksum mismatch or a non-2.x version leaves the current binary alone", async () => {
  const dir = tmp();
  const good = registry({ "2.2.0": await fakePackage("2.2.0") }, "2.2.0");
  const bin = await installVersion(dir, "2.2.0", good.fetchFn, "@opencode/cli-test");
  const bad = registry({ "2.2.2": await fakePackage("2.2.2") }, "2.2.2", true);
  await expect(installVersion(dir, "2.2.2", bad.fetchFn, "@opencode/cli-test")).rejects.toThrow("контрольной суммы");
  await expect(installVersion(dir, "3.0.0", bad.fetchFn, "@opencode/cli-test")).rejects.toThrow("2.x");
  expect(readFileSync(bin, "utf8")).toContain("2.2.0");
});

test("installer reports an update and rolls back when the new version does not start", async () => {
  const home = tmp();
  const { fetchFn } = registry({ "2.2.0": await fakePackage("2.2.0"), "2.2.2": await fakePackage("2.2.2") }, "2.2.0");
  const lines: string[] = [];
  const installer = createOpencodeInstaller({ home, fetchFn, pkg: "@opencode/cli-test", readyWaitMs: 300, log: (_l, line) => lines.push(line) });
  await installer.ensure();
  expect((await installer.info()).current).toBe("2.2.0");

  const newer = registry({ "2.2.0": await fakePackage("2.2.0"), "2.2.2": await fakePackage("2.2.2") }, "2.2.2");
  const second = createOpencodeInstaller({ home, fetchFn: newer.fetchFn, pkg: "@opencode/cli-test", readyWaitMs: 300, log: () => {} });
  const info = await second.info(true);
  expect(info).toMatchObject({ mode: "managed", current: "2.2.0", latest: "2.2.2", updateAvailable: true });

  let restarts = 0;
  const deadProc = { status: () => ({ state: "backoff" as const, pid: null, restarts: 0, lastExitCode: 1, startedAt: null }), restart: async () => void restarts++ };
  await expect(second.upgrade(deadProc)).rejects.toThrow("возвращена прежняя версия");
  expect(restarts).toBe(2);
  expect((await second.info()).current).toBe("2.2.0");

  const liveProc = { ...deadProc, status: () => ({ ...deadProc.status(), state: "running" as const }) };
  expect(await second.upgrade(liveProc)).toMatchObject({ current: "2.2.2", updateAvailable: false });
});

test("an external OPENCODE_BIN is never upgraded and npm is not asked", async () => {
  const { fetchFn, calls } = registry({}, "2.2.2");
  const installer = createOpencodeInstaller({ home: tmp(), external: "/bin/false", fetchFn, log: () => {} });
  await installer.ensure();
  expect(await installer.info(true)).toMatchObject({ mode: "external", updateAvailable: false });
  expect(calls).toEqual([]);
});
