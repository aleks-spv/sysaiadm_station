import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const SCOPES = ["read", "tasks", "approve", "logs", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

const PREFIX = "sat_";
const DEFAULT_TTL_DAYS = 90;
const MAX_TTL_DAYS = 365;
const LAST_USED_STEP_MS = 60_000;
const DAY_MS = 86_400_000;

// Tokens carry 256 bits of entropy, so a fast hash is enough (no argon2).
const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

export interface TokenInfo {
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface VerifiedToken {
  id: string;
  name: string;
  scopes: Scope[];
}

function parseScopes(input: readonly string[]): Scope[] {
  if (input.length === 0) throw new Error("at least one scope is required");
  for (const scope of input) {
    if (!(SCOPES as readonly string[]).includes(scope)) throw new Error(`unknown scope: ${scope}`);
  }
  return [...new Set(input)] as Scope[];
}

export function createToken(
  db: Database,
  input: { name: string; scopes: string[]; ttlDays?: number },
  now = Date.now(),
): { id: string; token: string } {
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  const scopes = parseScopes(input.scopes);
  const ttl = input.ttlDays ?? DEFAULT_TTL_DAYS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_DAYS) throw new Error(`ttlDays must be 1..${MAX_TTL_DAYS}`);
  const token = PREFIX + randomBytes(32).toString("base64url");
  const id = randomUUID();
  db.run("INSERT INTO api_tokens (id, name, hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    name,
    hashToken(token),
    scopes.join(","),
    now,
    now + ttl * DAY_MS,
  ]);
  return { id, token };
}

// Returns null for unknown, revoked or expired tokens. last_used_at is written at most once a minute.
export function verifyToken(db: Database, raw: string, now = Date.now()): VerifiedToken | null {
  const row = db
    .query<
      { id: string; name: string; scopes: string; expires_at: number; last_used_at: number | null; revoked_at: number | null },
      [string]
    >("SELECT id, name, scopes, expires_at, last_used_at, revoked_at FROM api_tokens WHERE hash = ?")
    .get(hashToken(raw));
  if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_STEP_MS) {
    db.run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", [now, row.id]);
  }
  return { id: row.id, name: row.name, scopes: row.scopes.split(",") as Scope[] };
}

// Never returns the hash.
export function listTokens(db: Database): TokenInfo[] {
  return db
    .query<
      { id: string; name: string; scopes: string; created_at: number; expires_at: number; last_used_at: number | null; revoked_at: number | null },
      []
    >("SELECT id, name, scopes, created_at, expires_at, last_used_at, revoked_at FROM api_tokens ORDER BY created_at DESC")
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      scopes: r.scopes.split(",") as Scope[],
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    }));
}

export function revokeToken(db: Database, id: string, now = Date.now()): boolean {
  const result = db.run("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id]);
  return result.changes > 0;
}
