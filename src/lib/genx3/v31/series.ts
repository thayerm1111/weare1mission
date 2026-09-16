/**
 * GENX 3.1 series engine. Built once from CLOSED 1m bars; every accessor takes `asOf` and
 * only exposes bars whose period has fully elapsed by then, so the same object can be used by
 * production (window ending now) and by replay (whole history, evaluated step by step) with
 * no look-ahead. Indicators are causal (value at i uses bars ≤ i only).
 */
import type { Bar } from "../candles";

export const M = 60_000;
export const SIZES = { m1: M, m5: 5 * M, m15: 15 * M, h1: 60 * M, h4: 240 * M } as const;
export type TFKey = keyof typeof SIZES;

export type TF = { size: number; bars: Bar[]; t: Float64Array; atr: Float64Array; ema20: Float64Array; ema50: Float64Array; atrAvgPrefix: Float64Array };

export function aggregateAll(m1: Bar[], size: number): Bar[] {
  if (size === M) return m1;
  const out: Bar[] = []; let cur: Bar | null = null;
  for (const b of m1) {
    const k = Math.floor(b.t / size) * size;
    if (!cur || cur.t !== k) { if (cur) out.push(cur); cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c }; }
    else { if (b.h > cur.h) cur.h = b.h; if (b.l < cur.l) cur.l = b.l; cur.c = b.c; }
  }
  if (cur) out.push(cur);
  return out;
}

function build(bars: Bar[], size: number, atrN = 14): TF {
  const n = bars.length;
  const t = new Float64Array(n), atr = new Float64Array(n), e20 = new Float64Array(n), e50 = new Float64Array(n), pre = new Float64Array(n + 1);
  const k20 = 2 / 21, k50 = 2 / 51;
  for (let i = 0; i < n; i++) {
    const b = bars[i]; t[i] = b.t;
    const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l;
    atr[i] = i === 0 ? tr : i < atrN ? (atr[i - 1] * i + tr) / (i + 1) : (atr[i - 1] * (atrN - 1) + tr) / atrN;
    e20[i] = i ? b.c * k20 + e20[i - 1] * (1 - k20) : b.c;
    e50[i] = i ? b.c * k50 + e50[i - 1] * (1 - k50) : b.c;
    pre[i + 1] = pre[i] + atr[i];
  }
  return { size, bars, t, atr, ema20: e20, ema50: e50, atrAvgPrefix: pre };
}

export type Series = { m1: TF; m5: TF; m15: TF; h1: TF; h4: TF };
export function buildSeries(closed1m: Bar[]): Series {
  return { m1: build(closed1m, M), m5: build(aggregateAll(closed1m, SIZES.m5), SIZES.m5), m15: build(aggregateAll(closed1m, SIZES.m15), SIZES.m15), h1: build(aggregateAll(closed1m, SIZES.h1), SIZES.h1), h4: build(aggregateAll(closed1m, SIZES.h4), SIZES.h4) };
}

/** Index of the last bar CLOSED at asOf (open + size ≤ asOf), or -1. */
export function lastClosed(tf: TF, asOf: number): number {
  const lim = asOf - tf.size; let lo = 0, hi = tf.t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tf.t[m] <= lim) lo = m + 1; else hi = m; }
  return lo - 1;
}
/** Mean ATR over bars (i-n, i]. */
export function atrMean(tf: TF, i: number, n: number): number { const a = Math.max(0, i - n + 1); return (tf.atrAvgPrefix[i + 1] - tf.atrAvgPrefix[a]) / (i + 1 - a); }

export function efficiencyAt(tf: TF, i: number, n: number): number {
  if (i < n) return 0; let path = 0;
  for (let k = i - n + 1; k <= i; k++) path += Math.abs(tf.bars[k].c - tf.bars[k - 1].c);
  return path > 0 ? Math.abs(tf.bars[i].c - tf.bars[i - n].c) / path : 0;
}
export function hiLo(tf: TF, from: number, to: number): { h: number; l: number } {
  let h = -Infinity, l = Infinity; for (let k = Math.max(0, from); k <= to; k++) { if (tf.bars[k].h > h) h = tf.bars[k].h; if (tf.bars[k].l < l) l = tf.bars[k].l; } return { h, l };
}

export type Pivot = { kind: "high" | "low"; i: number; price: number; t: number };
/** Pivots confirmed by bar i (need `right` closed bars after the pivot). */
export function confirmedPivots(tf: TF, i: number, left: number, right: number, lookback: number): Pivot[] {
  const out: Pivot[] = [];
  for (let p = Math.max(left, i - lookback); p <= i - right; p++) {
    const b = tf.bars[p]; let hi = true, lo = true;
    for (let k = p - left; k <= p + right; k++) { if (k === p) continue; if (tf.bars[k].h >= b.h) hi = false; if (tf.bars[k].l <= b.l) lo = false; if (!hi && !lo) break; }
    if (hi) out.push({ kind: "high", i: p, price: b.h, t: b.t });
    if (lo) out.push({ kind: "low", i: p, price: b.l, t: b.t });
  }
  return out;
}

/** XAUUSD trading hours (New York time): Sunday 18:00 → Friday 17:00, daily break 17:00–18:00.
 *  The data provider also publishes weekend/break quotes that no broker executes; those bars are
 *  dropped before any analysis so they cannot distort ATR, levels or structure. */
const nyHourCache = new Map<number, { dow: number; hour: number }>();
const fmtNY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit" });
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function goldMarketOpen(tMs: number): boolean {
  const hk = Math.floor(tMs / 3_600_000);
  let v = nyHourCache.get(hk);
  if (!v) {
    const parts = fmtNY.formatToParts(new Date(hk * 3_600_000 + 1));
    v = { dow: DOW[parts.find((p) => p.type === "weekday")!.value], hour: Number(parts.find((p) => p.type === "hour")!.value) % 24 };
    if (nyHourCache.size > 50_000) nyHourCache.clear();
    nyHourCache.set(hk, v);
  }
  if (v.dow === 6) return false;
  if (v.dow === 0) return v.hour >= 18;
  if (v.dow === 5) return v.hour < 17;
  return v.hour !== 17;
}
export function tradableOnly(bars: Bar[]): Bar[] { return bars.filter((b) => goldMarketOpen(b.t)); }
