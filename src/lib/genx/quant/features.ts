/**
 * QUANT FEATURES (owner 09-18: "use analytics and numbers to know which way gold is moving — base it on
 * mathematics and which way the market should be moving, and try to be profitable").
 *
 * Everything here is a NUMBER measured off the candles — no opinions, no labels like "bullish". Each feature
 * is normalized by volatility (ATR) or expressed as a ratio, so a value means the same thing at $2,000 gold
 * and $4,400 gold, in a quiet Asian session and a violent NFP minute. These are the inputs the model is
 * fitted on; the model's job is to say how often price went WHICH way after each combination.
 */
export type Bar = { t?: string | number; o: number; h: number; l: number; c: number };

export const FEATURE_NAMES = [
  "trend_fast",      // 20-bar linear-regression slope / ATR
  "trend_slow",      // 60-bar slope / ATR
  "momentum",        // (close - close[10]) / ATR
  "accel",           // momentum now minus momentum 10 bars ago
  "range_pos",       // where price sits in the last 96 bars' range: -1 at the low, +1 at the high
  "vol_ratio",       // fast ATR / slow ATR: is the market speeding up or calming down
  "body_bias",       // average signed body / range over the last 10 bars (who is closing the candles)
  "wick_bias",       // (upper wicks - lower wicks) / range over 10 bars: where price is being rejected
  "dist_high",       // (96-bar high - close) / ATR: room to the ceiling
  "dist_low",        // (close - 96-bar low) / ATR: room to the floor
  "streak",          // signed run of consecutive up/down closes, capped
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Record<FeatureName, number>;

export function atr(bars: Bar[], n: number): number | null {
  if (bars.length < n + 1) return null;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const p = bars[i - 1];
    s += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - p.c), Math.abs(bars[i].l - p.c));
  }
  return s / n;
}

/** Least-squares slope of the closes, in price units per bar. */
export function slope(bars: Bar[], n: number): number | null {
  if (bars.length < n) return null;
  const w = bars.slice(-n);
  const meanX = (n - 1) / 2;
  const meanY = w.reduce((a, b) => a + b.c, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const dx = i - meanX; num += dx * (w[i].c - meanY); den += dx * dx; }
  return den === 0 ? 0 : num / den;
}

const clamp = (v: number, lo = -5, hi = 5) => Math.max(lo, Math.min(hi, v));

/** Build the feature vector at the END of `bars`. Returns null when there isn't enough history. */
export function features(bars: Bar[]): Features | null {
  if (bars.length < 100) return null;
  const a = atr(bars, 14);
  const aSlow = atr(bars, 60);
  if (!a || a <= 0 || !aSlow || aSlow <= 0) return null;
  const c = bars[bars.length - 1].c;
  const win = bars.slice(-96);
  const high = Math.max(...win.map((b) => b.h));
  const low = Math.min(...win.map((b) => b.l));
  const width = Math.max(high - low, 1e-9);

  const sf = slope(bars, 20) ?? 0;
  const ss = slope(bars, 60) ?? 0;
  const mom = (c - bars[bars.length - 11].c) / a;
  const momPrev = (bars[bars.length - 11].c - bars[bars.length - 21].c) / a;

  const last10 = bars.slice(-10);
  const bodyBias = last10.reduce((s, b) => s + (b.c - b.o) / Math.max(b.h - b.l, 1e-9), 0) / 10;
  const wickBias = last10.reduce((s, b) => {
    const rng = Math.max(b.h - b.l, 1e-9);
    return s + ((b.h - Math.max(b.o, b.c)) - (Math.min(b.o, b.c) - b.l)) / rng;
  }, 0) / 10;

  let streak = 0;
  for (let i = bars.length - 1; i > 0 && Math.abs(streak) < 8; i--) {
    const up = bars[i].c > bars[i - 1].c;
    if (streak === 0) streak = up ? 1 : -1;
    else if ((streak > 0) === up) streak += up ? 1 : -1;
    else break;
  }

  return {
    trend_fast: clamp((sf * 20) / a),
    trend_slow: clamp((ss * 60) / a),
    momentum: clamp(mom),
    accel: clamp(mom - momPrev),
    range_pos: clamp((2 * (c - low)) / width - 1, -1.2, 1.2),
    vol_ratio: clamp(a / aSlow, 0, 4),
    body_bias: clamp(bodyBias, -1, 1),
    wick_bias: clamp(wickBias, -1, 1),
    dist_high: clamp((high - c) / a, 0, 10),
    dist_low: clamp((c - low) / a, 0, 10),
    streak: clamp(streak / 4),
  };
}

export const toVector = (f: Features): number[] => FEATURE_NAMES.map((k) => f[k]);
