import { Database } from "bun:sqlite";

// Migrations are append-only: never edit a shipped entry, add a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('key','password')),
    ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL,
    tag BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN ('company','group','hypervisor','vm')),
    name TEXT NOT NULL,
    os TEXT NOT NULL DEFAULT 'other',
    address TEXT,
    port INTEGER,
    user TEXT,
    shell TEXT,
    credential_id TEXT REFERENCES credentials(id),
    jump_mode TEXT NOT NULL DEFAULT 'inherit' CHECK(jump_mode IN ('inherit','direct','via')),
    jump_node_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
    notes TEXT,
    autopilot_until INTEGER,
    host_key TEXT,
    import_source TEXT,
    import_key TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    CHECK(jump_mode <> 'via' OR jump_node_id IS NOT NULL)
  );
  CREATE INDEX nodes_address ON nodes(address, port);
  CREATE UNIQUE INDEX nodes_import ON nodes(import_source, import_key)
    WHERE import_source IS NOT NULL AND import_key IS NOT NULL;
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    content TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE node_skills (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    skill_id TEXT NOT NULL REFERENCES skills(id),
    PRIMARY KEY (node_id, skill_id)
  );
  CREATE TABLE admin (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    password_hash TEXT NOT NULL,
    totp_secret_enc BLOB NOT NULL,
    totp_iv BLOB NOT NULL,
    totp_tag BLOB NOT NULL
  );
  CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
    session_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    node_id TEXT,
    task_id TEXT,
    detail TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  `,
  // Skills can now carry a github source reference alongside local/builtin ones.
  `
  ALTER TABLE skills ADD COLUMN source TEXT;
  `,
  // NULL means active; archived tasks are purged once their retention window passes.
  `
  ALTER TABLE tasks ADD COLUMN archived_at INTEGER;
  `,
  // Server card collected by /init; one row per node, replaced on every collection.
  `
  CREATE TABLE node_facts (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    facts TEXT NOT NULL,
    collected_at INTEGER NOT NULL
  );
  `,
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  return db;
}

export const SCHEMA_VERSION = MIGRATIONS.length;
