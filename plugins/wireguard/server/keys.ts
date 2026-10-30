import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

// WireGuard keys are raw x25519 keys in standard base64; node exposes them via JWK (base64url).
const toB64 = (b64url: string) => Buffer.from(b64url, "base64url").toString("base64");

export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { privateKey: toB64(jwk.d!), publicKey: toB64(jwk.x!) };
}

export function publicKeyOf(privateKey: string): string {
  const d = Buffer.from(privateKey, "base64").toString("base64url");
  const key = createPrivateKey({ key: { kty: "OKP", crv: "X25519", d, x: "" }, format: "jwk" });
  return toB64(createPublicKey(key).export({ format: "jwk" }).x!);
}
