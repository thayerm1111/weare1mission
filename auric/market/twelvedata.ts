import type { Bar, Quote } from "../core/types";

/**
 * AURIC's reference feed (Twelve Data). It is a REFERENCE — never the executable price. It has its own
 * small per-minute budget so AURIC cannot starve the other products that share the key.
 * Twelve Data REST prices are updated minutely; that is disclosed on the dashboard.
 */
const BUDGET_PER_MIN = Number(process.env.AURIC_TD_BUDGET_PER_MIN ?? 12);
let windowStart = 0, used = 0;
function take(cost = 1): boolean {
  const now = Date.now();
  if (now - windowStart >= 60_000) { windowStart = now; used = 0; }
  if (used + cost > BUDGET_PER_MIN) return false;
  used += cost; return true;
}
export const referenceBudget = () => ({ used, limit: BUDGET_PER_MIN });

const key = () => process.env.TWELVEDATA_API_KEY ?? "";
export const referenceConfigured = () => key().length > 0;

export async function referencePrice(): Promise<Quote | null> {
  if (!referenceConfigured() || !take(1)) return null;
  try {
    const r = await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${encodeURIComponent(key())}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { price?: string; code?: number };
    const p = Number(j.price);
    if (!Number.isFinite(p) || p <= 0) return null;
    return { source: "reference", bid: p, ask: p, providerTs: null, providerTsPrecision: "none", receivedAt: Date.now() };
  } catch { return null; }
}

export async function referenceHistoryM1(size = 300): Promise<Bar[] | null> {
  if (!referenceConfigured() || !take(1)) return null;
  try {
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&outputsize=${Math.min(5000, size)}&timezone=UTC&order=asc&apikey=${encodeURIComponent(key())}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    const j = (await r.json()) as { values?: Array<{ datetime: string; open: string; high: string; low: string; close: string }>; status?: string };
    if (!Array.isArray(j.values)) return null;
    return j.values.map((v) => ({ t: Date.parse(v.datetime.replace(" ", "T") + "Z"), o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: null })).filter((b) => Number.isFinite(b.t));
  } catch { return null; }
}
