/**
 * MATTY PIPS — market structure from raw price action. Deterministic, no
 * moving averages, no AI. Pivots → swings → one of exactly three states.
 */
import type { Candle, MarketState, TfStructure, Timeframe } from "./types";

export type Pivot = { index: number; price: number; t: number; kind: "high" | "low" };

/** ATR(14) — simple average of true ranges over the last `period` closed bars. */
export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const k = candles[i], p = candles[i - 1];
    trs.push(Math.max(k.h - k.l, Math.abs(k.h - p.c), Math.abs(k.l - p.c)));
  }
  const use = trs.slice(-period);
  return use.length ? use.reduce((a, b) => a + b, 0) / use.length : 0;
}

/**
 * Confirmed fractal pivots: a swing high at bar i has a strictly greater high
 * than the k bars on EACH side, and only counts once k bars have closed after
 * it (no repainting — a pivot can never appear and then vanish).
 */
export function findPivots(candles: Candle[], k = 2): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < candles.length - k; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = 1; j <= k; j++) {
      if (candles[i - j].h >= c.h || candles[i + j].h >= c.h) isHigh = false;
      if (candles[i - j].l <= c.l || candles[i + j].l <= c.l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, price: c.h, t: c.t, kind: "high" });
    if (isLow) out.push({ index: i, price: c.l, t: c.t, kind: "low" });
  }
  return out;
}

function fmtN(n: number): string {
  return n >= 100 ? n.toFixed(1) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Market state for ONE timeframe. Exactly three states:
 *  UPTREND  — last two swing highs ascending AND last two swing lows ascending.
 *  DOWNTREND — mirror (LL + LH).
 *  LEFT_TO_RIGHT — anything else, PLUS a volatility override: if the recent
 *  range is under 1.2×ATR(14), compressed chop is never called a trend.
 */
export function stateFromCandles(candles: Candle[]): { state: MarketState; reason: string; highs: Pivot[]; lows: Pivot[] } {
  const pivots = findPivots(candles, 2);
  const highs = pivots.filter((p) => p.kind === "high");
  const lows = pivots.filter((p) => p.kind === "low");
  const a = atr(candles);
  const look = candles.slice(-20);
  const rHigh = Math.max(...look.map((c) => c.h));
  const rLow = Math.min(...look.map((c) => c.l));

  if (a > 0 && rHigh - rLow < 1.2 * a) {
    return { state: "LEFT_TO_RIGHT", reason: `Range compressed: ${fmtN(rHigh - rLow)} span < 1.2×ATR (${fmtN(a)}) — chop, not trend.`, highs, lows };
  }
  if (highs.length >= 2 && lows.length >= 2) {
    const [h1, h2] = highs.slice(-2);
    const [l1, l2] = lows.slice(-2);
    if (h2.price > h1.price && l2.price > l1.price) {
      return { state: "UPTREND", reason: `HH ${fmtN(h1.price)}→${fmtN(h2.price)} and HL ${fmtN(l1.price)}→${fmtN(l2.price)}.`, highs, lows };
    }
    if (h2.price < h1.price && l2.price < l1.price) {
      return { state: "DOWNTREND", reason: `LH ${fmtN(h1.price)}→${fmtN(h2.price)} and LL ${fmtN(l1.price)}→${fmtN(l2.price)}.`, highs, lows };
    }
  }
  return { state: "LEFT_TO_RIGHT", reason: "Swings not in sequence — no higher-high/higher-low or lower-low/lower-high structure.", highs, lows };
}

/** trendStrength 0–100: swing agreement + normalized progression + close bias. */
export function trendStrength(candles: Candle[], state: MarketState): number {
  if (state === "LEFT_TO_RIGHT") return Math.min(35, Math.round(closeBias(candles) * 35));
  const pivots = findPivots(candles, 2);
  const dir = state === "UPTREND" ? 1 : -1;
  const last4 = pivots.slice(-4);
  let agree = 0;
  for (let i = 1; i < last4.length; i++) {
    const prevSame = [...pivots].reverse().find((p) => p.kind === last4[i].kind && p.index < last4[i].index);
    if (prevSame && Math.sign(last4[i].price - prevSame.price) === dir) agree++;
  }
  const agreeScore = last4.length > 1 ? (agree / (last4.length - 1)) : 0;

  const a = atr(candles) || 1e-9;
  const span = candles.length >= 12 ? (candles[candles.length - 1].c - candles[candles.length - 12].c) * dir : 0;
  const progScore = Math.max(0, Math.min(1, span / (4 * a)));

  return Math.round(40 * agreeScore + 30 * progScore + 30 * closeBias(candles, dir));
}

/** Fraction of the last 20 closes on the trend side of the range midpoint. */
function closeBias(candles: Candle[], dir: 1 | -1 = 1): number {
  const look = candles.slice(-20);
  if (!look.length) return 0;
  const hi = Math.max(...look.map((c) => c.h)), lo = Math.min(...look.map((c) => c.l));
  const mid = (hi + lo) / 2;
  const n = look.filter((c) => (dir === 1 ? c.c > mid : c.c < mid)).length;
  return n / look.length;
}

/**
 * Recent high / low with MEANING: raw extreme of the window, snapped to the
 * nearest confirmed swing within 0.5×ATR so a lone wick print doesn't define
 * the range. `windowBars` ≈ 3 trading days on the Daily.
 */
export function meaningfulRange(candles: Candle[], windowBars: number): { recentHigh: number; recentLow: number } {
  const look = candles.slice(-windowBars);
  if (!look.length) return { recentHigh: 0, recentLow: 0 };
  const rawHigh = Math.max(...look.map((c) => c.h));
  const rawLow = Math.min(...look.map((c) => c.l));
  const a = atr(candles);
  const pivots = findPivots(candles, 2);
  const snap = (raw: number, kind: "high" | "low") => {
    const near = pivots
      .filter((p) => p.kind === kind && Math.abs(p.price - raw) <= 0.5 * a)
      .sort((x, y) => Math.abs(x.price - raw) - Math.abs(y.price - raw))[0];
    return near ? near.price : raw;
  };
  return { recentHigh: snap(rawHigh, "high"), recentLow: snap(rawLow, "low") };
}

/** Full structure read for one timeframe (Daily uses a 3-day meaningful range). */
export function readStructure(timeframe: Timeframe, candles: Candle[]): TfStructure {
  const cur = stateFromCandles(candles);
  const prev = candles.length > 10 ? stateFromCandles(candles.slice(0, -5)) : cur;
  const windowBars = timeframe === "D" ? 3 : timeframe === "H4" ? 18 : 24;
  const { recentHigh, recentLow } = meaningfulRange(candles, windowBars);
  return {
    timeframe,
    marketState: cur.state,
    previousMarketState: prev.state,
    trendStrength: trendStrength(candles, cur.state),
    recentHigh,
    recentLow,
    structureReason: cur.reason,
    atr: atr(candles),
  };
}
