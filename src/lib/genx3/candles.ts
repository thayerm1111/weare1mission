/**
 * Candle engine. All times are UTC epoch ms at the bar OPEN. A bar of timeframe T is
 * CLOSED only when open + T <= asOf. Higher timeframes are aggregated from CLOSED 1m bars
 * on exact UTC boundaries (4h aligned to 00:00 UTC). The forming bar is kept separate and
 * never used as closed.
 */
export type Bar = { t: number; o: number; h: number; l: number; c: number };
export type TF = "1m" | "5m" | "15m" | "1h" | "4h";
export const TF_MS: Record<TF, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };

export type DataHealth = {
  state: "HEALTHY" | "DEGRADED" | "INVALID";
  issues: string[];
  newestClosed1m: number | null;   // bar open ms
  feedAgeMs: number | null;        // asOf − close time of newest closed 1m bar
  gaps: number; duplicates: number; outOfOrder: number; spikes: number;
};

/** Sort, de-duplicate (last write wins), drop invalid OHLC, and split closed vs forming. */
export function normalize1m(raw: Bar[], asOf: number): { closed: Bar[]; forming: Bar | null; duplicates: number; outOfOrder: number; invalid: number } {
  let outOfOrder = 0, invalid = 0;
  for (let i = 1; i < raw.length; i++) if (raw[i].t < raw[i - 1].t) outOfOrder++;
  const byT = new Map<number, Bar>();
  let duplicates = 0;
  for (const b of raw) {
    const ok = [b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0) && b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c) && b.t % 60_000 === 0;
    if (!ok) { invalid++; continue; }
    if (byT.has(b.t)) duplicates++;
    byT.set(b.t, b);
  }
  const all = [...byT.values()].sort((a, b) => a.t - b.t);
  const closed = all.filter((b) => b.t + TF_MS["1m"] <= asOf);
  const forming = all.find((b) => b.t + TF_MS["1m"] > asOf && b.t <= asOf) ?? null;
  return { closed, forming, duplicates, outOfOrder, invalid };
}

/** Aggregate CLOSED 1m bars into CLOSED bars of tf. A bucket is emitted only if its whole
 *  period has elapsed by asOf; buckets with fewer than minFill of their minutes present are
 *  still emitted (gold has sparse minutes) but counted as gappy via the health check. */
export function aggregate(closed1m: Bar[], tf: TF, asOf: number): Bar[] {
  if (tf === "1m") return closed1m;
  const size = TF_MS[tf];
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of closed1m) {
    const bucket = Math.floor(b.t / size) * size;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c };
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c;
    }
  }
  if (cur) out.push(cur);
  return out.filter((x) => x.t + size <= asOf);
}

export function atr(bars: Bar[], period: number, end = bars.length): number | null {
  if (end < period + 1) return null;
  let s = 0;
  for (let i = end - period; i < end; i++) {
    const p = bars[i - 1].c;
    s += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - p), Math.abs(bars[i].l - p));
  }
  return s / period;
}

/** Data-health check over the recent analysis window. Market-closed periods (weekend,
 *  daily break) are not gaps. */
export function checkHealth(o: {
  closed1m: Bar[]; asOf: number; maxFeedAgeMs: number; maxGapBars: number; spikeAtrMultiple: number;
  duplicates: number; outOfOrder: number; invalid: number; liveTick?: number | null; feedDisagreeUsd: number;
}): DataHealth {
  const issues: string[] = [];
  const n = o.closed1m.length;
  const newest = n ? o.closed1m[n - 1].t : null;
  const feedAgeMs = newest != null ? o.asOf - (newest + TF_MS["1m"]) : null;
  if (newest == null) issues.push("no_closed_bars");
  else if (feedAgeMs! > o.maxFeedAgeMs) issues.push(`stale_feed_${Math.round(feedAgeMs! / 1000)}s`);
  // gaps in the last 90 minutes (ignore the daily/weekend closures: gaps > 45 min)
  let gaps = 0;
  const since = o.asOf - 90 * 60_000;
  for (let i = 1; i < n; i++) {
    if (o.closed1m[i].t < since) continue;
    const missing = (o.closed1m[i].t - o.closed1m[i - 1].t) / 60_000 - 1;
    if (missing > 0 && missing < 45) gaps += missing;
  }
  if (gaps > o.maxGapBars) issues.push(`gaps_${gaps}`);
  let spikes = 0;
  const a = atr(o.closed1m, 60);
  if (a != null) for (let i = Math.max(1, n - 30); i < n; i++) if (o.closed1m[i].h - o.closed1m[i].l > o.spikeAtrMultiple * a * 4) spikes++;
  if (spikes) issues.push(`spike_bars_${spikes}`);
  if (o.outOfOrder) issues.push(`out_of_order_${o.outOfOrder}`);
  if (o.invalid) issues.push(`invalid_bars_${o.invalid}`);
  if (o.liveTick != null && newest != null && Math.abs(o.liveTick - o.closed1m[n - 1].c) > o.feedDisagreeUsd) issues.push(`feed_disagreement_tick_${o.liveTick}_bar_${o.closed1m[n - 1].c}`);
  const hard = issues.some((x) => /^(no_closed_bars|stale_feed|spike_bars|feed_disagreement|gaps_)/.test(x));
  const state = hard ? "INVALID" : issues.length || o.duplicates ? "DEGRADED" : "HEALTHY";
  return { state, issues, newestClosed1m: newest, feedAgeMs, gaps, duplicates: o.duplicates, outOfOrder: o.outOfOrder, spikes };
}
