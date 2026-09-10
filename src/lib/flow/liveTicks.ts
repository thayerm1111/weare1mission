/**
 * IN-MEMORY LIVE TICK STORE (owner 09-10: streaming price feed).
 *
 * A tiny process-global registry of the latest streamed prices, written by the
 * Railway worker's WebSocket price stream (worker/priceStream.ts) and read by the
 * shared trading code:
 *
 *   • marketData.livePrice() returns a fresh streamed tick instantly (no HTTP,
 *     no API credit) when one exists, else falls through to the REST call.
 *   • flowManage.feedExtremes() folds streamed tick highs/lows into the candle
 *     extremes, so a seconds-long wick is visible to break-even/trail logic the
 *     moment it prints instead of waiting for the 1-min bar.
 *
 * ON VERCEL THIS STORE IS ALWAYS EMPTY (nothing writes to it there), so every
 * cron/route behaves exactly as before — the stream only adds speed where the
 * worker runs. Everything here is synchronous, allocation-light, and safe to
 * call from any code path.
 */

type Tick = { t: number; p: number };
type Buf = { last: Tick; ring: Tick[] };

const RING_KEEP_MS = 8 * 60_000; // extremes lookback window kept per symbol
const RING_MAX = 6000;           // hard cap (≈10 ticks/sec for 10 min)

const store = new Map<string, Buf>();
let totalTicks = 0;

/** Record one streamed tick for a TwelveData symbol (e.g. "XAU/USD"). */
export function pushLiveTick(td: string, price: number, atMs?: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const t = Number.isFinite(atMs) && (atMs as number) > 0 ? (atMs as number) : Date.now();
  const tick: Tick = { t, p: price };
  let buf = store.get(td);
  if (!buf) { buf = { last: tick, ring: [] }; store.set(td, buf); }
  buf.last = tick;
  buf.ring.push(tick);
  totalTicks += 1;
  // Prune by age (and hard cap) — amortized, only when the ring has grown a bit.
  if (buf.ring.length > 256) {
    const cutoff = Date.now() - RING_KEEP_MS;
    if (buf.ring[0].t < cutoff || buf.ring.length > RING_MAX) {
      let i = 0;
      while (i < buf.ring.length && buf.ring[i].t < cutoff) i++;
      if (buf.ring.length - i > RING_MAX) i = buf.ring.length - RING_MAX;
      if (i > 0) buf.ring = buf.ring.slice(i);
    }
  }
}

/** Latest streamed price for a symbol, or null if none fresh enough. */
export function liveTick(td: string, maxAgeMs: number): number | null {
  const buf = store.get(td);
  if (!buf) return null;
  return Date.now() - buf.last.t <= maxAgeMs ? buf.last.p : null;
}

/** High/low of streamed ticks at/after sinceMs (bounded by the ring window). */
export function liveTickExtremes(td: string, sinceMs: number): { high: number; low: number } | null {
  const buf = store.get(td);
  if (!buf || buf.ring.length === 0) return null;
  let hi = 0, lo = Infinity;
  for (let i = buf.ring.length - 1; i >= 0; i--) {
    const tk = buf.ring[i];
    if (tk.t < sinceMs) break; // ring is time-ordered — everything earlier is out of window
    if (tk.p > hi) hi = tk.p;
    if (tk.p < lo) lo = tk.p;
  }
  return hi > 0 && Number.isFinite(lo) ? { high: hi, low: lo } : null;
}

/** Stream stats for heartbeats/diagnostics. */
export function liveTickStats(): { symbols: string[]; ticks: number } {
  return { symbols: [...store.keys()], ticks: totalTicks };
}
