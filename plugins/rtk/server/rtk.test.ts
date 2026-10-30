import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ExecOutputView, PluginContext } from "../../../apps/server/src/plugins/types";
import { compact, pickRtkFilter } from "./compact";
import { createRtk } from "./index";

test("compact collapses repeats, progress bars, ANSI and keeps distinct lines", () => {
  const input = ["\x1b[32mok\x1b[0m", "Progress 10%\rProgress 50%\rProgress 100%", "same", "same", "same", "", "", "", "tail"].join("\n");
  expect(compact(input)).toBe(["ok", "Progress 100%", "same", "  … строка повторилась ещё 2 раз", "", "tail"].join("\n"));
});

test("compact cuts the middle of long output and says how to get it", () => {
  const input = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const lines = compact(input).split("\n");
  expect(lines[0]).toBe("line 0");
  expect(lines.at(-1)).toBe("line 999");
  expect(lines.find((l) => l.includes("пропущено 750 строк"))).toContain("raw=true");
});

test("rtk filters only for commands whose output they understand", () => {
  expect(pickRtkFilter("sudo find /etc -name '*.conf'")).toBe("find");
  expect(pickRtkFilter("grep -rn error /var/log/nginx")).toBe("grep");
  expect(pickRtkFilter("journalctl -u nginx | grep -i error")).toBeNull();
  expect(pickRtkFilter("cat x | rg foo")).toBe("grep");
  expect(pickRtkFilter("git diff HEAD~1")).toBe("git-diff");
  expect(pickRtkFilter("git log -n 50")).toBeNull();
  expect(pickRtkFilter("find / -name x && df -h")).toBeNull();
});

function setup(runRtk: ((f: string, s: string) => Promise<string | null>) | null) {
  const db = new Database(":memory:");
  const version = { v: 0 };
  const ctx = {
    db,
    audit: () => {},
    migrate: (m: string[]) => {
      for (; version.v < m.length; version.v++) db.exec(m[version.v]);
    },
  } as unknown as PluginContext;
  return { ctx, rtk: createRtk(null, runRtk, () => Date.UTC(2026, 9, 29, 12)) };
}

const view = (command: string, stdout: string): ExecOutputView => ({ nodeId: "n1", taskId: "t1", command, shell: "bash", exitCode: 0, stdout, stderr: "" });

test("filterOutput: rtk for find, compaction for the rest, stats per method, short output untouched", async () => {
  const filters: string[] = [];
  const { ctx, rtk } = setup(async (filter) => {
    filters.push(filter);
    return "3 files\n";
  });
  const big = Array.from({ length: 100 }, () => "Oct 29 sshd[1]: Failed password for root").join("\n");

  const found = await rtk.filterOutput(ctx, view("find /etc", "x".repeat(2000)));
  expect(found?.stdout).toBe("3 files");
  expect(found?.note).toContain("rtk:find");
  const logs = await rtk.filterOutput(ctx, view("journalctl -n 100", big));
  expect(logs?.stdout.split("\n")).toHaveLength(2);
  expect(await rtk.filterOutput(ctx, view("uptime", "up 1 day"))).toBeNull();
  expect(filters).toEqual(["find"]);

  const stats = rtk.stats(ctx);
  expect(stats.total.commands).toBe(2);
  expect(stats.total.compressed).toBe(2);
  expect(stats.methods.map((m) => m.method).sort()).toEqual(["compact", "rtk:find"]);
  expect(stats.recent[0].command).toBe("journalctl -n 100");
  expect(stats.daily[0].day).toBe("2026-10-29");
});

test("filterOutput falls back to compaction when rtk fails, and never grows output", async () => {
  const { ctx, rtk } = setup(async () => null);
  const distinct = Array.from({ length: 100 }, (_, i) => `/etc/file${i}`).join("\n");
  expect(await rtk.filterOutput(ctx, view("find /etc", distinct))).toBeNull();
  expect(rtk.stats(ctx).total).toMatchObject({ commands: 1, compressed: 0 });
});
