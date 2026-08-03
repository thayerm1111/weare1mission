/**
 * OM SCALP — deterministic scalping engine (Layer 1).
 *
 * The LLM never invents or edits a number. This module takes verified market
 * data (closed candles + a validated live price) and produces a strict,
 * schema-shaped decision: TRADE, WATCHLIST or NO_TRADE, with every level,
 * score, veto and reason computed in code. The AI layer only turns this object
 * into prose — it cannot change direction, levels, score or the decision.
 *
 * Design rules baked in:
 *  - Higher timeframes are CONTEXT, not automatic entries.
 *  - A trade needs a qualified setup FAMILY, an aligned execution stack, a real
 *    location edge, room to a target after estimated costs, and a clean session.
 *  - NO_TRADE is the default and the expected result most of the time.
 *  - Spreads are ESTIMATED per pair/session (labelled) until a live bid/ask feed
 *    is connected. All spread numbers below are conservative typical values.
 */
import type { Row } from "./marketData";
import { closedBars, trendOfCloses } from "./mtf";

export const STRATEGY_VERSION = "scalp-1.0.0";
export const CONFIG_VERSION = "scalp-cfg-1.0.0";

// ── Types (the strict output contract) ─────────────────────────────────────
export type Decision = "TRADE" | "WATCHLIST" | "NO_TRADE";
export type Direction = "BUY" | "SELL" | "NONE";
export type EntryType = "MARKET" | "LIMIT" | "STOP" | "WAIT" | "NONE";
export type ConfidenceLabel = "ELITE" | "QUALIFIED" | "WATCHLIST" | "REJECTED";
export type Regime =
  | "Strong bullish trend" | "Weak bullish trend"
  | "Strong bearish trend" | "Weak bearish trend"
  | "Defined range" | "Compression" | "Breakout expansion"
  | "High-volatility disorder" | "Low-liquidity disorder" | "Unclear / conflicting";
export type SetupFamily =
  | "Trend pullback continuation" | "Liquidity sweep & reclaim"
  | "Breakout & retest" | "Range boundary reversal" | "None";

export type TakeProfit = { label: string; price: number | null; rMultiple: number | null };
export type ScoreBreakdown = { category: string; points: number; max: number; note: string };

export type ScalpSignal = {
  decision: Decision;
  symbol: string;
  direction: Direction;
  timestampUtc: string;
  dataTimestampUtc: string | null;
  setupFamily: SetupFamily;
  regime: Regime;
  score: number;
  confidenceLabel: ConfidenceLabel;
  entryType: EntryType;
  entryZone: { low: number | null; high: number | null };
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfits: TakeProfit[];
  invalidation: string;
  expiresAtUtc: string | null;
  maximumChasePrice: number | null;
  spreadStatus: string;
  sessionStatus: string;
  newsStatus: string;
  mtf: { tf: string; trend: string }[];
  passedConditions: string[];
  failedConditions: string[];
  vetoes: string[];
  scoreBreakdown: ScoreBreakdown[];
  riskWarnings: string[];
  explanation: string;
  fingerprint: string;
  strategyVersion: string;
  configVersion: string;
  dataSource: string;
};

// ── Pair-specific configuration (independent per instrument) ────────────────
export type SessionKey = "asian" | "london" | "overlap" | "ny" | "rollover";
export type PairConfig = {
  td: string;              // Twelve Data symbol
  label: string;
  pip: number;             // price value of 1 pip / tick
  digits: number;          // display precision
  spreadPips: Record<SessionKey, number>; // ESTIMATED typical spread (pips) by session
  maxSpreadPips: number;   // veto above this
  minStopPips: number;     // pair floor (spread + noise)
  atrStopMult: number;     // structural stop = swing + this * ATR buffer
  maxStopAtrMult: number;  // veto if structural stop needs > this * ATR
  minRR1: number;          // TP1 must clear this after costs
  minRRmain: number;       // main target must clear this after costs
  maxChasePips: number;    // market entry only within this of the ideal level
  expiryMin: number;       // signal life
  cooldownMin: number;     // after a stop
  preferredSessions: SessionKey[];
  restrictedSessions: SessionKey[];
  newsSensitivity: "high" | "medium";
  minAtrPct: number;       // below → low-liquidity/compression veto (normalized ATR %)
  maxAtrPct: number;       // above → disorder veto
};

