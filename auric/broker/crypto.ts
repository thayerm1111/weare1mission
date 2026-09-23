import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM sealed blobs: "v1.<iv>.<tag>.<ct>" (base64url). AURIC uses its own key (AURIC_ENC_KEY);
 * it falls back to FLOW_ENC_KEY only so that credentials imported from an existing FLOW connection can be
 * read once — that legacy blob format ("iv.tag.ct" base64, no prefix) is supported read-only via openLegacy().
 */
function keyFrom(raw: string): Buffer {
  try { const b = Buffer.from(raw, "base64"); if (b.length === 32) return b; } catch { /* not base64 */ }
  try { const h = Buffer.from(raw, "hex"); if (h.length === 32) return h; } catch { /* not hex */ }
  return createHash("sha256").update(raw, "utf8").digest();
}
const auricKey = () => { const k = process.env.AURIC_ENC_KEY || process.env.FLOW_ENC_KEY; if (!k) throw new Error("AURIC_ENC_KEY missing"); return keyFrom(k); };
export const encryptionReady = () => Boolean(process.env.AURIC_ENC_KEY || process.env.FLOW_ENC_KEY);

export function seal(plain: string): string {
  const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", auricKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}
export function open(blob: string): string {
  if (blob.startsWith("v1.")) {
    const [, iv, tag, ct] = blob.split(".");
    const d = createDecipheriv("aes-256-gcm", auricKey(), Buffer.from(iv, "base64url")); d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  }
  return openLegacy(blob, process.env.FLOW_ENC_KEY || "");
}
/** Read-only decrypt of a legacy "iv.tag.ct" (base64) blob with the given key. Used once at import time. */
export function openLegacy(blob: string, keyRaw: string): string {
  if (!keyRaw) throw new Error("legacy key missing");
  const [iv, tag, ct] = blob.split(".");
  const d = createDecipheriv("aes-256-gcm", keyFrom(keyRaw), Buffer.from(iv, "base64")); d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}
