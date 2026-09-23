import type { Bar } from "../core/types";

/** Aggregate M1 bars into a higher timeframe (minutes). Only COMPLETE buckets are returned when `closedOnly`. */
export function aggregate(m1: Bar[], minutes: number, closedOnly = true, now?: number): Bar[] {
  const ms = minutes * 60_000;
  const out: Bar[] = [];
  let cur: Bar | null = null; let count = 0;
  for (const b of m1) {
    const bucket = Math.floor(b.t / ms) * ms;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? null }; count = 1;
    } else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; if (b.v != null) cur.v = (cur.v ?? 0) + b.v; count++; }
  }
  if (cur) out.push(cur);
  if (closedOnly && out.length) {
    const lastBucketEnd = out[out.length - 1].t + ms;
    const ref = now ?? (m1.length ? m1[m1.length - 1].t + 60_000 : 0);
    if (ref < lastBucketEnd) out.pop();
  }
  void count;
  return out;
}

/** Insert/replace bars by timestamp, keep sorted, drop duplicates and out-of-order noise. Returns a new array. */
export function mergeBars(existing: Bar[], incoming: Bar[], max = 6000): { bars: Bar[]; added: number; replaced: number; outOfOrder: number } {
  const map = new Map<number, Bar>(existing.map((b) => [b.t, b]));
  let added = 0, replaced = 0, outOfOrder = 0;
  const lastT = existing.length ? existing[existing.length - 1].t : -Infinity;
  for (const b of incoming) {
    if (!Number.isFinite(b.t) || !(b.h >= b.l) || !(b.o > 0) || !(b.c > 0)) continue;
    if (map.has(b.t)) { const e = map.get(b.t)!; if (e.o !== b.o || e.h !== b.h || e.l !== b.l || e.c !== b.c) replaced++; }
    else { added++; if (b.t < lastT) outOfOrder++; }
    map.set(b.t, b);
  }
  const bars = [...map.values()].sort((a, b) => a.t - b.t);
  return { bars: bars.length > max ? bars.slice(-max) : bars, added, replaced, outOfOrder };
}

/** Only bars whose interval has fully elapsed as of `now` are closed. */
export function closedBars(bars: Bar[], intervalMs: number, now: number): Bar[] {
  let n = bars.length;
  while (n > 0 && bars[n - 1].t + intervalMs > now) n--;
  return n === bars.length ? bars : bars.slice(0, n);
}

/** Gaps in a 1-minute series (excluding weekends), reported for honesty rather than filled. */
export function findGaps(m1: Bar[], maxGapMin = 5): Array<{ from: number; to: number; minutes: number }> {
  const gaps: Array<{ from: number; to: number; minutes: number }> = [];
  for (let i = 1; i < m1.length; i++) {
    const d = (m1[i].t - m1[i - 1].t) / 60_000;
    if (d > maxGapMin && d < 60 * 40) gaps.push({ from: m1[i - 1].t, to: m1[i].t, minutes: d });
  }
  return gaps;
}
