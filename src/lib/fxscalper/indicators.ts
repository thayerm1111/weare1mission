/**
 * FX SCALPER INDICATORS — pure, over arrays of completed candles, oldest first. A value that cannot be
 * computed yet (too few candles) or at all (a zero Stochastic range) is null, and a null anywhere in a
 * rule means the rule is not met: the strategy never fills a gap with a guess.
 *
 *   EMA       seeded with the simple average of the first `period` values, then
 *             ema = prev + (2 / (period + 1)) × (value − prev)          (TradingView's ta.ema)
 *   Stochastic raw %K = 100 × (close − lowest low) / (highest high − lowest low) over the last `kLen`
 *             candles, the current one included; slow %K = SMA(smooth) of raw %K; %D = SMA(dLen) of
 *             slow %K. Highest = lowest (a flat window) → null.
 *   ATR       Wilder: true range = max(high − low, |high − previous close|, |low − previous close|);
 *             the first ATR is the simple average of the first `period` true ranges, then
 *             atr = (prev × (period − 1) + tr) / period.
 */

export function ema(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const a = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = prev + a * (values[i] - prev);
    out[i] = prev;
  }
  return out;
}

export function sma(values: Array<number | null>, period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period < 1) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v == null) { ok = false; break; }
      sum += v;
    }
    out[i] = ok ? sum / period : null;
  }
  return out;
}

export type Stoch = { raw: Array<number | null>; k: Array<number | null>; d: Array<number | null> };

export function stochastic(high: number[], low: number[], close: number[], kLen: number, smooth: number, dLen: number): Stoch {
  const n = close.length;
  const raw: Array<number | null> = new Array(n).fill(null);
  for (let i = kLen - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kLen + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    const range = hh - ll;
    raw[i] = range > 0 ? (100 * (close[i] - ll)) / range : null;
  }
  const k = sma(raw, smooth);
  const d = sma(k, dLen);
  return { raw, k, d };
}

export function atrWilder(high: number[], low: number[], close: number[], period: number): Array<number | null> {
  const n = close.length;
  const out: Array<number | null> = new Array(n).fill(null);
  if (n === 0 || period < 1) return out;
  const tr: number[] = new Array(n);
  tr[0] = high[0] - low[0];
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}
