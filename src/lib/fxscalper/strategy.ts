import { atrWilder, ema, stochastic } from "./indicators";
import type { Settings } from "./settings";

/**
 * THE ENTRY RULES (owner 10-23). Deterministic: the same completed candles always give the same answer.
 * No model, no discretion — every entry and exit decision in this bot is arithmetic on broker data.
 *
 * Candles are the broker's own 1-minute bars, completed only, all from the instrument's documented bar
 * source (TradeLocker's `barSource`, BID on Genesis FX). The 5-minute candles are built from those same
 * 1-minute bars, so both timeframes come from one source. An EMA only needs closes, and a 5-minute
 * close IS the close of its last 1-minute bar, so the 5-minute EMAs are exactly the broker's.
 *
 * BUY on the close of a 1-minute candle when ALL of these hold:
 *   1. 5-minute EMA20 > EMA50 (latest completed 5-minute candle)
 *   2. 5-minute EMA20 > its value 3 completed 5-minute candles earlier
 *   3. 1-minute EMA50 > EMA100
 *   4. one of the last 3 completed 1-minute candles' high–low range met the EMA50–EMA100 band
 *   5. slow %K crossed up through 20 (previous ≤ 20, now > 20)
 *   6. slow %K > %D
 *   7. the signal candle closed above its open and above the 1-minute EMA50
 * SELL is the mirror (down through 80 from ≥ 80, %K < %D, close below open and below EMA50).
 * Cost, position and risk checks come after this (plan.ts, risk.ts).
 */

export type Bar = { t: number; o: number; h: number; l: number; c: number };
export const M1_MS = 60_000;
export const M5_MS = 300_000;

export type SideChecks = {
  m5Trend: boolean;
  m5Slope: boolean;
  m1Trend: boolean;
  bandTouch: boolean;
  stochCross: boolean;
  kVsD: boolean;
  candle: boolean;
};

export const CHECK_LABELS: Record<keyof SideChecks, string> = {
  m5Trend: "M5 EMA20 vs EMA50",
  m5Slope: "M5 EMA20 rising/falling over 3 candles",
  m1Trend: "M1 EMA50 vs EMA100",
  bandTouch: "Pullback into the EMA50–EMA100 band",
  stochCross: "Slow %K crossed 20 / 80",
  kVsD: "Slow %K vs %D",
  candle: "Signal candle body and EMA50",
};

export type EvalValues = {
  ema50: number | null;
  ema100: number | null;
  k: number | null;
  kPrev: number | null;
  d: number | null;
  atr: number | null;
  m5Fast: number | null;
  m5Slow: number | null;
  m5FastBack: number | null;
  m5BarT: number | null;
  bandTouchT: number | null;
};

export type Evaluation = {
  status: "warming_up" | "gap" | "no_signal" | "signal";
  side: "buy" | "sell" | null;
  /** Open time of the signal candle, and its close time (= when the signal exists). */
  candleT: number;
  closeT: number;
  open: number;
  close: number;
  buy: SideChecks;
  sell: SideChecks;
  values: EvalValues;
  reason: string;
};

const NONE: SideChecks = { m5Trend: false, m5Slope: false, m1Trend: false, bandTouch: false, stochCross: false, kVsD: false, candle: false };

