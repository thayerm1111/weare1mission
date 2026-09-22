/**
 * GENX SIDEWAYS-MARKET STRATEGY — RANGE FADE (owner 09-21: "Start the GenX sideways-market strategy …
 * What I care about is the AI reading the market correctly, analyzing it in real time and giving proper
 * direction").
 *
 * Why it exists. The trend gate (trendGate.ts) only lets GENX call when the 1-hour EMA 20/50/200 are
 * stacked. Since 09-11 gold has chopped sideways, the stack has been "mixed" most of the time, and GENX
 * has correctly sat out — but sitting out is all it did. This is the other half of the router: when the
 * hourly trend is NOT stacked and price is going nowhere, sell the top of the range and buy the bottom.
 *
 *   REGIME   1h EMA 20/50/200 not stacked, AND hourly efficiency ≤ 0.35 over the last 12 hours
 *            (|net move| ÷ total path — 0 is pure chop, 1 is a straight line). Trending tape never
 *            reaches this code: the two strategies cannot both be active.
 *   RANGE    high/low of the prior 24 hours of closed 5-minute bars, at least 6 ATR wide.
 *   SIGNAL   the last closed 5m bar tags the outer 10% of the range, closes back inside with a body
 *            against the edge and a rejection wick ≥ 30% of the bar, and did not overshoot the edge by
 *            more than 0.5 ATR (a real breakout is not a fade).
 *   ORDER    market at that close. Stop beyond the extreme + 0.3 ATR ($3–$15, otherwise SKIPPED — never
 *            widened). TP1 = middle of the range (must be ≥ 0.8R). TP2 = 85% of the way to the far edge.
 *   WHEN     Asia and London only. New York hours are skipped: replayed, NY fades lost in both years
 *            (that is the session where ranges break).
 *
 * What the replay said (two years of 5m XAU/USD, 0.35 spread charged per trade, scripts/genx-backtest):
 *   first year  49 trades  +0.35R a trade  hit +1R before the stop 63%
 *   second year 59 trades  +0.36R a trade  hit +1R before the stop 49%    · 7 of 9 quarters positive
 * About one call a week. Without the regime filter the same fades LOST (−0.19R a trade, first year) —
 * the regime read is the whole point. These are replay numbers on one instrument, the settings were
 * chosen by looking at that history, and live fills are worse than a replay's. It will have losing
 * weeks. It is not a proven or guaranteed edge.
 *
 * Pure. Bars in, a setup or a reason out. Kill switch: GENX_RANGE_FADE=off.
 */

export type Bar = { t: string; o: number; h: number; l: number; c: number };

/*
 * 09-21 (owner: "the market still moves 80–100 pips — pick the best strategy for this market"). Replayed on the
 * 2-year 5m archive, one trade at a time, 0.35 spread charged, sideways regime only. Tried for the in-range swings:
 *   fade a 12h box −0.01R (Y1) / +0.19R (Y2) · 8h box −0.07/+0.23 · 6h box −0.22/+0.11 · 4h box −0.28/+0.11
 *   break of a 4h box, stop at the box middle −0.25/+0.09 · stop under the break bar, 2R target −0.13/+0.14
 *   snap back to the 5m EMA50 after a 3-ATR stretch −0.14/−0.11 · 4-ATR stretch −0.02/+0.04
 * None held up in both years, so none trades. The 24h fade is the only sideways strategy with an edge; widening its
 * trigger zone to the outer 15% of the range (was 10%) is the one change that helped: 12.5% and 15% both beat 10%,
 * 17.5%/20% fall away again, so 15% sits on a plateau, not a spike.
 */
export const RNG = {
  lookback: 288,        // 24h of 5-minute bars, excluding the signal bar
  minWidthAtr: 6,
  band: 0.15,           // 09-21 replay (2y, one trade at a time, 0.35 spread): 0.10 → 103 trades +0.23R; 0.15 → 128 trades +0.26R, both years +, 7/9 quarters
  wick: 0.3,
  overAtr: 0.5,
  padAtr: 0.3,
  minRr: 0.8,
  tp2Inset: 0.15,
  maxEff: 0.35,
  effHours: 12,
  minStop: 3,           // dollars
  maxStop: 15,          // dollars — beyond this the call is skipped, never widened
  chaseR: 0.25,         // live price must be within this many R of the signal close
  perDay: 3,
  gapMin: 60,
};

export type RangeFade = {
  side: "buy" | "sell";
  entry: number; stop: number; tp1: number; tp2: number;
  risk: number; rr: number; atr: number;
  high: number; low: number; width: number;
  why: string;
};

export type Regime = { regime: "range" | "trend" | "unknown"; stack: "up" | "down" | "mixed" | null; eff: number | null; why: string };

/** Wilder ATR(14) over the whole series, seeded with raw true range for the first 15 bars (matches the replay). */
export function atrSeries(b: Bar[]): number[] {
  const out = new Array<number>(b.length).fill(0);
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    out[i] = i < 15 ? tr : out[i - 1] + (tr - out[i - 1]) / 14;
  }
  return out;
}

