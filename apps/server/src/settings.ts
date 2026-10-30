import type { Database } from "bun:sqlite";

// Key/value rows of the settings table, stored as JSON.
export function getSetting<T>(db: Database, key: string): T | undefined {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function setSetting(db: Database, key: string, value: unknown): void {
  db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, JSON.stringify(value)]);
}
