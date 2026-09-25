import type { Bar, Timeframe } from "../core/types";

export const TF_MINUTES: Record<Timeframe, number> = { M5: 5, M15: 15, H1: 60, H4: 240, D1: 1440, W1: 10080 };
export const TF_MS: Record<Timeframe, number> = {
  M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000, W1: 604_800_000,
};

/**
 * Aggregate a 1-minute series into a higher timeframe. Only fully-elapsed buckets are returned when
 * `closedOnly`, because a forming bar must never be used as if it had closed.
 */
export function aggregate(m1: Bar[], minutes: number, closedOnly = true, now?: number): Bar[] {
  const ms = minutes * 60_000;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of m1) {
    const bucket = Math.floor(b.t / ms) * ms;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? null };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      if (b.v != null) cur.v = (cur.v ?? 0) + b.v;
    }
  }
  if (cur) out.push(cur);
  if (closedOnly && out.length) {
    const ref = now ?? (m1.length ? m1[m1.length - 1].t + 60_000 : 0);
    if (ref < out[out.length - 1].t + ms) out.pop();
  }
  return out;
}

/** Only bars whose interval has fully elapsed as of `now`. */
export function closedBars(bars: Bar[], intervalMs: number, now: number): Bar[] {
  let n = bars.length;
  while (n > 0 && bars[n - 1].t + intervalMs > now) n--;
  return n === bars.length ? bars : bars.slice(0, n);
}

/**
 * Merge incoming bars into an existing series.
 *
 * A corrected historical bar REPLACES its predecessor and is reported, so the caller can issue a new
 * analysis version. It never rewrites a decision that has already been made — that is the caller's
 * contract, enforced by freezing setup references.
 */
export function mergeBars(
  existing: Bar[],
  incoming: Bar[],
  max = 8000,
): { bars: Bar[]; added: number; corrected: Bar[]; outOfOrder: number } {
  const map = new Map<number, Bar>(existing.map((b) => [b.t, b]));
  const corrected: Bar[] = [];
  let added = 0;
  let outOfOrder = 0;
  const lastT = existing.length ? existing[existing.length - 1].t : -Infinity;
  for (const b of incoming) {
    if (!Number.isFinite(b.t) || !(b.h >= b.l) || !(b.o > 0) || !(b.c > 0)) continue;
    const e = map.get(b.t);
    if (e) {
      if (e.o !== b.o || e.h !== b.h || e.l !== b.l || e.c !== b.c) corrected.push(b);
    } else {
      added++;
      if (b.t < lastT) outOfOrder++;
    }
    map.set(b.t, b);
  }
  const bars = [...map.values()].sort((a, b) => a.t - b.t);
  return { bars: bars.length > max ? bars.slice(-max) : bars, added, corrected, outOfOrder };
}

/** Wilder's ATR over closed bars. Returns null when there is not enough history. */
export function atr(bars: Bar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const prev = bars[i - 1];
    const b = bars[i];
    sum += Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
  }
  return sum / period;
}

/** Body / total range of a bar. A doji returns 0 rather than dividing by zero. */
export function bodyRatio(b: Bar): number {
  const range = b.h - b.l;
  if (!(range > 0)) return 0;
  return Math.abs(b.c - b.o) / range;
}

/**
 * Where the close sits within the bar's range: 0 at the low, 1 at the high.
 * A zero-range bar returns 0.5 — neutral, so it can never satisfy an "outer 30%" test.
 */
export function closePosition(b: Bar): number {
  const range = b.h - b.l;
  if (!(range > 0)) return 0.5;
  return (b.c - b.l) / range;
}

/** Gaps in a 1-minute series, reported for honesty rather than filled. */
export function findGaps(m1: Bar[], maxGapMin = 5): Array<{ from: number; to: number; minutes: number }> {
  const gaps: Array<{ from: number; to: number; minutes: number }> = [];
  for (let i = 1; i < m1.length; i++) {
    const d = (m1[i].t - m1[i - 1].t) / 60_000;
    if (d > maxGapMin && d < 60 * 40) gaps.push({ from: m1[i - 1].t, to: m1[i].t, minutes: d });
  }
  return gaps;
}
