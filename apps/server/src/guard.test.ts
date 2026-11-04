import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { audit, classify, pruneOld } from "./guard";

const cases: Array<[string, "deny" | "read" | "dangerous" | "normal"]> = [
  ["rm -rf /", "deny"],
  ["rm -rf /tmp/x", "normal"],
  ["rm -rf /*", "deny"],
  ["rm -r -f /", "deny"],
  ["sudo rm -fR '/'", "deny"],
  ["rm -rf --no-preserve-root /", "deny"],
  ["rm --recursive --force /", "deny"],
  ["rm -rf ./build /tmp/x", "normal"],
  ["rm /tmp/x; ls /", "normal"],
  ["mkfs.ext4 /dev/sdb1", "deny"],
  ["dd if=/dev/zero of=/dev/sda", "deny"],
  ["echo hi > /dev/sda", "deny"],
  ["Format-Volume -DriveLetter D", "deny"],
  ["sudo reboot", "dangerous"],
  ["qm destroy 101", "dangerous"],
  ["systemctl stop nginx", "dangerous"],
  ["apt-get purge nginx", "dangerous"],
  ["iptables -F", "dangerous"],
  ["systemctl status nginx", "read"],
  ["df -h", "read"],
  ["iptables -L -n", "read"],
  ["iptables -L -Z", "dangerous"],
  ["systemctl restart nginx", "normal"],
  ["kill -9 1234", "normal"],
  ["echo $(rm -rf /tmp/x)", "dangerous"],
  ["cat /etc/hosts | sudo -n rm /x", "normal"],
  ["cat x > /etc/hosts", "normal"],
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
    expect(classify("ps aux", { dangerous: [/ps aux/] })).toBe("dangerous");
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

test("pruneOld drops audit rows older than a year and expired sessions only", () => {
  const db = openDb(":memory:");
  const now = 400 * 24 * 60 * 60 * 1000;
  db.run("INSERT INTO audit (ts, actor, action) VALUES (?, 'a', 'old'), (?, 'a', 'new')", [now - 366 * 24 * 60 * 60 * 1000, now - 1000]);
  db.run("INSERT INTO auth_sessions (id, expires_at) VALUES ('gone', ?), ('live', ?)", [now - 1, now + 1000]);
  pruneOld(db, now);
  expect(db.query("SELECT action FROM audit").all()).toEqual([{ action: "new" }]);
  expect(db.query("SELECT id FROM auth_sessions").all()).toEqual([{ id: "live" }]);
});
