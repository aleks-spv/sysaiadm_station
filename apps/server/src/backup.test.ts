import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { backupSettings, listBackups, runBackup, startBackups } from "./backup";
import { setSetting } from "./settings";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sysadm-backup-"));
  dirs.push(dir);
  const db = openDb(join(dir, "live.sqlite"));
  db.run("INSERT INTO settings (key, value) VALUES ('marker', '\"kept\"')");
  return { db, backups: join(dir, "backups") };
}

test("a backup is a readable copy and only the newest `keep` survive", () => {
  const { db, backups } = setup();
  for (let i = 0; i < 4; i++) runBackup(db, backups, 2, new Date(Date.UTC(2026, 9, 30, 10, 0, i)));
  const files = listBackups(backups);
  expect(files.map((f) => f.name).sort()).toEqual(["sysaiadm-20261030-100002.sqlite", "sysaiadm-20261030-100003.sqlite"]);
  const copy = new Database(join(backups, files[0]!.name), { readonly: true });
  expect(copy.query("SELECT value FROM settings WHERE key = 'marker'").get()).toEqual({ value: '"kept"' });
  copy.close();
});

test("defaults are daily with seven copies, and saved settings override them", () => {
  const { db } = setup();
  expect(backupSettings(db)).toEqual({ enabled: true, intervalHours: 24, keep: 7 });
  setSetting(db, "db_backup", { enabled: false, intervalHours: 6, keep: 3 });
  expect(backupSettings(db)).toEqual({ enabled: false, intervalHours: 6, keep: 3 });
});

test("the scheduler stops cleanly", () => {
  const { db, backups } = setup();
  const stop = startBackups(db, backups, () => {});
  stop();
  expect(listBackups(backups)).toEqual([]);
});
