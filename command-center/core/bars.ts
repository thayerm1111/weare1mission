/**
 * TICKS → BARS → HIGHER TIMEFRAMES.
 *
 * One place owns this mapping, so a 15-minute candle means exactly the same thing in the live engine, the
 * shadow recorder and replay. Bars are stamped at their OPEN time and a bar is only "closed" once the clock
 * has passed its end — a decision must never be taken on a candle that is still forming unless it asks for
 * the forming one explicitly.
 */
import type { Bar, Tick, Timeframe } from "./types";
import { TF_MINUTES } from "./types";

export const bucketStart = (tMs: number, tfMinutes: number): number => {
  const ms = tfMinutes * 60_000;
  return Math.floor(tMs / ms) * ms;
};

/** Fold ticks into bars of one timeframe. Ticks may arrive out of order; the result is always sorted. */
export function barsFromTicks(ticks: Tick[], tf: Timeframe): Bar[] {
  const m = TF_MINUTES[tf];
  const byBucket = new Map<number, Bar>();
  for (const k of [...ticks].sort((a, b) => a.t - b.t)) {
    const t = bucketStart(k.t, m);
    const cur = byBucket.get(t);
    if (!cur) byBucket.set(t, { t, o: k.mid, h: k.mid, l: k.mid, c: k.mid });
    else { cur.h = Math.max(cur.h, k.mid); cur.l = Math.min(cur.l, k.mid); cur.c = k.mid; }
  }
  return [...byBucket.values()].sort((a, b) => a.t - b.t);
}

/** Aggregate finished bars into a higher timeframe. Partial trailing buckets are dropped by default. */
export function resample(bars: Bar[], from: Timeframe, to: Timeframe, opts: { keepForming?: boolean } = {}): Bar[] {
  const fm = TF_MINUTES[from], tm = TF_MINUTES[to];
  if (tm % fm !== 0) throw new Error(`cannot resample ${from} → ${to}: not a multiple`);
  const per = tm / fm;
  const byBucket = new Map<number, { bar: Bar; n: number }>();
  for (const b of [...bars].sort((a, b2) => a.t - b2.t)) {
    const t = bucketStart(b.t, tm);
    const cur = byBucket.get(t);
    if (!cur) byBucket.set(t, { bar: { t, o: b.o, h: b.h, l: b.l, c: b.c }, n: 1 });
    else { cur.bar.h = Math.max(cur.bar.h, b.h); cur.bar.l = Math.min(cur.bar.l, b.l); cur.bar.c = b.c; cur.n += 1; }
  }
  const out = [...byBucket.values()];
  const keep = opts.keepForming ? out : out.filter((x, i) => i < out.length - 1 || x.n >= per);
  return keep.map((x) => x.bar).sort((a, b) => a.t - b.t);
}

/** Has this bar finished, given the clock? A rule that reads a forming bar must say so out loud. */
export const isClosed = (bar: Bar, tf: Timeframe, nowMs: number): boolean =>
  nowMs >= bar.t + TF_MINUTES[tf] * 60_000;

/** The most recent CLOSED bar — what confirmation rules are allowed to read. */
export function lastClosed(bars: Bar[], tf: Timeframe, nowMs: number): Bar | null {
  for (let i = bars.length - 1; i >= 0; i--) if (isClosed(bars[i], tf, nowMs)) return bars[i];
  return null;
}

/** Bars with no gap longer than `maxGapMs` — a feed outage must not look like a quiet market. */
export function hasGaps(bars: Bar[], tf: Timeframe, maxGapFactor = 3): boolean {
  const step = TF_MINUTES[tf] * 60_000;
  for (let i = 1; i < bars.length; i++) if (bars[i].t - bars[i - 1].t > step * maxGapFactor) return true;
  return false;
}
