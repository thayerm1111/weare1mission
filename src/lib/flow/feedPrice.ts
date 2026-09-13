import { getInstrument } from "@/lib/flow/instruments";
import { contractKey } from "@/lib/flow/sizing";

// Fallback price source. The broker's own quote endpoint is intermittently down for
// a symbol/account (we've observed a persistent "no_quote" on an open gold position
// while the broker still held it), which stalls break-even/partials indefinitely and
// blocks entries. When the broker quote is unavailable we fall back to the market-data
// feed so the manager keeps protecting the trade and the executor can still size and
// validate an entry. Cached briefly so many positions on one symbol share a single
// upstream call.
//
// This is a PRICE fallback, not a safety bypass: every caller still runs its own
// bracket-validity and sizing checks against the returned price. A null return means
// no price source is available at all, and the caller must not act.
const feedCache = new Map<string, { at: number; px: number }>();
const FEED_TTL_MS = 20_000;

export async function feedPrice(symbol: string): Promise<number | null> {
  try {
    const td = getInstrument(contractKey(symbol))?.twelveDataSymbol;
    if (!td) return null;
    const hit = feedCache.get(td);
    if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.px;
    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) return null;
    const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(td)}&apikey=${key}`, { cache: "no-store" });
    const j = (await r.json()) as { price?: unknown };
    const p = Number(j?.price);
    if (Number.isFinite(p) && p > 0) { feedCache.set(td, { at: Date.now(), px: p }); return p; }
  } catch { /* feed down → null */ }
  return null;
}