// Conservative, session-aware ESTIMATED spreads (pips). Replace with a live
// bid/ask feed later; these are deliberately cautious.
export const PAIRS: Record<string, PairConfig> = {
  "USD/JPY": {
    td: "USD/JPY", label: "USD/JPY", pip: 0.01, digits: 3,
    spreadPips: { asian: 0.9, london: 0.8, overlap: 0.7, ny: 0.9, rollover: 2.2 },
    maxSpreadPips: 2.0, minStopPips: 7, atrStopMult: 0.55, maxStopAtrMult: 2.2,
    minRR1: 1.0, minRRmain: 1.5, maxChasePips: 4, expiryMin: 75, cooldownMin: 45,
    preferredSessions: ["london", "overlap", "ny"], restrictedSessions: ["rollover"],
    newsSensitivity: "high", minAtrPct: 0.03, maxAtrPct: 0.55,
  },
  "GBP/USD": {
    td: "GBP/USD", label: "GBP/USD", pip: 0.0001, digits: 5,
    spreadPips: { asian: 1.6, london: 0.9, overlap: 0.8, ny: 1.0, rollover: 3.0 },
    maxSpreadPips: 2.2, minStopPips: 8, atrStopMult: 0.55, maxStopAtrMult: 2.2,
    minRR1: 1.0, minRRmain: 1.5, maxChasePips: 5, expiryMin: 75, cooldownMin: 45,
    preferredSessions: ["london", "overlap", "ny"], restrictedSessions: ["asian", "rollover"],
    newsSensitivity: "high", minAtrPct: 0.03, maxAtrPct: 0.5,
  },
  "EUR/USD": {
    td: "EUR/USD", label: "EUR/USD", pip: 0.0001, digits: 5,
    spreadPips: { asian: 1.1, london: 0.6, overlap: 0.5, ny: 0.7, rollover: 2.2 },
    maxSpreadPips: 1.8, minStopPips: 7, atrStopMult: 0.55, maxStopAtrMult: 2.2,
    minRR1: 1.0, minRRmain: 1.5, maxChasePips: 4, expiryMin: 75, cooldownMin: 45,
    preferredSessions: ["london", "overlap", "ny"], restrictedSessions: ["rollover"],
    newsSensitivity: "high", minAtrPct: 0.025, maxAtrPct: 0.45,
  },
  "AUD/CAD": {
    td: "AUD/CAD", label: "AUD/CAD", pip: 0.0001, digits: 5,
    spreadPips: { asian: 1.8, london: 1.6, overlap: 1.5, ny: 1.7, rollover: 3.5 },
    maxSpreadPips: 2.8, minStopPips: 9, atrStopMult: 0.6, maxStopAtrMult: 2.2,
    minRR1: 1.0, minRRmain: 1.5, maxChasePips: 5, expiryMin: 90, cooldownMin: 60,
    preferredSessions: ["asian", "london", "overlap"], restrictedSessions: ["rollover"],
    newsSensitivity: "medium", minAtrPct: 0.03, maxAtrPct: 0.5,
  },
  "GBP/JPY": {
    td: "GBP/JPY", label: "GBP/JPY", pip: 0.01, digits: 3,
    spreadPips: { asian: 2.4, london: 1.6, overlap: 1.5, ny: 1.9, rollover: 4.5 },
    maxSpreadPips: 3.2, minStopPips: 12, atrStopMult: 0.65, maxStopAtrMult: 2.4,
    minRR1: 1.0, minRRmain: 1.6, maxChasePips: 7, expiryMin: 75, cooldownMin: 60,
    preferredSessions: ["london", "overlap", "ny"], restrictedSessions: ["asian", "rollover"],
    newsSensitivity: "high", minAtrPct: 0.04, maxAtrPct: 0.7,
  },
  // Gold gets its own, deliberately stricter profile.
  "XAU/USD": {
    td: "XAU/USD", label: "XAU/USD (Gold)", pip: 0.1, digits: 2,
    spreadPips: { asian: 3.5, london: 2.5, overlap: 2.2, ny: 2.8, rollover: 6.0 },
    maxSpreadPips: 4.5, minStopPips: 25, atrStopMult: 0.7, maxStopAtrMult: 2.5,
    minRR1: 1.0, minRRmain: 1.8, maxChasePips: 20, expiryMin: 60, cooldownMin: 75,
    preferredSessions: ["london", "overlap", "ny"], restrictedSessions: ["asian", "rollover"],
    newsSensitivity: "high", minAtrPct: 0.04, maxAtrPct: 0.9,
  },
};
export const SCALP_SYMBOLS = Object.keys(PAIRS);

