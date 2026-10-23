import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for the FX Scalper's broker credentials at rest. The key lives in the environment
 * (FX_SCALPER_ENC_KEY, else FLOW_ENC_KEY — the web app and the worker must share it), never in the
 * database. Blob: base64(iv).base64(tag).base64(ciphertext). Read at call time so a key that arrives
 * after import (or is rotated) is honoured.
 */
function key(): Buffer {
  const v = (process.env.FX_SCALPER_ENC_KEY || process.env.FLOW_ENC_KEY || "").trim();
  if (!v) throw new Error("fx_scalper_encryption_key_missing");
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  const b64 = Buffer.from(v, "base64");
  if (b64.length === 32) return b64;
  return createHash("sha256").update(v).digest();
}

export const encryptionReady = (): boolean => {
  try { key(); return true; } catch { return false; }
};

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}

export function open(blob: string): string {
  const [iv, tag, ct] = String(blob).split(".");
  if (!iv || !tag || !ct) throw new Error("fx_scalper_sealed_blob_malformed");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

export const maskEmail = (email: string): string => {
  const [u, d] = String(email).split("@");
  if (!d) return "***";
  return `${u.slice(0, 1)}***@${d}`;
};
