/**
 * GENX brand version — the single source of truth for the version shown to the community
 * (Telegram signals + notes). Set once here, surfaced everywhere the brain speaks.
 *
 * HOW TO BUMP (no code deploy needed): set the env var GENX_VERSION on Vercel AND Railway.
 *   - a normal update:   GENX_VERSION=2.1, then 2.2, 2.3, …
 *   - a major revision:  GENX_VERSION=3.0, then 3.1, …
 * Leave it unset to use the default below. An invalid value falls back to the default, so a
 * typo can never blank the brand.
 */

import { genx1Active } from "@/lib/genx3/engineSelect";

const DEFAULT_VERSION = "2.0";

/** Current version string, e.g. "2.0". Env-driven so it can change without a code deploy. */
export function genxVersion(): string {
  if (genx1Active()) return "1.0";              // owner 09-16: legacy engine runs as GENX 1.0
  const raw = (process.env.GENX_VERSION || "").trim();
  if (/^\d+\.\d+$/.test(raw)) return raw;      // major.minor, e.g. 2.1 / 3.0
  if (/^\d+$/.test(raw)) return `${raw}.0`;     // "3" → "3.0"
  return DEFAULT_VERSION;
}

/** The brand label the community sees, e.g. "GENX 2.0". */
export function genxLabel(): string {
  return `GENX ${genxVersion()}`;
}
