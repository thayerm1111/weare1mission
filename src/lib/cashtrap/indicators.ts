/**
 * CASHTRAP INDICATORS — pure functions over candle arrays, written to TradingView's calculation
 * conventions so the numbers can be compared one-for-one with the owner's chart.
 *
 * Conventions reproduced (Pine Script v5 built-ins):
 *   • ta.sma(src, n)       — na until n values exist; na whenever any value in the window is na.
 *   • ta.stdev(src, n)     — the default "biased" (population) estimator: √(Σ(x − mean)² / n), with
 *                            deviations within 1e-10 of zero treated as zero, as Pine's reference does.
 *   • ta.rma(src, n)       — Wilder's average, α = 1/n, SEEDED with ta.sma(src, n) on the first bar
 *                            where n values exist, then α·x + (1 − α)·previous.
 *   • RSI (built-in)       — change = close − close[1] (na on the first bar); up = rma(max(change, 0)),
 *                            down = rma(−min(change, 0)); RSI = down == 0 ? 100 : up == 0 ? 0 :
 *                            100 − 100 / (1 + up / down).
 *   • RSI-based MA         — ta.sma(RSI, 4): a SEPARATE line. It never replaces RSI in a condition.
 *   • ta.stoch             — 100 · (close − lowest(low, n)) / (highest(high, n) − lowest(low, n)).
 *                            A zero range divides by zero, which Pine returns as na; so do we (null).
 *   • Stochastic (built-in) — %K = sma(stoch, smoothK), %D = sma(%K, smoothD). With 1 and 1 both are
 *                            the raw stoch, so %K and %D are the same line — no crossover is possible
 *                            or required.
 *   • ta.tr(true)          — high − low on the first bar, then max(high − low, |high − close[1]|,
 *                            |low − close[1]|);  ta.atr(n) = ta.rma(ta.tr(true), n).
 *   • Bollinger Bands      — basis = sma(close, 20); upper/lower = basis ± 2 · stdev(close, 20); offset 0.
 *
 * Standard OHLC candles only (never Heikin-Ashi). `null` plays the part of Pine's `na`.
 */
export type Series = Array<number | null>;

export function sma(src: Series, len: number): Series {
  const out: Series = new Array(src.length).fill(null);
  if (len < 1) return out;
  for (let i = len - 1; i < src.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - len + 1; j <= i; j++) {
      const v = src[j];
      if (v == null || !Number.isFinite(v)) { ok = false; break; }
      sum += v;
    }
    out[i] = ok ? sum / len : null;
  }
  return out;
}

/** Population standard deviation over the trailing window (ta.stdev, biased = true). */
export function stdevPop(src: Series, len: number): Series {
  const mean = sma(src, len);
  const out: Series = new Array(src.length).fill(null);
  for (let i = len - 1; i < src.length; i++) {
    const m = mean[i];
    if (m == null) continue;
    let ss = 0;
    for (let j = i - len + 1; j <= i; j++) {
      let d = (src[j] as number) - m;
      if (Math.abs(d) <= 1e-10) d = 0;
      ss += d * d;
    }
    out[i] = Math.sqrt(ss / len);
  }
  return out;
}

export type Bands = { basis: Series; upper: Series; lower: Series };
export function bollinger(close: Series, len: number, mult: number): Bands {
  const basis = sma(close, len);
  const dev = stdevPop(close, len);
  return {
    basis,
    upper: basis.map((b, i) => (b == null || dev[i] == null ? null : b + mult * (dev[i] as number))),
    lower: basis.map((b, i) => (b == null || dev[i] == null ? null : b - mult * (dev[i] as number))),
  };
}

/** Wilder's moving average (ta.rma), seeded by the simple average of the first `len` values. */
export function rma(src: Series, len: number): Series {
  const out: Series = new Array(src.length).fill(null);
  const seed = sma(src, len);
  const alpha = 1 / len;
  let prev: number | null = null;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (prev == null) {
      prev = seed[i];
      out[i] = prev;
      continue;
    }
    if (x == null || !Number.isFinite(x)) { out[i] = null; prev = null; continue; }
    prev = alpha * x + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** TradingView's built-in RSI on closes. */
export function rsi(close: Series, len: number): Series {
  const up: Series = close.map((c, i) => (i === 0 || c == null || close[i - 1] == null ? null : Math.max((c as number) - (close[i - 1] as number), 0)));
  const down: Series = close.map((c, i) => (i === 0 || c == null || close[i - 1] == null ? null : -Math.min((c as number) - (close[i - 1] as number), 0)));
  const u = rma(up, len);
  const d = rma(down, len);
  return u.map((uv, i) => {
    const dv = d[i];
    if (uv == null || dv == null) return null;
    if (dv === 0) return 100;
    if (uv === 0) return 0;
    return 100 - 100 / (1 + uv / dv);
  });
}

function windowExtreme(src: Series, len: number, i: number, kind: "max" | "min"): number | null {
  if (i - len + 1 < 0) return null;
  let best: number | null = null;
  for (let j = i - len + 1; j <= i; j++) {
    const v = src[j];
    if (v == null || !Number.isFinite(v)) return null;
    best = best == null ? v : kind === "max" ? Math.max(best, v) : Math.min(best, v);
  }
  return best;
}

/** ta.stoch(close, high, low, len). */
export function stoch(close: Series, high: Series, low: Series, len: number): Series {
  return close.map((c, i) => {
    const hh = windowExtreme(high, len, i, "max");
    const ll = windowExtreme(low, len, i, "min");
    if (c == null || hh == null || ll == null) return null;
    const range = hh - ll;
    if (range === 0) return null;
    return (100 * (c - ll)) / range;
  });
}

/** The built-in Stochastic's %K and %D. */
export function stochastic(close: Series, high: Series, low: Series, kLen: number, kSmooth: number, dSmooth: number): { k: Series; d: Series } {
  const k = sma(stoch(close, high, low, kLen), kSmooth);
  return { k, d: sma(k, dSmooth) };
}

/** ta.tr(true). */
export function trueRange(high: Series, low: Series, close: Series): Series {
  return high.map((h, i) => {
    const l = low[i];
    if (h == null || l == null) return null;
    const pc = i > 0 ? close[i - 1] : null;
    if (pc == null) return h - l;
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
}

/** ta.atr(len) = ta.rma(ta.tr(true), len). */
export function atr(high: Series, low: Series, close: Series, len: number): Series {
  return rma(trueRange(high, low, close), len);
}
