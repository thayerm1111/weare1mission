/**
 * MARKET PULSE ON SCREEN — the scan's own facts, said plainly (owner 11-20 brief §13).
 *
 * Pure and display-only. The scanner's ranking (confirmations lined up, most first) and its levels are
 * shown as the scan made them; nothing here re-ranks, scores or adds a probability.
 */

/** When the scan ran, from its own stamp ("2026-11-20 23:15 UTC", or an ISO time). Null if it cannot be read. */
export function scanMs(asOf: string | null | undefined): number | null {
  const s = String(asOf ?? "").trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*UTC$/i.exec(s);
  const t = Date.parse(m ? `${m[1]}T${m[2]}Z` : s);
  return Number.isFinite(t) ? t : null;
}

/**
 * How old a scan may be and still be shown without a warning. A scan reads the market at one moment; past
 * this it is said to be an earlier scan — with its date and age — so it never passes for what is
 * tradable now. A display rule only: nothing is rescanned, and nothing is charged.
 */
export const SCAN_FRESH_MS = 15 * 60_000;

export type PulseCategory = "Forex" | "Crypto" | "Commodities" | "Indices";

/** The scanner's own grouping of a market (the classic deep-dive badge's rule). */
export function categoryOf(td: string): PulseCategory {
  const s = String(td ?? "");
  if (/BTC|ETH|SOL|XRP|DOGE/i.test(s)) return "Crypto";
  if (/XAU|XAG|WTI|BRENT/i.test(s)) return "Commodities";
  if (/DJI|NDX|SPX|QQQ|DIA|SPY|NAS100|US100|US500|US30/i.test(s)) return "Indices";
  return "Forex";
}
