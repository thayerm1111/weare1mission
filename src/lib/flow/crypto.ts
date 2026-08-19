import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

/**
 * FLOW secret-at-rest encryption — AES-256-GCM.
 *
 * TradeLocker's only auth is email+password → JWT (no OAuth). So connecting an
 * account means handling a broker credential. We NEVER persist anything in
 * plaintext: the refresh token (and password, for silent re-auth) are encrypted
 * with a server-only key (FLOW_ENC_KEY) before they touch the database, and are
 * only ever decrypted inside server routes. The browser never sees a token.
 *
 * Blob format: base64(iv).base64(authTag).base64(ciphertext)  — dot-separated.
 */

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.FLOW_ENC_KEY;
  if (!raw) throw new Error("FLOW_ENC_KEY is not set — cannot encrypt/decrypt broker secrets.");
  // Accept a 32-byte base64/hex key, or derive a stable 32-byte key from any passphrase.
  let k: Buffer | null = null;
  try { const b = Buffer.from(raw, "base64"); if (b.length === 32) k = b; } catch { /* not base64 */ }
  if (!k) { try { const h = Buffer.from(raw, "hex"); if (h.length === 32) k = h; } catch { /* not hex */ } }
  if (!k) k = createHash("sha256").update(raw, "utf8").digest(); // derive from passphrase
  return k;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(blob: string): string {
  const parts = String(blob).split(".");
  if (parts.length !== 3) throw new Error("Malformed encrypted secret.");
  const [ivB, tagB, ctB] = parts;
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

/** True when a usable encryption key is configured (for graceful feature-gating). */
export function encryptionReady(): boolean {
  return !!process.env.FLOW_ENC_KEY;
}
