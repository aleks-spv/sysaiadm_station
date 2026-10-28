import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

// Loads SYSADM_MASTER_KEY (base64, exactly 32 bytes). Throws at startup if missing or wrong size.
export function loadMasterKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.SYSADM_MASTER_KEY;
  if (!raw) throw new Error("SYSADM_MASTER_KEY is not set (base64, 32 bytes: openssl rand -base64 32)");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`SYSADM_MASTER_KEY must decode to 32 bytes, got ${key.length}`);
  return key;
}

// aad binds the ciphertext to its record id, so a row cannot be swapped for another.
export function seal(key: Buffer, plaintext: Buffer | string, aad: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = typeof plaintext === "string" ? Buffer.from(plaintext) : plaintext;
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}
