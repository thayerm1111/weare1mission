/**
 * BROKER CREDENTIAL ENCRYPTION.
 *
 * Broker tokens are the keys to someone's money. They are encrypted at rest with AES-256-GCM, they never
 * leave the server, and they are never logged. If no key is configured this module REFUSES to encrypt
 * rather than storing anything in the clear — a connection that cannot be stored safely is not stored.
 *
 * The key lives only in the environment (CC_ENC_KEY, 32 bytes base64). It is not in this repository and
 * must never be.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

/**
 * Where the key comes from, in order:
 *
 *   1. CC_ENC_KEY  — the Command Center's own key, when one is provisioned. Preferred: a separate key
 *                    means a compromise of one subsystem's secret does not open the other's.
 *   2. FLOW_ENC_KEY — the key the desk already runs on. The Command Center keeps its OWN tables, its own
 *                    connections and its own code path; sharing the key simply avoids making a member
 *                    wait on an environment variable to connect an account they have already connected
 *                    elsewhere. Set CC_ENC_KEY whenever you want them properly separated.
 *
 * This reads an environment variable. It does NOT import anything from the desk — the clean-room
 * boundary is about code, and it still holds.
 *
 * Any of the three shapes FLOW accepts works, so the same value can be pasted into either name:
 * a 32-byte base64 key, a 32-byte hex key, or any passphrase (hashed to 32 bytes).
 */
function key(): Buffer | null {
  const raw = (process.env.CC_ENC_KEY || process.env.FLOW_ENC_KEY || "").trim();
  if (!raw) return null;
  try { const b = Buffer.from(raw, "base64"); if (b.length === 32) return b; } catch { /* not base64 */ }
  try { const h = Buffer.from(raw, "hex"); if (h.length === 32) return h; } catch { /* not hex */ }
  return createHash("sha256").update(raw, "utf8").digest();
}

/** Which key is in use, for diagnostics. Never returns the key itself. */
export const keySource = (): "cc" | "flow" | "none" =>
  process.env.CC_ENC_KEY ? "cc" : process.env.FLOW_ENC_KEY ? "flow" : "none";

export const encryptionAvailable = (): boolean => key() !== null;

export type Sealed = string;   // v1.<iv>.<tag>.<ciphertext>, all base64url

/** Encrypt a secret. Returns null when no usable key is configured — callers must treat that as a refusal. */
export function seal(plaintext: string): Sealed | null {
  const k = key();
  if (!k || !plaintext) return null;
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv(ALGO, k, iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

/** Decrypt. Returns null on a wrong key, a tampered payload or an unknown format — never throws. */
export function open(sealed: Sealed | null | undefined): string | null {
  const k = key();
  if (!k || !sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const enc = Buffer.from(parts[3], "base64url");
    const d = createDecipheriv(ALGO, k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch { return null; }
}

/** For display only — never the real thing. */
export const maskEmail = (email: string): string => {
  const [u, dom] = email.split("@");
  if (!dom) return "•••";
  return `${u.slice(0, 2)}${"•".repeat(Math.max(2, u.length - 2))}@${dom}`;
};