/** |net| ÷ path over the last `n` hourly steps (n+1 closes). 0 = chop, 1 = straight line. */
export function efficiency(closes: number[], n = RNG.effHours): number | null {
  const c = closes.filter((x) => Number.isFinite(x));
  if (c.length < n + 1) return null;
  const seg = c.slice(-(n + 1));
  let path = 0;
  for (let i = 1; i < seg.length; i++) path += Math.abs(seg[i] - seg[i - 1]);
  return path > 0 ? Math.abs(seg[seg.length - 1] - seg[0]) / path : 0;
}

/** The router's read. Fails to "unknown" (= no range call) on missing data. */
export function readRegime(stack: "up" | "down" | "mixed" | null, closedHourly: number[]): Regime {
  if (!stack) return { regime: "unknown", stack: null, eff: null, why: "no hourly trend read" };
  const eff = efficiency(closedHourly);
  if (eff == null) return { regime: "unknown", stack, eff: null, why: "not enough hourly history" };
  if (stack !== "mixed") return { regime: "trend", stack, eff, why: `1h EMAs stacked ${stack}` };
  if (eff > RNG.maxEff) return { regime: "trend", stack, eff, why: `EMAs mixed but price is travelling (efficiency ${eff.toFixed(2)})` };
  return { regime: "range", stack, eff, why: `EMAs mixed and price going nowhere (efficiency ${eff.toFixed(2)})` };
}

/** Pure: does the LAST CLOSED bar complete a range fade? `bars` = closed 5m bars, oldest first. */
export function detectRangeFade(bars: Bar[]): { ok: true; setup: RangeFade } | { ok: false; reason: string } {
  const n = bars.length;
  if (n < RNG.lookback + 20) return { ok: false, reason: "not_enough_bars" };
  const atr = atrSeries(bars)[n - 1];
  if (!(atr > 0)) return { ok: false, reason: "no_atr" };
  const seg = bars.slice(n - 1 - RNG.lookback, n - 1);
  let hi = -Infinity, lo = Infinity;
  for (const b of seg) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
  const w = hi - lo;
  if (w < RNG.minWidthAtr * atr) return { ok: false, reason: `range_too_narrow:${w.toFixed(1)}<${(RNG.minWidthAtr * atr).toFixed(1)}` };
  const { o, h, l, c } = bars[n - 1];
  const rng = Math.max(h - l, 1e-9);
  const mid = (hi + lo) / 2;

  let side: "buy" | "sell" | null = null, stop = 0, tp1 = 0, tp2 = 0;
  const sellShape = h >= hi - RNG.band * w && c < o && c < hi - RNG.band * w * 0.5 && (h - Math.max(o, c)) / rng >= RNG.wick && h <= hi + RNG.overAtr * atr;
  const buyShape = l <= lo + RNG.band * w && c > o && c > lo + RNG.band * w * 0.5 && (Math.min(o, c) - l) / rng >= RNG.wick && l >= lo - RNG.overAtr * atr;
  if (sellShape) {
    const s = Math.max(h, hi) + RNG.padAtr * atr;
    if (c - mid > 0 && (c - mid) / (s - c) >= RNG.minRr) { side = "sell"; stop = s; tp1 = mid; tp2 = lo + RNG.tp2Inset * w; }
  } else if (buyShape) {
    const s = Math.min(l, lo) - RNG.padAtr * atr;
    if (mid - c > 0 && (mid - c) / (c - s) >= RNG.minRr) { side = "buy"; stop = s; tp1 = mid; tp2 = hi - RNG.tp2Inset * w; }
  }
  if (!side) return { ok: false, reason: sellShape || buyShape ? "edge_rejection_but_rr_short" : "no_edge_rejection" };
  const risk = Math.abs(c - stop);
  if (risk < RNG.minStop) return { ok: false, reason: `stop_too_tight:${risk.toFixed(2)}` };
  if (risk > RNG.maxStop) return { ok: false, reason: `stop_too_wide:${risk.toFixed(2)}` };
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    ok: true,
    setup: {
      side, entry: r2(c), stop: r2(stop), tp1: r2(tp1), tp2: r2(tp2), risk: r2(risk), rr: +(Math.abs(tp1 - c) / risk).toFixed(2), atr: r2(atr),
      high: r2(hi), low: r2(lo), width: r2(w),
      why: side === "sell"
        ? `rejected the top of the ${lo.toFixed(2)}–${hi.toFixed(2)} range`
        : `rejected the bottom of the ${lo.toFixed(2)}–${hi.toFixed(2)} range`,
    },
  };
}

const NY_HOUR_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });
/** New York hours are skipped (08:00–17:00 NY): replayed, fades lost there in both years. */
export function inNewYorkHours(d: Date = new Date()): boolean {
  const h = Number(NY_HOUR_FMT.format(d)) % 24;
  return h >= 8 && h < 17;
}

/** Pure: at most `perDay` a trading day, and never within `gapMin` of the previous range call. */
export function rangeFadeLimits(prev: { createdAt: string }[], now: { nowMs: number; dayStartMs: number }): { ok: boolean; reason: string } {
  const times = prev.map((p) => Date.parse(p.createdAt)).filter((t) => Number.isFinite(t));
  if (times.some((t) => now.nowMs - t < RNG.gapMin * 60_000)) return { ok: false, reason: "range_fade_gap" };
  if (times.filter((t) => t >= now.dayStartMs).length >= RNG.perDay) return { ok: false, reason: "range_fade_daily_limit" };
  return { ok: true, reason: "ok" };
}