/** 5-minute candles from 1-minute ones: only windows that have fully closed by `closeT`. */
export function aggregateM5(m1: Bar[], closeT: number): Bar[] {
  const out: Bar[] = [];
  for (const b of m1) {
    const w = Math.floor(b.t / M5_MS) * M5_MS;
    if (w + M5_MS > closeT) break;
    const last = out[out.length - 1];
    if (last && last.t === w) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
    } else out.push({ t: w, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  return out;
}

/** How many completed candles each timeframe needs before a signal can be trusted (EMAs settled). */
export function warmupNeeds(s: Settings["strategy"]): { m1: number; m5: number } {
  return {
    m1: Math.max(3 * s.m1EmaSlow, s.atrPeriod + 2, s.stochK + s.stochSmooth + s.stochD + 2, s.bandLookback + 1),
    m5: 3 * s.m5EmaSlow + s.m5SlopeBars,
  };
}

/**
 * Evaluate the newest candle in `m1` (completed 1-minute bars, oldest first, the signal candle last).
 */
export function evaluate(m1: Bar[], s: Settings["strategy"]): Evaluation {
  const i = m1.length - 1;
  const last = m1[i];
  const base = {
    candleT: last?.t ?? 0, closeT: (last?.t ?? 0) + M1_MS, open: last?.o ?? 0, close: last?.c ?? 0,
    buy: { ...NONE }, sell: { ...NONE },
    values: { ema50: null, ema100: null, k: null, kPrev: null, d: null, atr: null, m5Fast: null, m5Slow: null, m5FastBack: null, m5BarT: null, bandTouchT: null } as EvalValues,
  };
  if (!last) return { ...base, status: "warming_up", side: null, reason: "No candles yet." };
  const need = warmupNeeds(s);
  if (m1.length < need.m1) return { ...base, status: "warming_up", side: null, reason: `Warming up: ${m1.length} of ${need.m1} one-minute candles.` };

  // The candles the Stochastic and the band look at must be consecutive minutes. A missing minute
  // (a feed gap, a reopening market) would make "the previous candle" mean something else.
  const span = Math.max(s.stochK + s.stochSmooth + s.stochD, s.bandLookback + 1);
  if (m1[i].t - m1[i - span + 1].t !== (span - 1) * M1_MS) {
    return { ...base, status: "gap", side: null, reason: `Recent one-minute candles are not consecutive (a gap in the last ${span} minutes).` };
  }

  const closeT = last.t + M1_MS;
  const m5 = aggregateM5(m1, closeT);
  if (m5.length < need.m5) return { ...base, status: "warming_up", side: null, reason: `Warming up: ${m5.length} of ${need.m5} five-minute candles.` };
  const j = m5.length - 1;
  // The latest completed 5-minute candle must be the one that closed most recently, not an old one
  // from before a gap.
  if (closeT - (m5[j].t + M5_MS) >= M5_MS) {
    return { ...base, status: "gap", side: null, reason: "No completed five-minute candle in the last five minutes." };
  }

  const highs = m1.map((b) => b.h), lows = m1.map((b) => b.l), closes = m1.map((b) => b.c);
  const e50 = ema(closes, s.m1EmaFast);
  const e100 = ema(closes, s.m1EmaSlow);
  const st = stochastic(highs, lows, closes, s.stochK, s.stochSmooth, s.stochD);
  const atr = atrWilder(highs, lows, closes, s.atrPeriod);
  const m5c = m5.map((b) => b.c);
  const f5 = ema(m5c, s.m5EmaFast);
  const s5 = ema(m5c, s.m5EmaSlow);

  const v: EvalValues = {
    ema50: e50[i], ema100: e100[i], k: st.k[i], kPrev: st.k[i - 1] ?? null, d: st.d[i], atr: atr[i],
    m5Fast: f5[j], m5Slow: s5[j], m5FastBack: j - s.m5SlopeBars >= 0 ? f5[j - s.m5SlopeBars] : null, m5BarT: m5[j].t, bandTouchT: null,
  };

  let touchT: number | null = null;
  for (let x = i; x > i - s.bandLookback; x--) {
    const a = e50[x], b = e100[x];
    if (a == null || b == null) continue;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (m1[x].l <= hi && m1[x].h >= lo) { touchT = m1[x].t; break; }
  }
  v.bandTouchT = touchT;

  const ok = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);
  const buy: SideChecks = {
    m5Trend: ok(v.m5Fast) && ok(v.m5Slow) && v.m5Fast > v.m5Slow,
    m5Slope: ok(v.m5Fast) && ok(v.m5FastBack) && v.m5Fast > v.m5FastBack,
    m1Trend: ok(v.ema50) && ok(v.ema100) && v.ema50 > v.ema100,
    bandTouch: touchT != null,
    stochCross: ok(v.kPrev) && ok(v.k) && v.kPrev <= s.stochLow && v.k > s.stochLow,
    kVsD: ok(v.k) && ok(v.d) && v.k > v.d,
    candle: ok(v.ema50) && last.c > last.o && last.c > v.ema50,
  };
  const sell: SideChecks = {
    m5Trend: ok(v.m5Fast) && ok(v.m5Slow) && v.m5Fast < v.m5Slow,
    m5Slope: ok(v.m5Fast) && ok(v.m5FastBack) && v.m5Fast < v.m5FastBack,
    m1Trend: ok(v.ema50) && ok(v.ema100) && v.ema50 < v.ema100,
    bandTouch: touchT != null,
    stochCross: ok(v.kPrev) && ok(v.k) && v.kPrev >= s.stochHigh && v.k < s.stochHigh,
    kVsD: ok(v.k) && ok(v.d) && v.k < v.d,
    candle: ok(v.ema50) && last.c < last.o && last.c < v.ema50,
  };
  const all = (c: SideChecks) => Object.values(c).every(Boolean);
  const isBuy = all(buy), isSell = all(sell);
  const out = { ...base, buy, sell, values: v };
  if (isBuy && !isSell) return { ...out, status: "signal", side: "buy", reason: "BUY: every entry rule met on this candle." };
  if (isSell && !isBuy) return { ...out, status: "signal", side: "sell", reason: "SELL: every entry rule met on this candle." };

  // Say what is missing on the side the trend leans to.
  const lean: "buy" | "sell" | null = buy.m1Trend ? "buy" : sell.m1Trend ? "sell" : null;
  if (!lean) return { ...out, status: "no_signal", side: null, reason: "No signal: the one-minute EMAs are level." };
  const checks = lean === "buy" ? buy : sell;
  const missing = (Object.keys(checks) as Array<keyof SideChecks>).filter((k) => !checks[k]).map((k) => CHECK_LABELS[k]);
  return { ...out, status: "no_signal", side: null, reason: `No signal (leaning ${lean.toUpperCase()}): ${missing.join("; ")} not met.` };
}
