import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { audit } from "./guard";
import { getSetting, setSetting } from "./settings";

// Scheduled database snapshots in <dataDir>/backups. VACUUM INTO writes a consistent copy while the app runs
// (WAL included). Credentials inside stay sealed: a copy is usable only with the same SYSADM_MASTER_KEY.
const KEY = "db_backup";
const CHECK_MS = 10 * 60_000;
const FIRST_CHECK_MS = 60_000;
export const BACKUP_NAME = /^sysaiadm-\d{8}-\d{6}\.sqlite$/;

export interface BackupSettings {
  enabled: boolean;
  intervalHours: number;
  keep: number;
}

export interface BackupFile {
  name: string;
  size: number;
  createdAt: number;
}

export const BACKUP_DEFAULTS: BackupSettings = { enabled: true, intervalHours: 24, keep: 7 };

export function backupSettings(db: Database): BackupSettings {
  return { ...BACKUP_DEFAULTS, ...getSetting<Partial<BackupSettings>>(db, KEY) };
}

export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, size: st.size, createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function runBackup(db: Database, dir: string, keep: number, now = new Date()): BackupFile {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const name = `sysaiadm-${stamp}.sqlite`;
  const path = join(dir, name);
  // Two runs in the same second (button + timer) would hit an existing file; VACUUM INTO refuses that.
  if (!existsSync(path)) {
    db.run("VACUUM INTO ?", [path]);
    chmodSync(path, 0o600);
  }
  for (const old of listBackups(dir).slice(keep)) rmSync(join(dir, old.name), { force: true });
  return listBackups(dir).find((b) => b.name === name)!;
}

export function startBackups(db: Database, dir: string, log: (level: "info" | "error", line: string) => void, now = () => Date.now()): () => void {
  const check = () => {
    const s = backupSettings(db);
    if (!s.enabled) return;
    const last = listBackups(dir)[0];
    if (last && now() - last.createdAt < s.intervalHours * 3600_000) return;
    try {
      const file = runBackup(db, dir, s.keep, new Date(now()));
      log("info", `database backup ${file.name} (${file.size} bytes)`);
    } catch (e) {
      log("error", `database backup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // Not at boot itself: startup stays fast, and a crash loop does not pile up copies.
  const first = setTimeout(check, FIRST_CHECK_MS);
  const timer = setInterval(check, CHECK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export function backupRoutes(db: Database, dir: string): Hono {
  const app = new Hono();

  app.get("/api/backups", (c) => c.json({ settings: backupSettings(db), backups: listBackups(dir) }));

  app.put("/api/backups/settings", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<BackupSettings> | null;
    const ok =
      typeof body?.enabled === "boolean" &&
      Number.isInteger(body.intervalHours) && body.intervalHours! >= 1 && body.intervalHours! <= 24 * 30 &&
      Number.isInteger(body.keep) && body.keep! >= 1 && body.keep! <= 365;
    if (!ok) return c.json({ error: "enabled, intervalHours (1–720), keep (1–365)" }, 400);
    const next: BackupSettings = { enabled: body!.enabled!, intervalHours: body!.intervalHours!, keep: body!.keep! };
    setSetting(db, KEY, next);
    audit(db, { actor: c.get("actor"), action: "backup_settings", detail: next });
    return c.json(next);
  });

  app.post("/api/backups", (c) => {
    const file = runBackup(db, dir, backupSettings(db).keep);
    audit(db, { actor: c.get("actor"), action: "backup_create", detail: { name: file.name } });
    return c.json(file, 201);
  });

  app.get("/api/backups/:name", (c) => {
    const name = c.req.param("name");
    if (!BACKUP_NAME.test(name) || !existsSync(join(dir, name))) return c.json({ error: "not found" }, 404);
    audit(db, { actor: c.get("actor"), action: "backup_download", detail: { name } });
    c.header("Content-Disposition", `attachment; filename="${name}"`);
    c.header("Content-Type", "application/vnd.sqlite3");
    return c.body(Bun.file(join(dir, name)).stream());
  });

  app.delete("/api/backups/:name", (c) => {
    const name = c.req.param("name");
    if (!BACKUP_NAME.test(name) || !existsSync(join(dir, name))) return c.json({ error: "not found" }, 404);
    rmSync(join(dir, name));
    audit(db, { actor: c.get("actor"), action: "backup_delete", detail: { name } });
    return c.json({ ok: true });
  });

  return app;
}
