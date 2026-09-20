/**
 * THE MATHEMATICAL MARKET ENGINE — pure measurements, nothing else.
 *
 * Every function takes bars and returns a number. No opinions ("bullish"), no I/O, no state. Opinions are
 * formed a layer up, out of these numbers, so that a disagreement about the market becomes a disagreement
 * about a specific measurement.
 */
import type { Bar, Features } from "./types";

export const last = <T>(a: T[]): T | null => (a.length ? a[a.length - 1] : null);
export const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
export const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function stdev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / (a.length - 1));
}

export function trueRange(bars: Bar[], i: number): number {
  const b = bars[i];
  if (i === 0) return b.h - b.l;
  const p = bars[i - 1].c;
  return Math.max(b.h - b.l, Math.abs(b.h - p), Math.abs(b.l - p));
}

export function atr(bars: Bar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) s += trueRange(bars, i);
  return s / n;
}

/** Least-squares slope of closes (price per bar) and the R² that says how much to trust it. */
export function regression(bars: Bar[], n: number): { slope: number; r2: number } | null {
  if (bars.length < n || n < 3) return null;
  const w = bars.slice(-n);
  const mx = (n - 1) / 2;
  const my = mean(w.map((b) => b.c));
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const dx = i - mx; num += dx * (w[i].c - my); den += dx * dx; }
  const slope = den === 0 ? 0 : num / den;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fit = my + slope * (i - mx);
    ssRes += (w[i].c - fit) ** 2;
    ssTot += (w[i].c - my) ** 2;
  }
  return { slope, r2: ssTot === 0 ? 0 : clamp(1 - ssRes / ssTot, 0, 1) };
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(bars: Bar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let up = 0, down = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    if (d >= 0) up += d; else down -= d;
  }
  if (up + down === 0) return 50;
  return (100 * up) / (up + down);
}

/** Kaufman efficiency: how much of the travel became direction. 1 = a straight line, 0 = pure churn. */
export function efficiency(bars: Bar[], n = 20): number | null {
  if (bars.length < n + 1) return null;
  const w = bars.slice(-(n + 1));
  const net = Math.abs(w[w.length - 1].c - w[0].c);
  let path = 0;
  for (let i = 1; i < w.length; i++) path += Math.abs(w[i].c - w[i - 1].c);
  return path === 0 ? 0 : clamp(net / path, 0, 1);
}

/** Where the last close sits versus the recent distribution, in standard deviations. */
export function zScore(bars: Bar[], n = 50): number | null {
  if (bars.length < n) return null;
  const closes = bars.slice(-n).map((b) => b.c);
  const sd = stdev(closes);
  return sd === 0 ? 0 : (closes[closes.length - 1] - mean(closes)) / sd;
}

/** Signed body dominance over n bars: who is actually closing the candles. -1..1 */
export function bodyBias(bars: Bar[], n = 10): number {
  const w = bars.slice(-n);
  if (!w.length) return 0;
  return mean(w.map((b) => (b.c - b.o) / Math.max(b.h - b.l, 1e-9)));
}

/** Upper wicks minus lower wicks: where price is being rejected. -1..1 */
export function wickBias(bars: Bar[], n = 10): number {
  const w = bars.slice(-n);
  if (!w.length) return 0;
  return mean(w.map((b) => {
    const rng = Math.max(b.h - b.l, 1e-9);
    return ((b.h - Math.max(b.o, b.c)) - (Math.min(b.o, b.c) - b.l)) / rng;
  }));
}

/** Current bar range versus the recent average: is the market expanding or contracting? */
export function rangeExpansion(bars: Bar[], n = 20): number | null {
  if (bars.length < n + 1) return null;
  const recent = mean(bars.slice(-(n + 1), -1).map((b) => b.h - b.l));
  const cur = (last(bars) as Bar).h - (last(bars) as Bar).l;
  return recent === 0 ? 1 : cur / recent;
}

/** The full feature vector for one timeframe. Null when there is not enough history to be honest. */
/**
 * How busy the last bar was, against how busy this market usually is.
 *
 * The feed's `v` on a spot-gold bar is a TICK COUNT — how many times the price updated — not a
 * traded quantity, because spot gold is OTC and no such quantity exists. As an input it is still
 * worth having: a break on four times the usual tick rate is a different event from a break on half
 * of it, and that is what every "volume" rule on retail gold has always actually measured.
 *
 * Returns nulls rather than zeros when the feed sends nothing, so downstream code can tell "quiet"
 * from "cannot see". Anything that treats a missing tick count as a low one is lying about what it
 * knows.
 */
export function activity(bars: Bar[], lookback = 20): { ticks: number | null; relativeActivity: number | null } {
  const l = last(bars) as Bar | undefined;
  const ticks = l && typeof l.v === "number" && Number.isFinite(l.v) ? l.v : null;
  if (ticks == null) return { ticks: null, relativeActivity: null };

  const prior = bars.slice(-(lookback + 1), -1)
    .map((b) => b.v)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  // One or two stray values is not an average worth dividing by.
  if (prior.length < Math.max(5, Math.floor(lookback / 2))) return { ticks, relativeActivity: null };

  const mean = prior.reduce((s, v) => s + v, 0) / prior.length;
  if (!(mean > 0)) return { ticks, relativeActivity: null };
  return { ticks, relativeActivity: ticks / mean };
}

export function features(bars: Bar[]): Features | null {
  if (bars.length < 60) return null;
  const a = atr(bars, 14);
  const aSlow = atr(bars, 50);
  const reg = regression(bars, 20);
  const c = (last(bars) as Bar).c;
  if (a == null || aSlow == null || !reg || !(a > 0)) return null;

  const closes = bars.map((b) => b.c);
  const r1 = (c - bars[bars.length - 2].c) / a;
  const r5 = (c - bars[bars.length - 6].c) / a;
  const vel = r5 / 5;
  const velPrev = (bars[bars.length - 6].c - bars[bars.length - 11].c) / a / 5;

  return {
    atr: a,
    atrPct: (a / c) * 100,
    volRatio: aSlow === 0 ? 1 : a / aSlow,
    returns1: r1,
    returns5: r5,
    velocity: vel,
    acceleration: vel - velPrev,
    slope: (reg.slope * 20) / a,
    slopeR2: reg.r2,
    rsi: rsi(bars, 14) ?? 50,
    efficiency: efficiency(bars, 20) ?? 0,
    bodyBias: bodyBias(bars, 10),
    wickBias: wickBias(bars, 10),
    rangeExpansion: rangeExpansion(bars, 20) ?? 1,
    zScore: zScore(bars, 50) ?? 0,
    ...activity(bars, 20),
  };
}
