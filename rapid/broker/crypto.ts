import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM at rest for broker refresh tokens.
 *
 * The key comes from the environment, never from the database, so a database dump on its own does
 * not yield trading access. Blob format: base64(iv).base64(authTag).base64(ciphertext).
 */
/**
 * Read at CALL time, not at import. A key captured when the module first loads cannot be rotated,
 * and in any process where configuration arrives after the first import it silently binds to the
 * wrong value — which looks exactly like working code until something fails to decrypt.
 */
function key(): Buffer {
  const v = (process.env.RAPID_ENC_KEY || process.env.FLOW_ENC_KEY || "").trim();
  if (!v) throw new Error("rapid_encryption_key_missing");
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  const b64 = Buffer.from(v, "base64");
  if (b64.length === 32) return b64;
  return createHash("sha256").update(v).digest();
}

export const encryptionReady = (): boolean => {
  try { key(); return true; } catch { return false; }
};

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const [iv, tag, ct] = String(blob).split(".");
  if (!iv || !tag || !ct) throw new Error("rapid_encrypted_blob_malformed");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

/** Never log or return a raw credential. */
export const maskEmail = (email: string): string => {
  const [u, d] = String(email).split("@");
  if (!d) return "***";
  return `${u.slice(0, 1)}***@${d}`;
};
