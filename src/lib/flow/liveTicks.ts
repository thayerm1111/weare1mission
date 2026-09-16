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

type Tick = { t: number; p: number; rt: number };   // t = provider timestamp, rt = local receipt time
type Buf = { last: Tick; ring: Tick[] };

const RING_KEEP_MS = 8 * 60_000; // extremes lookback window kept per symbol
const RING_MAX = 6000;           // hard cap (≈10 ticks/sec for 10 min)

const store = new Map<string, Buf>();
let totalTicks = 0;

/** Record one streamed tick for a TwelveData symbol (e.g. "XAU/USD"). */
export function pushLiveTick(td: string, price: number, atMs?: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const t = Number.isFinite(atMs) && (atMs as number) > 0 ? (atMs as number) : Date.now();
  const tick: Tick = { t, p: price, rt: Date.now() };
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

/** OHLC of streamed ticks RECEIVED in [fromMs, toMs) (receipt time: the provider timestamp is minute-bucketed), or null when coverage is too thin to trust
 *  (fewer than `minTicks`, or the first/last tick more than `edgeMs` inside the window). */
export function tickBar(td: string, fromMs: number, toMs: number, minTicks = 4, edgeMs = 15_000): { o: number; h: number; l: number; c: number; n: number } | null {
  const buf = store.get(td); if (!buf) return null;
  let o = NaN, h = -Infinity, l = Infinity, c = NaN, n = 0, first = 0, last = 0;
  for (const tk of buf.ring) {
    if (tk.rt < fromMs || tk.rt >= toMs) continue;
    if (!n) { o = tk.p; first = tk.rt; }
    h = Math.max(h, tk.p); l = Math.min(l, tk.p); c = tk.p; last = tk.rt; n++;
  }
  if (n < minTicks || first - fromMs > edgeMs || toMs - last > edgeMs) return null;
  return { o, h, l, c, n };
}

/** Diagnostics: how many streamed ticks fell in [fromMs, toMs) and how far the first/last sit from the edges. */
export function tickCoverage(td: string, fromMs: number, toMs: number): { n: number; firstOffMs: number | null; lastOffMs: number | null; ringSize: number; newestAgeMs: number | null } {
  const buf = store.get(td); if (!buf) return { n: 0, firstOffMs: null, lastOffMs: null, ringSize: 0, newestAgeMs: null };
  let n = 0, first = 0, last = 0;
  for (const tk of buf.ring) { if (tk.rt < fromMs || tk.rt >= toMs) continue; if (!n) first = tk.t; last = tk.rt; n++; }
  return { n, firstOffMs: n ? first - fromMs : null, lastOffMs: n ? toMs - last : null, ringSize: buf.ring.length, newestAgeMs: Date.now() - buf.last.rt };
}
