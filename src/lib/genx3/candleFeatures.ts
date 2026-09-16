import type { Bar } from "./candles";

/** Numeric candle measurements. Named patterns are never a trade reason on their own. */
export type CandleFeatures = {
  body: number; range: number; upperWick: number; lowerWick: number;
  bodyToRange: number; closeLocation: number;          // 0 = at low, 1 = at high
  rangeToAtr: number | null; bodyToMedianBody: number | null;
  bullish: boolean; bearish: boolean;
  engulfingBull: boolean; engulfingBear: boolean;
  rejectionBull: boolean; rejectionBear: boolean;      // long lower / upper wick, close in the upper / lower third
  indecision: boolean; expansion: boolean;
  consecutiveBull: number; consecutiveBear: number;
};

export function candleFeatures(bars: Bar[], atrVal: number | null, i = bars.length - 1): CandleFeatures | null {
  const b = bars[i]; if (!b) return null;
  const p = bars[i - 1];
  const range = b.h - b.l, body = Math.abs(b.c - b.o);
  const upperWick = b.h - Math.max(b.o, b.c), lowerWick = Math.min(b.o, b.c) - b.l;
  const closeLocation = range > 0 ? (b.c - b.l) / range : 0.5;
  const bodies = bars.slice(Math.max(0, i - 20), i).map((x) => Math.abs(x.c - x.o)).sort((a, z) => a - z);
  const med = bodies.length ? bodies[Math.floor(bodies.length / 2)] : null;
  let cb = 0, cs = 0;
  for (let k = i; k >= 0 && bars[k].c > bars[k].o; k--) cb++;
  for (let k = i; k >= 0 && bars[k].c < bars[k].o; k--) cs++;
  return {
    body, range, upperWick, lowerWick,
    bodyToRange: range > 0 ? body / range : 0, closeLocation,
    rangeToAtr: atrVal ? range / atrVal : null,
    bodyToMedianBody: med ? body / med : null,
    bullish: b.c > b.o, bearish: b.c < b.o,
    engulfingBull: !!p && b.c > b.o && p.c < p.o && b.c >= p.o && b.o <= p.c,
    engulfingBear: !!p && b.c < b.o && p.c > p.o && b.c <= p.o && b.o >= p.c,
    rejectionBull: range > 0 && lowerWick / range >= 0.45 && closeLocation >= 0.6,
    rejectionBear: range > 0 && upperWick / range >= 0.45 && closeLocation <= 0.4,
    indecision: range > 0 && body / range < 0.25,
    expansion: !!atrVal && range >= 1.5 * atrVal && body / Math.max(range, 1e-9) >= 0.6,
    consecutiveBull: cb, consecutiveBear: cs,
  };
}
