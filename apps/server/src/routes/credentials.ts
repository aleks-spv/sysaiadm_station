import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import type { Credential } from "@sysadm/shared";
import { audit } from "../guard";
import { seal } from "../vault";

// Stored plaintext is the JSON of { password } or { privateKey, passphrase? }; internal.ts reads it back.
type Payload = { password: string } | { privateKey: string; passphrase?: string };

interface CredentialRow {
  id: string;
  name: string;
  type: "key" | "password";
  created_at: number;
}

function toCredential(row: CredentialRow): Credential {
  return { id: row.id, name: row.name, type: row.type, createdAt: row.created_at };
}

// Validates a secret for its type and returns the payload to seal. Never echoed back.
function payloadFor(type: "key" | "password", body: Record<string, unknown>): Payload | null {
  if (type === "password") {
    return typeof body.password === "string" && body.password.length > 0 ? { password: body.password } : null;
  }
  if (typeof body.privateKey !== "string" || body.privateKey.length === 0) return null;
  const passphrase = typeof body.passphrase === "string" ? body.passphrase : undefined;
  return passphrase === undefined ? { privateKey: body.privateKey } : { privateKey: body.privateKey, passphrase };
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export function credentialsRoutes(db: Database, masterKey: Buffer, now: () => number = Date.now): Hono {
  const app = new Hono();

  const findRow = (id: string) =>
    db.query<CredentialRow, [string]>("SELECT id, name, type, created_at FROM credentials WHERE id = ?").get(id);

  app.get("/api/credentials", (c) =>
    c.json(
      db
        .query<CredentialRow, []>("SELECT id, name, type, created_at FROM credentials ORDER BY created_at")
        .all()
        .map(toCredential),
    ),
  );

  app.post("/api/credentials", async (c) => {
    const body = await readBody(c);
    const type = body?.type;
    if (typeof body?.name !== "string" || body.name.length === 0 || (type !== "key" && type !== "password")) {
      return c.json({ error: "name and type (key|password) are required" }, 400);
    }
    const payload = payloadFor(type, body ?? {});
    if (!payload) return c.json({ error: "secret is missing for this type" }, 400);

    const id = crypto.randomUUID();
    const sealed = seal(masterKey, JSON.stringify(payload), id);
    db.run(
      "INSERT INTO credentials (id, name, type, ciphertext, iv, tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, body.name, type, sealed.ciphertext, sealed.iv, sealed.tag, now()],
    );
    audit(db, { actor: "admin", action: "credential_create", detail: { id, type } });
    const row = findRow(id);
    return c.json(row ? toCredential(row) : null, 201);
  });

  app.put("/api/credentials/:id", async (c) => {
    const id = c.req.param("id");
    const row = findRow(id);
    if (!row) return c.json({ error: "not found" }, 404);
    const body = await readBody(c);
    if (body?.name !== undefined) {
      if (typeof body.name !== "string" || body.name.length === 0) return c.json({ error: "bad name" }, 400);
      db.run("UPDATE credentials SET name = ? WHERE id = ?", [body.name, id]);
    }
    const hasSecret = body?.password !== undefined || body?.privateKey !== undefined;
    if (hasSecret) {
      const payload = payloadFor(row.type, body ?? {});
      if (!payload) return c.json({ error: "secret does not match credential type" }, 400);
      const sealed = seal(masterKey, JSON.stringify(payload), id);
      db.run("UPDATE credentials SET ciphertext = ?, iv = ?, tag = ? WHERE id = ?", [sealed.ciphertext, sealed.iv, sealed.tag, id]);
    }
    audit(db, { actor: "admin", action: "credential_update", detail: { id, secretChanged: hasSecret } });
    const updated = findRow(id);
    return c.json(updated ? toCredential(updated) : null);
  });

  app.delete("/api/credentials/:id", (c) => {
    const id = c.req.param("id");
    if (!findRow(id)) return c.json({ error: "not found" }, 404);
    const used = db.query<{ one: number }, [string]>("SELECT 1 AS one FROM nodes WHERE credential_id = ? LIMIT 1").get(id);
    if (used) return c.json({ error: "credential is in use" }, 409);
    db.run("DELETE FROM credentials WHERE id = ?", [id]);
    audit(db, { actor: "admin", action: "credential_delete", detail: { id } });
    return c.json({ ok: true });
  });

  return app;
}
