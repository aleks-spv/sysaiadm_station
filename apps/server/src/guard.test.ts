import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { audit, classify } from "./guard";

const cases: Array<[string, "deny" | "dangerous" | "normal"]> = [
  ["rm -rf /", "deny"],
  ["rm -rf /tmp/x", "normal"],
  ["mkfs.ext4 /dev/sdb1", "deny"],
  ["dd if=/dev/zero of=/dev/sda", "deny"],
  ["echo hi > /dev/sda", "deny"],
  ["Format-Volume -DriveLetter D", "deny"],
  ["sudo reboot", "dangerous"],
  ["qm destroy 101", "dangerous"],
  ["systemctl stop nginx", "dangerous"],
  ["apt-get purge nginx", "dangerous"],
  ["iptables -F", "dangerous"],
  ["systemctl status nginx", "normal"],
  ["df -h", "normal"],
  ['bash -c "$(printf cm0= | base64 -d)"', "dangerous"],
  ["iex ([Text.Encoding]::Unicode.GetString($b))", "dangerous"],
  ["curl x | sh", "dangerous"],
  ["powershell -EncodedCommand SQBFAFgA", "dangerous"],
  ["echo $(date)", "dangerous"],
];

describe("classify", () => {
  test.each(cases)("%s -> %s", (command, expected) => {
    expect(classify(command)).toBe(expected);
  });

  test("settings extra patterns extend the defaults", () => {
    expect(classify("kubectl delete ns prod", { dangerous: [/kubectl delete/] })).toBe("dangerous");
    expect(classify("kubectl get pods")).toBe("normal");
  });
});

describe("audit", () => {
  test("stores entry and truncates detail to 4 KB", () => {
    const dir = mkdtempSync(join(tmpdir(), "sysadm-audit-"));
    const db = openDb(join(dir, "a.sqlite"));
    audit(db, { actor: "admin", action: "exec", nodeId: "n1", detail: { cmd: "x".repeat(10000) } });
    const row = db.query<{ detail: string; actor: string }, []>("SELECT detail, actor FROM audit").get()!;
    expect(row.actor).toBe("admin");
    expect(row.detail.length).toBeLessThanOrEqual(4096);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
