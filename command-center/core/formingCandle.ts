/**
 * THE FORMING CANDLE (owner 11-11: "Update the current candle as new prices arrive, rather than refreshing
 * only after candle close … Never replace real missing data with fabricated candles.")
 *
 * The chart's history is the server's bars: Twelve Data REST time_series with `timezone=UTC`, stamped at their
 * OPEN time (adapters/twelvedata.ts parseSeries; core/bars.ts bucketStart floors to the same UTC grid). Between
 * server refreshes, the streamed ticks move the newest candle. This file is the one place that folds ticks into
 * candles and merges them with the server's, so the rules are written down once and tested:
 *
 *   BUCKETS        A candle's open time is its UTC bucket: an exact multiple of the timeframe since the epoch
 *                  (5m/15m/1h; 4h at 00/04/08/12/16/20 UTC; 1d at 00:00 UTC — how Twelve Data labels bars
 *                  under timezone=UTC). If the server's bars sit on another phase (a 4h series aligned to a
 *                  different hour), the phase is read off the server's own recent bars (the phase most of them
 *                  share) and ticks are bucketed on THAT grid, so a local candle never straddles two server ones.
 *   WHICH CLOCK    Ticks are bucketed by RECEIVED time. Twelve Data stamps gold to the minute (observed: the
 *                  provider timestamp lags up to a minute), which would put ticks into the wrong candle at every
 *                  boundary.
 *   DUPLICATES     A tick with the same received time as the last one accepted is the same tick delivered twice
 *                  (Realtime and a poll can both carry it). Ignored.
 *   OUT OF ORDER   A tick received before the last accepted one is older than the forming candle's last update.
 *                  Ignored — it cannot rewrite a close that a newer tick already set.
 *   BAD PRINTS     A tick more than 3% from the previous one within a minute is a bad print (or another symbol),
 *                  not a market move. Ignored; the next tick is judged against the last good one.
 *   BOUNDARIES     A tick in a later bucket closes the forming candle and opens a new one: open = that first tick.
 *   GAPS           Buckets with no ticks are NOT filled. No flat candles, no carried-forward closes. A gap stays a
 *                  gap until the server's bars backfill it.
 *   PARTIAL OPENS  A candle whose first tick did not follow closely on a tick in the previous bucket is marked
 *                  `partialOpen`: its open is the first price WE saw, not necessarily the period's real open.
 *   MERGING        Server bars are the record, by timestamp: wherever the server has a bar, it REPLACES the local
 *                  candle with that open time (backfill and repair). The one exception is the server's NEWEST bar
 *                  while it may still be forming: the ticks extend it (server open, the wider of the two ranges,
 *                  the newest close). Once the server's newest bar is known to be closed (`serverAsOf` past its
 *                  end) it wins outright. Local candles where the server has none are kept as they are (real
 *                  ticks, marked `live` — unconfirmed); local candles older than the server's first bar are
 *                  outside the window the screen asked for and are dropped.
 *   PRECISION      Prices are compared at the feed's 5 decimals; the merged series is rounded to the display
 *                  precision (2 decimals for gold) so floating-point noise never reaches the screen.
 *
 * What the relay can and cannot see: the worker publishes the NEWEST tick about once a second, so a tick candle
 * is built from ~1 Hz samples. Its high and low can miss a wick that lived between two samples; the server's bar
 * for that period replaces it as soon as it arrives.
 *
 * Pure: no I/O, no clock.
 */
import type { Bar } from "./types";
import type { ChartTf } from "./atlasContract";

export const TF_MS: Record<ChartTf, number> = {
  "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 3_600_000, "4h": 4 * 3_600_000, "1d": 86_400_000,
};

/** One streamed price as the browser holds it. `receivedTs` is when the worker received it from the provider. */
export type LiveTick = { price: number; receivedTs: number; providerTs?: number | null };

/** The feed carries five decimals; anything past that is floating-point noise, not price. */
export const PRICE_DECIMALS = 5;
/** What the chart shows for gold. */
export const DISPLAY_DECIMALS = 2;
export const roundTo = (p: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round((p + (p >= 0 ? Number.EPSILON : -Number.EPSILON)) * f) / f;
};
export const normPrice = (p: number): number => roundTo(p, PRICE_DECIMALS);

/** A jump larger than this between two ticks inside JUMP_WINDOW_MS is a bad print, not a move. */
export const MAX_TICK_JUMP = 0.03;
export const JUMP_WINDOW_MS = 60_000;
/** A first tick in a new bucket arriving within this of the previous tick is that bucket's real open (at the
 *  relay's resolution). Later than this, we may have missed the open. */
export const CONTINUITY_MS = 20_000;
/** Local candles kept per timeframe. The server's bars are the history; this is only the recent edge. */
export const MAX_LOCAL_CANDLES = 600;