// ── Small deterministic indicator helpers (closed candles only) ─────────────
const closes = (r: Row[]) => r.map((v) => +v.close);
const highs = (r: Row[]) => r.map((v) => +v.high);
const lows = (r: Row[]) => r.map((v) => +v.low);

function sma(v: number[], n: number): number | null { return v.length < n ? null : v.slice(-n).reduce((a, b) => a + b, 0) / n; }
function atr(r: Row[], n = 14): number | null {
  if (r.length < n + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < r.length; i++) { const h = +r[i].high, l = +r[i].low, pc = +r[i - 1].close; trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
  return trs.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function rsi(v: number[], n = 14): number | null {
  if (v.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = v.length - n; i < v.length; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
  if (g + l === 0) return 50;
  return 100 - 100 / (1 + (g / n) / ((l / n) || 1e-9));
}
// Swing pivots (fractal high/low with k bars each side).
function pivots(h: number[], l: number[], k = 2): { sh: { i: number; p: number }[]; sl: { i: number; p: number }[] } {
  const sh: { i: number; p: number }[] = [], sl: { i: number; p: number }[] = [];
  for (let i = k; i < h.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (h[j] >= h[i]) isH = false; if (l[j] <= l[i]) isL = false; }
    if (isH) sh.push({ i, p: h[i] }); if (isL) sl.push({ i, p: l[i] });
  }
  return { sh, sl };
}
// Efficiency = net displacement / total path over the window (0..1). High = clean trend.
function efficiency(c: number[], n = 10): number {
  if (c.length < n + 1) return 0;
  const w = c.slice(-(n + 1));
  const net = Math.abs(w[w.length - 1] - w[0]);
  let path = 0; for (let i = 1; i < w.length; i++) path += Math.abs(w[i] - w[i - 1]);
  return path > 0 ? net / path : 0;
}
// Displacement = last closed body vs ATR (momentum candle).
function displacement(r: Row[], a: number): number {
  const last = r[r.length - 1]; if (!last || !a) return 0;
  return Math.abs(+last.close - +last.open) / a;
}

// ── DST-safe session (Europe/London local hour drives the classification) ───
function londonHour(d: Date): number {
  try { return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(d)); }
  catch { return d.getUTCHours(); }
}
export function sessionOf(d: Date): SessionKey {
  const lh = londonHour(d);
  if (lh >= 8 && lh < 13) return "london";
  if (lh >= 13 && lh < 16) return "overlap";
  if (lh >= 16 && lh < 21) return "ny";
  if (lh >= 0 && lh < 8) return "asian";
  return "rollover";
}
const SESSION_LABEL: Record<SessionKey, string> = {
  asian: "Asian (Tokyo)", london: "London", overlap: "London / New York overlap", ny: "New York", rollover: "Rollover / illiquid",
};

// ── Regime classifier (multi-factor; no single indicator decides) ───────────
type Trend = "bullish" | "bearish" | "ranging";
function trendOf(r: Row[]): Trend { return trendOfCloses(closes(r)); }

export type RegimeRead = { regime: Regime; dir: "BUY" | "SELL" | null; strength: number };
export function classifyRegime(h1: Row[], m15: Row[]): RegimeRead {
  const c = closes(h1);
  const s20 = sma(c, 20), s50 = sma(c, 50);
  const a1 = atr(h1, 14) || 0;
  const px = c[c.length - 1];
  const atrPct = px > 0 ? (a1 / px) * 100 : 0;
  const eff = efficiency(c, 12);
  const sep = s20 != null && s50 != null && px > 0 ? Math.abs(s20 - s50) / px * 100 : 0;
  const disp = displacement(h1, a1);
  // Range width vs ATR over 40 bars.
  const hh = Math.max(...highs(h1).slice(-40)), ll = Math.min(...lows(h1).slice(-40));
  const rangeAtr = a1 > 0 ? (hh - ll) / a1 : 0;
  const up = s20 != null && s50 != null && px > s20 && s20 > s50;
  const dn = s20 != null && s50 != null && px < s20 && s20 < s50;
  const m15trend = trendOf(m15);

  // Disorder / liquidity gates first.
  if (atrPct > 0 && atrPct < 0.02 && rangeAtr < 4) return { regime: "Compression", dir: null, strength: 30 };
  if (rangeAtr > 0 && rangeAtr < 3 && eff < 0.35) return { regime: "Low-liquidity disorder", dir: null, strength: 20 };
  if (eff < 0.28 && disp > 1.6) return { regime: "High-volatility disorder", dir: null, strength: 20 };

  // Trend regimes (need MA stack + efficiency + 15m agreement).
  if (up && eff >= 0.45 && sep > 0.04) {
    const strong = eff >= 0.6 && sep > 0.08 && m15trend !== "bearish";
    return { regime: strong ? "Strong bullish trend" : "Weak bullish trend", dir: "BUY", strength: strong ? 85 : 62 };
  }
  if (dn && eff >= 0.45 && sep > 0.04) {
    const strong = eff >= 0.6 && sep > 0.08 && m15trend !== "bullish";
    return { regime: strong ? "Strong bearish trend" : "Weak bearish trend", dir: "SELL", strength: strong ? 85 : 62 };
  }
  // Breakout expansion: fresh displacement out of a tight base.
  if (disp >= 1.4 && eff >= 0.5 && rangeAtr < 6) {
    return { regime: "Breakout expansion", dir: up ? "BUY" : dn ? "SELL" : null, strength: 55 };
  }
  // Defined range: contained, mean-reverting, decent width.
  if (rangeAtr >= 3 && rangeAtr <= 8 && eff < 0.45 && !up && !dn) {
    return { regime: "Defined range", dir: null, strength: 50 };
  }
  return { regime: "Unclear / conflicting", dir: null, strength: 25 };
}

// ── Setup families ──────────────────────────────────────────────────────────
export type Candidate = {
  family: SetupFamily;
  direction: "BUY" | "SELL";
  entryType: EntryType;
  entryLow: number; entryHigh: number; ideal: number;
  stop: number;
  invalidation: string;
  reasons: string[];      // location / structure evidence
  triggerOk: boolean;     // 5m execution trigger present
  locationScore: number;  // 0..20
  triggerScore: number;   // 0..20
  liqScore: number;       // 0..15
};

// Build candidate(s) from the execution frames. Returns the best qualified one.
export function findSetup(
  cfg: PairConfig, regime: RegimeRead, mtfDir: "BUY" | "SELL" | null,
  h1: Row[], m15: Row[], m5: Row[], price: number,
): Candidate | null {
  const a15 = atr(m15, 14) || 0;
  if (a15 <= 0) return null;
  const h = highs(m15), l = lows(m15), c = closes(m15);
  const piv = pivots(h, l, 2);
  const lastSH = piv.sh.length ? piv.sh[piv.sh.length - 1].p : Math.max(...h.slice(-20));
  const lastSL = piv.sl.length ? piv.sl[piv.sl.length - 1].p : Math.min(...l.slice(-20));
  const s20 = sma(c, 20) ?? price;
  const disp5 = displacement(m5, atr(m5, 14) || a15);
  const last5 = m5[m5.length - 1];
  const closed5Up = last5 ? +last5.close > +last5.open : false;
  const closed5Dn = last5 ? +last5.close < +last5.open : false;
  const buffer = (cfg.atrStopMult * a15) + cfg.minStopPips * cfg.pip;

  const trending = regime.regime.includes("bullish") || regime.regime.includes("bearish");
  const isRange = regime.regime === "Defined range";
  const isBreakout = regime.regime === "Breakout expansion";

  // 1) TREND PULLBACK CONTINUATION — with-trend, pulled back to value, 5m trigger.
  if (trending && regime.dir && mtfDir === regime.dir) {
    const long = regime.dir === "BUY";
    const value = s20;
    const pulledBack = long ? price <= value + a15 * 0.4 : price >= value - a15 * 0.4;
    const notExtended = long ? price <= lastSH : price >= lastSL; // not already past the swing
    const trigger = long ? closed5Up && disp5 >= 0.6 : closed5Dn && disp5 >= 0.6;
    if (pulledBack && notExtended) {
      const ideal = long ? Math.min(value, price) : Math.max(value, price);
      // Stop always sits beyond BOTH the swing and the entry, so it can never
      // land on the wrong side of entry when price has pulled deep.
      const stop = long ? Math.min(lastSL, ideal) - buffer : Math.max(lastSH, ideal) + buffer;
      return {
        family: "Trend pullback continuation", direction: regime.dir,
        entryType: trigger ? "MARKET" : "LIMIT",
        entryLow: long ? ideal - a15 * 0.2 : ideal, entryHigh: long ? ideal : ideal + a15 * 0.2, ideal,
        stop, invalidation: `${cfg.label} 15m close beyond the last swing ${long ? "low" : "high"} (${round(long ? lastSL : lastSH, cfg)})`,
        reasons: [`${regime.regime} with the 1H/30m/15m stack aligned ${regime.dir}`, `Controlled pullback into the 15m value area (~SMA20 ${round(value, cfg)})`, trigger ? "5m displacement candle closed with the trend" : "Waiting for a 5m trigger"],
        triggerOk: trigger, locationScore: pulledBack ? 16 : 10, triggerScore: trigger ? 18 : 8, liqScore: 8,
      };
    }
  }

  // 2) LIQUIDITY SWEEP & RECLAIM — swept a swing then reclaimed with displacement.
  {
    const recent = m15.slice(-6);
    const sweptHigh = recent.some((r) => +r.high > lastSH) && price < lastSH; // took highs then back below
    const sweptLow = recent.some((r) => +r.low < lastSL) && price > lastSL;   // took lows then back above
    if (sweptLow && disp5 >= 0.8 && closed5Up) {
      const stop = Math.min(...recent.map((r) => +r.low)) - buffer;
      return {
        family: "Liquidity sweep & reclaim", direction: "BUY", entryType: "MARKET",
        entryLow: price - a15 * 0.2, entryHigh: price, ideal: price, stop,
        invalidation: `${cfg.label} 15m close back below the swept low (${round(Math.min(...recent.map((r) => +r.low)), cfg)})`,
        reasons: ["Sell-side liquidity below the last swing low was swept and reclaimed", "5m displacement closed back above the level"], triggerOk: true,
        locationScore: 17, triggerScore: 17, liqScore: 14,
      };
    }
    if (sweptHigh && disp5 >= 0.8 && closed5Dn) {
      const stop = Math.max(...recent.map((r) => +r.high)) + buffer;
      return {
        family: "Liquidity sweep & reclaim", direction: "SELL", entryType: "MARKET",
        entryLow: price, entryHigh: price + a15 * 0.2, ideal: price, stop,
        invalidation: `${cfg.label} 15m close back above the swept high (${round(Math.max(...recent.map((r) => +r.high)), cfg)})`,
        reasons: ["Buy-side liquidity above the last swing high was swept and rejected", "5m displacement closed back below the level"], triggerOk: true,
        locationScore: 17, triggerScore: 17, liqScore: 14,
      };
    }
  }

  // 3) BREAKOUT & RETEST — closed beyond structure, now retesting from the correct side.
  if ((isBreakout || trending) && mtfDir) {
    const long = mtfDir === "BUY";
    const level = long ? lastSH : lastSL;
    const brokeAndBack = long ? price >= level - a15 * 0.3 && price <= level + a15 * 0.6 : price <= level + a15 * 0.3 && price >= level - a15 * 0.6;
    const trigger = long ? closed5Up && disp5 >= 0.6 : closed5Dn && disp5 >= 0.6;
    const closedBeyond = long ? c[c.length - 1] > level - a15 * 0.1 : c[c.length - 1] < level + a15 * 0.1;
    if (brokeAndBack && closedBeyond && trigger) {
      const stop = long ? level - buffer : level + buffer;
      return {
        family: "Breakout & retest", direction: mtfDir, entryType: "MARKET",
        entryLow: long ? level - a15 * 0.2 : level, entryHigh: long ? level : level + a15 * 0.2, ideal: level, stop,
        invalidation: `${cfg.label} 15m close back inside the range beyond ${round(level, cfg)}`,
        reasons: [`Price broke and is retesting the ${long ? "prior high" : "prior low"} (${round(level, cfg)}) — old level flipping to ${long ? "support" : "resistance"}`, "5m trigger confirmed the hold"], triggerOk: true,
        locationScore: 15, triggerScore: 16, liqScore: 10,
      };
    }
  }

  // 4) RANGE BOUNDARY REVERSAL — only in a confirmed range, at the edge, with rejection.
  if (isRange) {
    const hh = Math.max(...h.slice(-40)), ll = Math.min(...l.slice(-40)), mid = (hh + ll) / 2;
    const nearHigh = price >= hh - a15 * 0.5 && price > mid;
    const nearLow = price <= ll + a15 * 0.5 && price < mid;
    if (nearLow && disp5 >= 0.5 && closed5Up) {
      return {
        family: "Range boundary reversal", direction: "BUY", entryType: "MARKET",
        entryLow: price - a15 * 0.2, entryHigh: price, ideal: price, stop: ll - buffer,
        invalidation: `${cfg.label} 15m close below the range low (${round(ll, cfg)})`,
        reasons: [`Defined range; price at the lower boundary (${round(ll, cfg)}) with a 5m rejection`, `Target back toward range equilibrium (${round(mid, cfg)})`], triggerOk: true,
        locationScore: 15, triggerScore: 14, liqScore: 9,
      };
    }
    if (nearHigh && disp5 >= 0.5 && closed5Dn) {
      return {
        family: "Range boundary reversal", direction: "SELL", entryType: "MARKET",
        entryLow: price, entryHigh: price + a15 * 0.2, ideal: price, stop: hh + buffer,
        invalidation: `${cfg.label} 15m close above the range high (${round(hh, cfg)})`,
        reasons: [`Defined range; price at the upper boundary (${round(hh, cfg)}) with a 5m rejection`, `Target back toward range equilibrium (${round(mid, cfg)})`], triggerOk: true,
        locationScore: 15, triggerScore: 14, liqScore: 9,
      };
    }
  }

  return null;
}

// ── Targets from real structure + R-multiples (never stretched) ─────────────
export function buildTargets(cand: Candidate, cfg: PairConfig, m15: Row[], entry: number): { tps: number[]; obstacle: number | null } {
  const long = cand.direction === "BUY";
  const risk = Math.abs(entry - cand.stop) || cfg.minStopPips * cfg.pip;
  const h = highs(m15), l = lows(m15);
  // Nearest opposing structure ahead = the first meaningful obstacle.
  const ahead = long ? h.slice(-40).filter((x) => x > entry) : l.slice(-40).filter((x) => x < entry);
  const obstacle = ahead.length ? (long ? Math.min(...ahead) : Math.max(...ahead)) : null;
  const rr = (m: number) => (long ? entry + risk * m : entry - risk * m);
  // TP1 ~ 1R (or nearest structure if closer but still ≥ minRR1), TP2 ~ main, TP3 extension.
  const tp1 = rr(Math.max(cfg.minRR1, 1));
  const tp2 = rr(Math.max(cfg.minRRmain, 1.5));
  const tp3 = rr(Math.max(cfg.minRRmain + 1, 2.5));
  return { tps: [tp1, tp2, tp3], obstacle };
}

// ── Scoring (0–100 across independent categories) ───────────────────────────
export function scoreSetup(
  cfg: PairConfig, regime: RegimeRead, cand: Candidate, mtfAligned: boolean,
  spreadPips: number, session: SessionKey, newsClear: boolean, rrMain: number,
): { score: number; breakdown: ScoreBreakdown[] } {
  const b: ScoreBreakdown[] = [];
  // 1. Regime + directional alignment (20)
  const regimePts = Math.round((regime.strength / 100) * 12) + (mtfAligned ? 8 : 0);
  b.push({ category: "Regime & direction", points: Math.min(20, regimePts), max: 20, note: `${regime.regime}${mtfAligned ? " · 1H/30m/15m aligned" : " · stack not fully aligned"}` });
  // 2. Entry location / structure (20)
  b.push({ category: "Location & structure", points: Math.min(20, cand.locationScore + 2), max: 20, note: cand.reasons[0] ?? "" });
  // 3. Execution trigger (20)
  b.push({ category: "Execution trigger (5m)", points: Math.min(20, cand.triggerScore), max: 20, note: cand.triggerOk ? "5m trigger present" : "no clean 5m trigger" });
  // 4. Liquidity & displacement (15)
  b.push({ category: "Liquidity & displacement", points: Math.min(15, cand.liqScore), max: 15, note: cand.family });
  // 5. Volatility & spread (10)
  const spreadOk = spreadPips <= cfg.maxSpreadPips;
  const volPts = spreadOk ? 10 - Math.min(6, Math.round((spreadPips / cfg.maxSpreadPips) * 6)) : 0;
  b.push({ category: "Volatility & spread", points: volPts, max: 10, note: `est. spread ${spreadPips.toFixed(1)} pips` });
  // 6. Session quality (10)
  const sessPts = cfg.preferredSessions.includes(session) ? 10 : cfg.restrictedSessions.includes(session) ? 0 : 5;
  b.push({ category: "Session", points: sessPts, max: 10, note: SESSION_LABEL[session] });
  // 7. News safety (5)
  b.push({ category: "News safety", points: newsClear ? 5 : 0, max: 5, note: newsClear ? "no blocking event window" : "news window / unverified" });
  // Reward gate is a multiplier on the location score's usefulness (soft): penalise thin RR.
  let score = b.reduce((s, x) => s + x.points, 0);
  if (rrMain < cfg.minRRmain) score = Math.min(score, 79); // cannot qualify without reward after costs
  return { score: Math.max(0, Math.min(100, Math.round(score))), breakdown: b };
}

// ── Utilities ───────────────────────────────────────────────────────────────
export function round(n: number, cfg: PairConfig): number { return +n.toFixed(cfg.digits); }
export function pips(a: number, b: number, cfg: PairConfig): number { return Math.abs(a - b) / cfg.pip; }
export function spreadFor(cfg: PairConfig, session: SessionKey): number { return cfg.spreadPips[session]; }

export function fingerprint(symbol: string, dir: Direction, family: SetupFamily, entry: number | null, day: string): string {
  const e = entry != null ? Math.round(entry * 1e4) : 0;
  return `${symbol}|${dir}|${family}|${e}|${day}`.replace(/[^A-Za-z0-9|.\-/]/g, "");
}