/** The candle open time for a timestamp: UTC buckets, optionally on the phase of the server's own bars. */
export function bucketOf(tMs: number, tf: ChartTf, phase = 0): number {
  const ms = TF_MS[tf];
  const ph = ((phase % ms) + ms) % ms;
  return Math.floor((tMs - ph) / ms) * ms + ph;
}

/** The phase the server's bars sit on for this timeframe: the one most of the recent bars share (ties go to the
 *  newest bar's), so a single odd bar — a session-open stamp — cannot shift the grid. 0 = plain UTC alignment. */
export function phaseOf(bars: readonly { t: number }[], tf: ChartTf, sample = 64): number {
  const ms = TF_MS[tf];
  const counts = new Map<number, number>();
  let newest: number | null = null;
  for (let i = bars.length - 1, seen = 0; i >= 0 && seen < sample; i--) {
    const t = bars[i]?.t;
    if (typeof t !== "number" || !Number.isFinite(t)) continue;
    const ph = ((t % ms) + ms) % ms;
    if (newest == null) newest = ph;
    counts.set(ph, (counts.get(ph) ?? 0) + 1);
    seen++;
  }
  if (newest == null) return 0;
  let best = newest, bestN = counts.get(newest) ?? 0;
  for (const [ph, n] of counts) if (n > bestN) { best = ph; bestN = n; }
  return best;
}

export type TickVerdict = "accept" | "duplicate" | "out_of_order" | "invalid" | "outlier";

/** Is `next` a new, believable tick after `last`? The one intake rule for the hook and the candle book. */
export function tickVerdict(last: LiveTick | null | undefined, next: LiveTick | null | undefined): TickVerdict {
  if (!next || typeof next.price !== "number" || !Number.isFinite(next.price) || !(next.price > 0) || typeof next.receivedTs !== "number" || !Number.isFinite(next.receivedTs)) return "invalid";
  if (!last) return "accept";
  if (next.receivedTs === last.receivedTs) return "duplicate";
  if (next.receivedTs < last.receivedTs) return "out_of_order";
  if (next.receivedTs - last.receivedTs <= JUMP_WINDOW_MS && Math.abs(next.price - last.price) / last.price > MAX_TICK_JUMP) return "outlier";
  return "accept";
}

/** A candle built from ticks. */
export type LiveCandle = Bar & {
  /** Ticks folded into it. */
  n: number;
  /** Received time of its first and newest tick. */
  firstAt: number;
  lastAt: number;
  /** Its open is the first price we saw, which may not be the period's real open. */
  partialOpen: boolean;
};

/** The ticks folded so far for one timeframe. `last` is the last ACCEPTED tick. */
export type CandleBook = { tf: ChartTf; phase: number; candles: LiveCandle[]; last: LiveTick | null };

export const emptyBook = (tf: ChartTf, phase = 0): CandleBook => ({ tf, phase, candles: [], last: null });

/** Fold one tick into the book. Pure: returns the SAME book when the tick is ignored. */
export function applyTick(book: CandleBook, tick: LiveTick, maxCandles = MAX_LOCAL_CANDLES): CandleBook {
  if (tickVerdict(book.last, tick) !== "accept") return book;
  const price = normPrice(tick.price);
  const t = bucketOf(tick.receivedTs, book.tf, book.phase);
  const cur = book.candles[book.candles.length - 1];
  const last: LiveTick = { price, receivedTs: tick.receivedTs, providerTs: tick.providerTs ?? null };

  if (cur && cur.t === t) {
    const next: LiveCandle = { ...cur, h: Math.max(cur.h, price), l: Math.min(cur.l, price), c: price, n: cur.n + 1, lastAt: tick.receivedTs };
    return { ...book, candles: [...book.candles.slice(0, -1), next], last };
  }
  // Older than the forming candle's period. The verdict already refuses anything received before the last
  // tick, so this only guards a book whose phase changed under it.
  if (cur && t < cur.t) return book;

  // A boundary was crossed. Whatever buckets lie between are left empty — never filled.
  const continuous = book.last != null && tick.receivedTs - book.last.receivedTs <= CONTINUITY_MS;
  const fresh: LiveCandle = { t, o: price, h: price, l: price, c: price, n: 1, firstAt: tick.receivedTs, lastAt: tick.receivedTs, partialOpen: !continuous };
  const candles = [...book.candles, fresh];
  return { ...book, candles: candles.length > maxCandles ? candles.slice(-maxCandles) : candles, last };
}

/** Fold ticks IN ARRIVAL ORDER (so a late tick is dropped, as it would be live) into candles of one timeframe.
 *  Same rules as applyTick, folded in place for speed: the chart re-runs this on every tick. */
export function candlesFromTicks(ticks: readonly LiveTick[], tf: ChartTf, phase = 0): LiveCandle[] {
  const out: LiveCandle[] = [];
  let last: LiveTick | null = null;
  for (const k of ticks) {
    if (tickVerdict(last, k) !== "accept") continue;
    const price = normPrice(k.price);
    const t = bucketOf(k.receivedTs, tf, phase);
    const cur = out[out.length - 1];
    if (cur && cur.t === t) {
      if (price > cur.h) cur.h = price;
      if (price < cur.l) cur.l = price;
      cur.c = price; cur.n += 1; cur.lastAt = k.receivedTs;
    } else if (!cur || t > cur.t) {
      const continuous = last != null && k.receivedTs - last.receivedTs <= CONTINUITY_MS;
      out.push({ t, o: price, h: price, l: price, c: price, n: 1, firstAt: k.receivedTs, lastAt: k.receivedTs, partialOpen: !continuous });
    } else continue;
    last = { price, receivedTs: k.receivedTs, providerTs: k.providerTs ?? null };
  }
  return out.length > MAX_LOCAL_CANDLES ? out.slice(-MAX_LOCAL_CANDLES) : out;
}

/** A candle on the chart. `live` marks one built (wholly or partly) from ticks; the server has not confirmed it. */
export type ChartCandle = Bar & { live?: true; partialOpen?: true };

const validBar = (b: Bar | null | undefined): b is Bar =>
  !!b && [b.t, b.o, b.h, b.l, b.c].every((x) => typeof x === "number" && Number.isFinite(x));

export type MergeOptions = {
  /** When the server's bars were known to be current. With it, a newest server bar whose period had already
   *  ended is final and wins outright, and the merged close comes from whichever source is newer. Without it
   *  the ticks are assumed newer — they are the real-time path. */
  serverAsOf?: number | null;
  /** Rounding of the merged series. Default DISPLAY_DECIMALS. */
  decimals?: number;
};

/** Server bars and tick candles, as one series sorted by open time. See MERGING at the top of this file. */
export function mergeCandles(
  server: readonly Bar[],
  local: readonly LiveCandle[],
  tf: ChartTf,
  opts: MergeOptions = {},
): ChartCandle[] {
  const ms = TF_MS[tf];
  const d = opts.decimals ?? DISPLAY_DECIMALS;
  const r = (p: number) => roundTo(p, d);
  const byT = new Map<number, ChartCandle>();
  for (const b of server) {
    if (!validBar(b)) continue;
    // A later bar for the same open time is the repaired one: it replaces the earlier.
    byT.set(b.t, { t: b.t, o: r(b.o), h: r(b.h), l: r(b.l), c: r(b.c), ...(b.v != null && Number.isFinite(b.v) ? { v: b.v } : {}) });
  }
  let first = Infinity, newestT = -Infinity;
  for (const t of byT.keys()) { if (t < first) first = t; if (t > newestT) newestT = t; }
  const newest = byT.get(newestT) ?? null;
  const asOf = opts.serverAsOf != null && Number.isFinite(opts.serverAsOf) ? opts.serverAsOf : null;
  const serverFinal = newest != null && asOf != null && asOf >= newestT + ms;

  const seenLocal = new Set<number>();
  for (const c of local) {
    if (!validBar(c) || seenLocal.has(c.t)) continue;
    seenLocal.add(c.t);
    if (newest && c.t < first) continue;                       // before the window the screen asked for
    const srv = byT.get(c.t);
    if (srv) {
      if (c.t !== newestT || serverFinal) continue;              // the server's bar is the record for that period
      const ticksNewer = asOf == null || c.lastAt >= asOf;
      byT.set(c.t, {
        t: c.t, o: srv.o,
        h: Math.max(srv.h, r(c.h)), l: Math.min(srv.l, r(c.l)),
        c: ticksNewer ? r(c.c) : srv.c,
        ...(srv.v != null ? { v: srv.v } : {}),
        live: true,
      });
      continue;
    }
    // A period the server has no bar for: real ticks, shown as unconfirmed. Never filled in between.
    byT.set(c.t, { t: c.t, o: r(c.o), h: r(c.h), l: r(c.l), c: r(c.c), live: true, ...(c.partialOpen ? { partialOpen: true as const } : {}) });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * The chart's series for one timeframe: the server's bars, with the streamed ticks moving the newest candle and
 * opening new ones as boundaries pass (mergeCandles). Ticks from before the server's first bar are outside the
 * window the screen asked for and are not folded.
 */
export function withLiveCandles(
  server: readonly Bar[],
  ticks: readonly LiveTick[],
  tf: ChartTf,
  opts: MergeOptions = {},
): ChartCandle[] {
  const phase = phaseOf(server, tf);
  let first = Infinity;
  for (const b of server) if (validBar(b) && b.t < first) first = b.t;
  const from = Number.isFinite(first) ? first : -Infinity;
  const relevant: LiveTick[] = [];
  for (const k of ticks) if (k && k.receivedTs >= from) relevant.push(k);
  return mergeCandles(server, candlesFromTicks(relevant, tf, phase), tf, opts);
}

/** Open times of the candles a chart holds, for validating ATLAS's mark_candle actions. */
export const candleTimes = (bars: readonly { t: number }[]): number[] => bars.map((b) => b.t);
