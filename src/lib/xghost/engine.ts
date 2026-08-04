/**
 * xGhost — deterministic per-pair scalping engine (Layer 1).
 *
 * Scans ONE approved forex pair and produces a fully-computed candidate: regime,
 * the single best-fitting setup FAMILY, entry/stop/targets, RR, overextension,
 * an 0–100 weighted+capped score, hard vetoes, and an execution state. Every
 * number is computed here in code from validated closed candles + a sane live
 * price. The AI layer only ranks/explains the finished objects — it can never
 * invent a level or override a veto.
 *
 * Non-negotiables baked in:
 *  - Higher timeframes are CONTEXT, not a hard gate (weighted, not required-equal).
 *  - A trade needs a qualified FAMILY that matches the regime, a real location
 *    edge, room to target after estimated costs, and clean execution conditions.
 *  - NO_TRADE is the default and the correct result most of the time.
 *  - Correlated indicators describing one condition cannot stack (category caps).
 *  - News is never "checked" — a manual-verification warning rides every signal.
 */
import type { Row } from "../marketData";

export const XGHOST_VERSION = "xghost-1.0.0";

// ── Approved universe — EXACTLY these five, nothing else ────────────────────
export type XSym = "EUR/USD" | "GBP/USD" | "AUD/USD" | "USD/CAD" | "USD/JPY";
export type SessionKey = "asian" | "london" | "overlap" | "ny" | "rollover";
export type PairCfg = {
  td: XSym; label: string; pip: number; digits: number;
  spreadPips: Record<SessionKey, number>; maxSpreadPips: number;
  minStopPips: number; atrStopBuffer: number; maxStopAtr: number;
  minRR1: number; minRRmain: number; maxChasePips: number;
  expiryMin: number; cooldownMin: number;
  preferredSessions: SessionKey[]; restrictedSessions: SessionKey[];
  minAtrPct: number; maxAtrPct: number;
  // USD leg: +1 means a LONG of this pair is LONG-USD; -1 means LONG is SHORT-USD.
  usdLongSign: 1 | -1;
};

// Conservative, session-aware ESTIMATED spreads (pips) until a live bid/ask feed
// is wired. Deliberately cautious.
export const XPAIRS: Record<XSym, PairCfg> = {
  "EUR/USD": { td: "EUR/USD", label: "EURUSD", pip: 0.0001, digits: 5,
    spreadPips: { asian: 1.1, london: 0.6, overlap: 0.5, ny: 0.7, rollover: 2.2 }, maxSpreadPips: 1.8,
    minStopPips: 7, atrStopBuffer: 0.55, maxStopAtr: 2.2, minRR1: 1.0, minRRmain: 1.5, maxChasePips: 4,
    expiryMin: 45, cooldownMin: 45, preferredSessions: ["london", "overlap", "ny"], restrictedSessions: ["rollover"],
    minAtrPct: 0.02, maxAtrPct: 0.45, usdLongSign: -1 },
  "GBP/USD": { td: "GBP/USD", label: "GBPUSD", pip: 0.0001, digits: 5,
    spreadPips: { asian: 1.6, london: 0.9, overlap: 0.8, ny: 1.0, rollover: 3.0 }, maxSpreadPips: 2.2,
    minStopPips: 8, atrStopBuffer: 0.55, maxStopAtr: 2.2, minRR1: 1.0, minRRmain: 1.5, maxChasePips: 5,
    expiryMin: 45, cooldownMin: 45, preferredSessions: ["london", "overlap", "ny"], restrictedSessions: ["asian", "rollover"],
    minAtrPct: 0.025, maxAtrPct: 0.5, usdLongSign: -1 },
  "AUD/USD": { td: "AUD/USD", label: "AUDUSD", pip: 0.0001, digits: 5,
    spreadPips: { asian: 1.2, london: 1.0, overlap: 0.9, ny: 1.1, rollover: 2.6 }, maxSpreadPips: 2.0,
    minStopPips: 7, atrStopBuffer: 0.55, maxStopAtr: 2.2, minRR1: 1.0, minRRmain: 1.5, maxChasePips: 4,
    expiryMin: 45, cooldownMin: 45, preferredSessions: ["asian", "london", "overlap"], restrictedSessions: ["rollover"],
    minAtrPct: 0.025, maxAtrPct: 0.5, usdLongSign: -1 },
  "USD/CAD": { td: "USD/CAD", label: "USDCAD", pip: 0.0001, digits: 5,
    spreadPips: { asian: 1.8, london: 1.3, overlap: 1.1, ny: 1.2, rollover: 3.2 }, maxSpreadPips: 2.4,
    minStopPips: 8, atrStopBuffer: 0.6, maxStopAtr: 2.2, minRR1: 1.0, minRRmain: 1.5, maxChasePips: 5,
    expiryMin: 45, cooldownMin: 45, preferredSessions: ["london", "overlap", "ny"], restrictedSessions: ["rollover"],
    minAtrPct: 0.025, maxAtrPct: 0.5, usdLongSign: 1 },
  "USD/JPY": { td: "USD/JPY", label: "USDJPY", pip: 0.01, digits: 3,
    spreadPips: { asian: 0.9, london: 0.8, overlap: 0.7, ny: 0.9, rollover: 2.2 }, maxSpreadPips: 2.0,
    minStopPips: 7, atrStopBuffer: 0.55, maxStopAtr: 2.2, minRR1: 1.0, minRRmain: 1.5, maxChasePips: 4,
    expiryMin: 45, cooldownMin: 45, preferredSessions: ["london", "overlap", "ny"], restrictedSessions: ["rollover"],
    minAtrPct: 0.02, maxAtrPct: 0.5, usdLongSign: 1 },
};
export const XSYMS: XSym[] = ["EUR/USD", "GBP/USD", "AUD/USD", "USD/CAD", "USD/JPY"];

// ── Contract types ──────────────────────────────────────────────────────────
export type XDir = "BUY" | "SELL";
export type Family =
  | "Trend pullback continuation" | "Break & retest continuation"
  | "Liquidity sweep reversal" | "Support/resistance reversal"
  | "Momentum continuation" | "Range liquidity" | "None";
export type Regime =
  | "Strong uptrend" | "Moderate uptrend" | "Strong downtrend" | "Moderate downtrend"
  | "Range" | "Compression" | "Breakout" | "Pullback" | "Transition" | "Unclear";
export type ExecState = "ENTER_NOW" | "LIMIT_ENTRY" | "WAIT_FOR_CONFIRMATION" | "WATCHLIST" | "NO_TRADE";
export type Grade = "A+" | "A" | "B" | "NONE";
export type DxyConfirm = "confirms" | "partial" | "neutral" | "conflicts";

export type ScoreRow = { category: string; points: number; max: number; note: string };
export type Tp = { label: string; price: number; rr: number; basis: string };

export type DxyRead = {
  state: "Strong bullish" | "Moderate bullish" | "Neutral" | "Moderate bearish" | "Strong bearish" | "Conflicting / transitioning";
  score: number;            // -100 (strong USD down) .. +100 (strong USD up)
  byTf: { tf: string; dir: string }[];
  source: "native" | "proxy";
};

export type XCandidate = {
  symbol: XSym; label: string;
  tradeable: boolean;
  execState: ExecState;
  direction: XDir | null;
  family: Family;
  regime: Regime;
  session: string;
  grade: Grade;
  score: number;
  price: number;
  entryType: "MARKET" | "LIMIT" | "CONFIRMATION" | "NONE";
  entryLow: number | null; entryHigh: number | null;
  stop: number | null;
  tps: Tp[];
  rr1: number | null; rrMain: number | null;
  invalidation: string;
  notLateReason: string;
  triggerRequired: string;       // exact confirmation needed (WAIT/LIMIT), else ""
  expiresAtUtc: string | null;
  estDurationMin: number;
  dxyConfirm: DxyConfirm;
  dxyNote: string;
  thesis: string;                // deterministic seed; AI rewrites for the card
  supporting: string[];
  conflicting: string[];
  vetoes: string[];
  scoreBreakdown: ScoreRow[];
  usdLeg: "long-usd" | "short-usd" | null;
  fingerprint: string;
  // watchlist/no-trade guidance
  developingStage: string;       // e.g. "Pullback forming into 20EMA"
  keyLevel: number | null;
  recheckMin: number;
  spreadPips: number;
  atrPct: number;
  dataOk: boolean;
};

// ── Indicator helpers (closed candles only, self-contained) ─────────────────
const C = (r: Row[]) => r.map((v) => +v.close);
const H = (r: Row[]) => r.map((v) => +v.high);
const L = (r: Row[]) => r.map((v) => +v.low);
const O = (r: Row[]) => r.map((v) => +v.open);
function sma(v: number[], n: number): number | null { return v.length < n ? null : v.slice(-n).reduce((a, b) => a + b, 0) / n; }
function ema(v: number[], n: number): number | null { if (v.length < n) return null; const k = 2 / (n + 1); let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n; for (let i = n; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; }
function atr(r: Row[], n = 14): number | null { if (r.length < n + 1) return null; const t: number[] = []; for (let i = 1; i < r.length; i++) { const h = +r[i].high, l = +r[i].low, pc = +r[i - 1].close; t.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); } return t.slice(-n).reduce((a, b) => a + b, 0) / n; }
function rsi(v: number[], n = 14): number | null { if (v.length < n + 1) return null; let g = 0, l = 0; for (let i = v.length - n; i < v.length; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; } if (g + l === 0) return 50; return 100 - 100 / (1 + (g / n) / ((l / n) || 1e-9)); }
function pivots(h: number[], l: number[], k = 2) { const sh: { i: number; p: number }[] = [], sl: { i: number; p: number }[] = []; for (let i = k; i < h.length - k; i++) { let ih = true, il = true; for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (h[j] >= h[i]) ih = false; if (l[j] <= l[i]) il = false; } if (ih) sh.push({ i, p: h[i] }); if (il) sl.push({ i, p: l[i] }); } return { sh, sl }; }
function efficiency(c: number[], n = 10): number { if (c.length < n + 1) return 0; const w = c.slice(-(n + 1)); const net = Math.abs(w[w.length - 1] - w[0]); let path = 0; for (let i = 1; i < w.length; i++) path += Math.abs(w[i] - w[i - 1]); return path > 0 ? net / path : 0; }
function displacement(r: Row[], a: number): number { const last = r[r.length - 1]; if (!last || !a) return 0; return Math.abs(+last.close - +last.open) / a; }
function bodyPct(row: Row): number { const h = +row.high, l = +row.low, rng = Math.max(h - l, 1e-9); return Math.abs(+row.close - +row.open) / rng; }
function fvgs(r: Row[]) { const bull: [number, number][] = [], bear: [number, number][] = []; for (let i = 2; i < r.length; i++) { const aH = +r[i - 2].high, aL = +r[i - 2].low, cH = +r[i].high, cL = +r[i].low; if (cL > aH) bull.push([aH, cL]); if (cH < aL) bear.push([cH, aL]); } return { bull, bear }; }

export function londonHour(d: Date): number { try { return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(d)); } catch { return d.getUTCHours(); } }
export function sessionOf(d: Date): SessionKey { const lh = londonHour(d); if (lh >= 8 && lh < 13) return "london"; if (lh >= 13 && lh < 16) return "overlap"; if (lh >= 16 && lh < 21) return "ny"; if (lh >= 0 && lh < 8) return "asian"; return "rollover"; }
const SESSION_LABEL: Record<SessionKey, string> = { asian: "Asian (Tokyo)", london: "London", overlap: "London / New York overlap", ny: "New York", rollover: "Rollover / illiquid" };

const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
function pips(a: number, b: number, cfg: PairCfg) { return Math.abs(a - b) / cfg.pip; }
function rnd(n: number, cfg: PairCfg) { return +n.toFixed(cfg.digits); }

// ── Regime classification (multi-factor; no single indicator decides) ───────
function classifyRegime(h1: Row[], m15: Row[]): { regime: Regime; dir: XDir | null; strength: number } {
  const c1 = C(h1), c15 = C(m15);
  const p = c1[c1.length - 1];
  const e20 = ema(c1, 20), e50 = ema(c1, 50);
  const eff = efficiency(c15, 12);
  const a = atr(h1, 14) || 0; const atrPct = p ? (a / p) * 100 : 0;
  const { sh, sl } = pivots(H(h1), L(h1), 2);
  const hh = sh.length >= 2 && sh[sh.length - 1].p > sh[sh.length - 2].p;
  const hl = sl.length >= 2 && sl[sl.length - 1].p > sl[sl.length - 2].p;
  const lh = sh.length >= 2 && sh[sh.length - 1].p < sh[sh.length - 2].p;
  const ll = sl.length >= 2 && sl[sl.length - 1].p < sl[sl.length - 2].p;
  const up = e20 != null && e50 != null && p > e20 && e20 > e50;
  const dn = e20 != null && e50 != null && p < e20 && e20 < e50;
  const rangeHi = Math.max(...H(h1).slice(-30)), rangeLo = Math.min(...L(h1).slice(-30));
  const span = rangeHi - rangeLo, atrRange = a > 0 ? span / a : 0;

  if (atrPct > 0 && atrPct < 0.012) return { regime: "Compression", dir: null, strength: 20 };
  if (up && hh && hl) return { regime: eff > 0.5 ? "Strong uptrend" : "Moderate uptrend", dir: "BUY", strength: Math.round(60 + eff * 40) };
  if (dn && lh && ll) return { regime: eff > 0.5 ? "Strong downtrend" : "Moderate downtrend", dir: "SELL", strength: Math.round(60 + eff * 40) };
  if (atrRange > 0 && atrRange < 6 && eff < 0.35) return { regime: "Range", dir: null, strength: 40 };
  // trend structure but price stretched from EMA → pullback context
  if ((up || dn) && eff < 0.45) return { regime: "Pullback", dir: up ? "BUY" : "SELL", strength: 45 };
  if (up || dn) return { regime: up ? "Moderate uptrend" : "Moderate downtrend", dir: up ? "BUY" : "SELL", strength: 50 };
  return { regime: "Unclear", dir: null, strength: 15 };
}

// ── Family selection + setup construction ───────────────────────────────────
type Setup = {
  family: Family; dir: XDir; entry: number; stop: number; tps: number[];
  entryType: "MARKET" | "LIMIT" | "CONFIRMATION"; trigger: string; invalidation: string;
  keyLevel: number; supporting: string[]; notLate: string; late: boolean;
};

// Structural target ladder toward the nearest opposing liquidity, RR-capped.
function targets(dir: XDir, entry: number, stop: number, opposing: number[], cfg: PairCfg): number[] {
  const risk = Math.abs(entry - stop) || cfg.minStopPips * cfg.pip;
  const isL = dir === "BUY";
  const clean = opposing.filter((x) => (isL ? x > entry + risk : x < entry - risk)).sort((a, b) => isL ? a - b : b - a);
  const t1 = rnd(isL ? entry + risk * 1.0 : entry - risk * 1.0, cfg);
  const t2 = clean[0] != null ? rnd(clean[0], cfg) : rnd(isL ? entry + risk * 1.8 : entry - risk * 1.8, cfg);
  const t3 = clean[1] != null ? rnd(clean[1], cfg) : rnd(isL ? entry + risk * 3.0 : entry - risk * 3.0, cfg);
  const out = [t1, t2, t3].filter((x, i, arr) => arr.indexOf(x) === i);
  return out;
}

function buildSetup(regime: Regime, dir: XDir | null, h1: Row[], m15: Row[], m5: Row[], price: number, cfg: PairCfg): Setup | null {
  const c5 = C(m5), c15 = C(m15);
  const a5 = atr(m5, 14) || (price * 0.0006); const a15 = atr(m15, 14) || a5;
  const e20 = ema(c5, 20), e50 = ema(c5, 50);
  const { sh, sl } = pivots(H(m5), L(m5), 2);
  const { sh: sh15, sl: sl15 } = pivots(H(m15), L(m15), 2);
  const last = m5[m5.length - 1], prev = m5[m5.length - 2];
  const rsi5 = rsi(c5, 14) ?? 50;
  const disp = displacement(m5, a5);
  const opposing = dir === "BUY" ? [...sh15.map((s) => s.p), Math.max(...H(h1).slice(-20))] : [...sl15.map((s) => s.p), Math.min(...L(h1).slice(-20))];
  const support: number[] = [...sl15.map((s) => s.p), Math.min(...L(h1).slice(-20))];
  const resistance: number[] = [...sh15.map((s) => s.p), Math.max(...H(h1).slice(-20))];
  const near = (lv: number, tol: number) => Math.abs(price - lv) <= tol;
  const tol = a5 * 0.8;
  const stopBuf = a5 * cfg.atrStopBuffer + cfg.spreadPips.london * cfg.pip;

  // helper to finish a setup with structural stop + targets
  const finish = (family: Family, d: XDir, entry: number, structuralStop: number, keyLevel: number, entryType: Setup["entryType"], trigger: string, inval: string, supporting: string[], notLate: string, late: boolean): Setup => {
    const isL = d === "BUY";
    const stop = rnd(isL ? structuralStop - stopBuf : structuralStop + stopBuf, cfg);
    const tps = targets(d, entry, stop, isL ? resistance : support, cfg);
    return { family, dir: d, entry: rnd(entry, cfg), stop, tps, entryType, trigger, invalidation: inval, keyLevel: rnd(keyLevel, cfg), supporting, notLate, late };
  };

  const trending = /uptrend|downtrend|Pullback|Momentum/i.test(regime);
  const isUp = dir === "BUY";

  // 1) Momentum continuation — strong displacement + shallow pullback, not chased
  if ((/(up|down)trend|Breakout|Momentum/i.test(regime)) && dir && disp > 1.1 && bodyPct(last) > 0.5) {
    const stretched = e20 != null && Math.abs(price - e20) > a5 * 2.4;
    if (!stretched) {
      const kl = isUp ? (e20 ?? price) : (e20 ?? price);
      return finish("Momentum continuation", dir, price, isUp ? Math.min(+last.low, kl) : Math.max(+last.high, kl), kl,
        "MARKET", "", `a 5m close back through ${rnd(kl, cfg)} against you`, [`Displacement ${disp.toFixed(1)}× ATR in trend`, `RSI ${Math.round(rsi5)} supporting, not exhausted`], "Entering on the impulse with price still near the 20EMA, not extended beyond 2.4× ATR.", false);
    }
  }

  // 2) Trend pullback continuation — price pulled back into the 20EMA value band
  // (a controlled entry into the trend), NOT an extended chase.
  if (trending && dir && e20 != null) {
    const band = a5 * 1.3;
    const inZone = isUp ? (price <= e20 + a5 * 0.5 && price >= e20 - band) : (price >= e20 - a5 * 0.5 && price <= e20 + band);
    const rejected = isUp ? (+last.close > +last.open && bodyPct(last) > 0.4) : (+last.close < +last.open && bodyPct(last) > 0.4);
    if (inZone) {
      const swing = isUp ? Math.min(...L(m5).slice(-6)) : Math.max(...H(m5).slice(-6));
      if (rejected) return finish("Trend pullback continuation", dir, price, swing, e20, "MARKET", "", `a 5m close beyond the pullback swing at ${rnd(swing, cfg)}`, [`Pullback into the 20EMA value band`, `Rejection candle in the trend direction`], "Joining an established trend on a controlled pullback, not chasing an extended move.", false);
      return finish("Trend pullback continuation", dir, e20, swing, e20, "LIMIT", `price tags ${rnd(e20, cfg)} and prints a ${isUp ? "bullish" : "bearish"} rejection`, `a 5m close beyond ${rnd(swing, cfg)}`, [`Pullback developing into the EMA value band`], "A limit into value inside the trend — not a chase of the current candle.", false);
    }
  }

  // 3) Break & retest continuation — broke a 15m level, retesting it
  {
    const brokenUp = sh15.find((s) => price > s.p && Math.abs(price - s.p) <= tol && s.i < H(m15).length - 3);
    const brokenDn = sl15.find((s) => price < s.p && Math.abs(price - s.p) <= tol && s.i < L(m15).length - 3);
    if (brokenUp && (dir === "BUY" || !dir)) return finish("Break & retest continuation", "BUY", price, brokenUp.p, brokenUp.p, "CONFIRMATION", `a 5m rejection off the retested level ${rnd(brokenUp.p, cfg)}`, `a 5m close back below ${rnd(brokenUp.p, cfg)}`, [`Broke 15m resistance ${rnd(brokenUp.p, cfg)}, now retesting from above`], "Waiting for the retest — not buying the extended breakout candle.", false);
    if (brokenDn && (dir === "SELL" || !dir)) return finish("Break & retest continuation", "SELL", price, brokenDn.p, brokenDn.p, "CONFIRMATION", `a 5m rejection off the retested level ${rnd(brokenDn.p, cfg)}`, `a 5m close back above ${rnd(brokenDn.p, cfg)}`, [`Broke 15m support ${rnd(brokenDn.p, cfg)}, now retesting from below`], "Waiting for the retest — not selling the extended breakdown candle.", false);
  }

  // 4) Liquidity sweep reversal — swept a recent extreme then reclaimed with a shift
  {
    const lastSL = sl[sl.length - 1], lastSH = sh[sh.length - 1];
    const last6 = m5.slice(-6);
    const sweptLow = lastSL && last6.some((r) => +r.low < lastSL.p) && +last.close > lastSL.p && +last.close > +last.open;
    const sweptHigh = lastSH && last6.some((r) => +r.high > lastSH.p) && +last.close < lastSH.p && +last.close < +last.open;
    if (sweptLow && bodyPct(last) > 0.45) return finish("Liquidity sweep reversal", "BUY", price, Math.min(...last6.map((r) => +r.low)), lastSL!.p, "CONFIRMATION", `a 5m change-of-character (close above the last lower-high) after the sweep`, `a 5m close back below the swept low ${rnd(Math.min(...last6.map((r) => +r.low)), cfg)}`, [`Swept sell-side liquidity below ${rnd(lastSL!.p, cfg)} and reclaimed`], "Entering after the sweep + reclaim, not into the sweep.", false);
    if (sweptHigh && bodyPct(last) > 0.45) return finish("Liquidity sweep reversal", "SELL", price, Math.max(...last6.map((r) => +r.high)), lastSH!.p, "CONFIRMATION", `a 5m change-of-character (close below the last higher-low) after the sweep`, `a 5m close back above the swept high ${rnd(Math.max(...last6.map((r) => +r.high)), cfg)}`, [`Swept buy-side liquidity above ${rnd(lastSH!.p, cfg)} and rejected`], "Entering after the sweep + rejection, not into the sweep.", false);
  }

  // 5) Support/resistance reversal — reaction at a major 1H/15m level
  {
    const majRes = Math.max(...H(h1).slice(-25)); const majSup = Math.min(...L(h1).slice(-25));
    if (near(majSup, tol * 1.2) && +last.close > +last.open && bodyPct(last) > 0.5) return finish("Support/resistance reversal", "BUY", price, majSup, majSup, "CONFIRMATION", `a 5m rejection/engulf holding ${rnd(majSup, cfg)}`, `a 5m close below ${rnd(majSup, cfg)}`, [`Reaction at major 1H support ${rnd(majSup, cfg)}`], "Fading a major level with a confirmed rejection, with room to the range.", false);
    if (near(majRes, tol * 1.2) && +last.close < +last.open && bodyPct(last) > 0.5) return finish("Support/resistance reversal", "SELL", price, majRes, majRes, "CONFIRMATION", `a 5m rejection/engulf holding ${rnd(majRes, cfg)}`, `a 5m close above ${rnd(majRes, cfg)}`, [`Reaction at major 1H resistance ${rnd(majRes, cfg)}`], "Fading a major level with a confirmed rejection, with room to the range.", false);
  }

  // 6) Range liquidity — sweep/reject a boundary, target midpoint
  if (/Range/i.test(regime)) {
    const hi = Math.max(...H(m15).slice(-40)), lo = Math.min(...L(m15).slice(-40)), mid = (hi + lo) / 2;
    if (near(lo, tol * 1.2) && +last.close > +last.open) return finish("Range liquidity", "BUY", price, lo, lo, "CONFIRMATION", `a 5m rejection off the range low ${rnd(lo, cfg)}`, `a 5m close below ${rnd(lo, cfg)}`, [`Rejection from range low, target midpoint ${rnd(mid, cfg)}`], "Buying the defended range low back toward the middle.", false);
    if (near(hi, tol * 1.2) && +last.close < +last.open) return finish("Range liquidity", "SELL", price, hi, hi, "CONFIRMATION", `a 5m rejection off the range high ${rnd(hi, cfg)}`, `a 5m close above ${rnd(hi, cfg)}`, [`Rejection from range high, target midpoint ${rnd(mid, cfg)}`], "Selling the defended range high back toward the middle.", false);
  }

  return null;
}

// ── Scoring (weighted + capped so one condition can't stack) ────────────────
function scoreSetup(s: Setup, ctx: {
  regime: Regime; strength: number; dxy: DxyRead; dxyConfirm: DxyConfirm; session: SessionKey;
  cfg: PairCfg; spreadPips: number; rr1: number; rrMain: number; roomAtr: number; h1: Row[]; m5: Row[]; price: number;
}): { score: number; rows: ScoreRow[] } {
  const rows: ScoreRow[] = [];
  const push = (category: string, points: number, max: number, note: string) => rows.push({ category, points: Math.max(0, Math.min(max, Math.round(points))), max, note });
  // Market structure (20)
  const structPts = /Strong/i.test(ctx.regime) ? 20 : /Moderate|Range|Breakout|Pullback/i.test(ctx.regime) ? 14 : 8;
  push("Market structure", structPts, 20, ctx.regime);
  // Entry location (15) — reversal/retest/pullback at a level scores high; market-momentum mid
  const locPts = s.entryType === "CONFIRMATION" ? 14 : s.entryType === "LIMIT" ? 13 : 10;
  push("Entry location", locPts, 15, s.entryType === "MARKET" ? "at market on impulse" : "at a defined level");
  // DXY confirmation (15)
  const dxyPts = ctx.dxyConfirm === "confirms" ? 15 : ctx.dxyConfirm === "partial" ? 9 : ctx.dxyConfirm === "neutral" ? 6 : 0;
  push("DXY confirmation", dxyPts, 15, ctx.dxy.state + " — " + ctx.dxyConfirm);
  // Momentum / rejection (15) — capped: one bucket regardless of how many indicators agree
  const rsi5 = rsi(C(ctx.m5), 14) ?? 50; const disp = displacement(ctx.m5, atr(ctx.m5, 14) || 1);
  const momPts = Math.min(15, (disp > 0.9 ? 8 : disp > 0.5 ? 5 : 2) + (s.family.includes("sweep") || s.family.includes("reversal") ? 6 : 4) + ((rsi5 > 45 && rsi5 < 72) || (rsi5 < 55 && rsi5 > 28) ? 2 : 0));
  push("Momentum / rejection", momPts, 15, `disp ${disp.toFixed(1)}×ATR, RSI ${Math.round(rsi5)}`);
  // Risk-to-reward & room (15)
  const rrPts = ctx.rrMain >= 2.5 ? 15 : ctx.rrMain >= 2 ? 12 : ctx.rrMain >= 1.5 ? 9 : ctx.rrMain >= 1.2 ? 5 : 1;
  push("Risk-to-reward & space", rrPts, 15, `RR1 ${ctx.rr1.toFixed(1)} / main ${ctx.rrMain.toFixed(1)}, room ${ctx.roomAtr.toFixed(1)}×ATR`);
  // Liquidity / institutional concept (10)
  const liqPts = /sweep|Break & retest|Range/i.test(s.family) ? 10 : /pullback|Support/i.test(s.family) ? 7 : 5;
  push("Liquidity / concept", liqPts, 10, s.family);
  // Spread & execution (5)
  const sprPts = ctx.spreadPips <= ctx.cfg.maxSpreadPips * 0.5 ? 5 : ctx.spreadPips <= ctx.cfg.maxSpreadPips * 0.8 ? 3 : 1;
  push("Spread & execution", sprPts, 5, `${ctx.spreadPips.toFixed(1)} pip est. spread`);
  // Session quality (5)
  const sesPts = ctx.cfg.preferredSessions.includes(ctx.session) ? 5 : ctx.cfg.restrictedSessions.includes(ctx.session) ? 1 : 3;
  push("Session quality", sesPts, 5, SESSION_LABEL[ctx.session]);
  const score = rows.reduce((a, r) => a + r.points, 0);
  return { score, rows };
}

// ── DXY → per-pair confirmation mapping ─────────────────────────────────────
export function dxyConfirmFor(dir: XDir, cfg: PairCfg, dxy: DxyRead): { confirm: DxyConfirm; note: string } {
  // usdLongSign: does a LONG of the pair equal LONG-USD?
  const tradeIsUsdLong = (dir === "BUY") === (cfg.usdLongSign === 1);
  const usdBull = dxy.score;       // + = USD strengthening
  const want = tradeIsUsdLong ? 1 : -1;
  const aligned = Math.sign(usdBull || 0) === want;
  const mag = Math.abs(usdBull);
  if (dxy.state === "Conflicting / transitioning" || mag < 20) return { confirm: "neutral", note: `DXY ${dxy.state.toLowerCase()} — no clear dollar edge` };
  if (aligned && mag >= 55) return { confirm: "confirms", note: `DXY ${dxy.state.toLowerCase()} supports the ${tradeIsUsdLong ? "USD-long" : "USD-short"} side` };
  if (aligned) return { confirm: "partial", note: `DXY leans ${dxy.state.toLowerCase()}, partially supporting` };
  return { confirm: "conflicts", note: `DXY ${dxy.state.toLowerCase()} works AGAINST this ${tradeIsUsdLong ? "USD-long" : "USD-short"} trade` };
}

// ── Main per-pair analysis ──────────────────────────────────────────────────
export type PairInput = { h1: Row[] | null; m15: Row[] | null; m5: Row[] | null; m1?: Row[] | null; price: number | null; nowMs: number; session: SessionKey; dxy: DxyRead };

export function analyzePair(cfg: PairCfg, inp: PairInput): XCandidate {
  const base = (): XCandidate => ({
    symbol: cfg.td, label: cfg.label, tradeable: false, execState: "NO_TRADE", direction: null, family: "None",
    regime: "Unclear", session: SESSION_LABEL[inp.session], grade: "NONE", score: 0, price: inp.price ?? 0,
    entryType: "NONE", entryLow: null, entryHigh: null, stop: null, tps: [], rr1: null, rrMain: null,
    invalidation: "", notLateReason: "", triggerRequired: "", expiresAtUtc: null, estDurationMin: 30,
    dxyConfirm: "neutral", dxyNote: "", thesis: "", supporting: [], conflicting: [], vetoes: [], scoreBreakdown: [],
    usdLeg: null, fingerprint: "", developingStage: "", keyLevel: null, recheckMin: 15, spreadPips: 0, atrPct: 0, dataOk: false,
  });

  const h1 = inp.h1, m15 = inp.m15, m5 = inp.m5, price = inp.price;
  const out = base();
  // Data validation → veto
  if (!h1 || !m15 || !m5 || h1.length < 30 || m15.length < 30 || m5.length < 30 || !numOk(price)) {
    out.vetoes.push("Required market data is stale, missing, or insufficient."); out.developingStage = "Awaiting valid market data"; return out;
  }
  out.dataOk = true;
  const a1 = atr(h1, 14) || 0; const atrPct = price! ? (a1 / price!) * 100 : 0; out.atrPct = +atrPct.toFixed(3);
  const spread = cfg.spreadPips[inp.session]; out.spreadPips = spread;

  const rg = classifyRegime(h1, m15); out.regime = rg.regime;

  // Volatility vetoes
  if (atrPct < cfg.minAtrPct) { out.vetoes.push("Volatility too low to reach target after spread."); out.developingStage = `${rg.regime} — waiting for volatility to expand`; }
  if (atrPct > cfg.maxAtrPct) { out.vetoes.push("Volatility chaotic — stop distance would be unreasonable."); }
  if (inp.session === "rollover") { out.vetoes.push("Rollover / illiquid session — stand aside."); }
  if (spread > cfg.maxSpreadPips) { out.vetoes.push(`Spread ${spread} pips above the ${cfg.maxSpreadPips} ceiling.`); }

  const setup = buildSetup(rg.regime, rg.dir, h1, m15, m5, price!, cfg);
  out.dxyConfirm = "neutral";
  if (!setup) {
    // No clean setup — produce watchlist guidance
    const e20 = ema(C(m5), 20); out.developingStage = out.developingStage || `${rg.regime} — no qualified setup yet`;
    out.keyLevel = e20 != null ? rnd(e20, cfg) : null;
    out.direction = rg.dir; out.usdLeg = rg.dir ? ((rg.dir === "BUY") === (cfg.usdLongSign === 1) ? "long-usd" : "short-usd") : null;
    const d = dxyConfirmFor(rg.dir ?? "BUY", cfg, inp.dxy); out.dxyNote = d.note;
    out.thesis = `No qualified ${cfg.label} setup right now. Regime: ${rg.regime}.`;
    return out;
  }

  // Setup found — compute RR, room, overextension, DXY, score
  const dir = setup.dir; out.direction = dir; out.family = setup.family;
  const risk = Math.abs(setup.entry - setup.stop) || cfg.minStopPips * cfg.pip;
  const slipCost = (spread + 1) * cfg.pip;
  const rr = (tp: number) => (Math.abs(tp - setup.entry) - slipCost) / (risk + slipCost);
  const tps: Tp[] = setup.tps.map((p, i) => ({ label: `TP${i + 1}`, price: p, rr: +rr(p).toFixed(2), basis: i === 0 ? "1R / structure" : "opposing liquidity" }));
  const rr1 = tps[0] ? tps[0].rr : 0; const rrMain = tps[1] ? tps[1].rr : rr1;
  const isL = dir === "BUY";
  const nextOpp = isL ? Math.min(...H(m15).slice(-20).filter((x) => x > setup.entry + risk), Infinity) : Math.max(...L(m15).slice(-20).filter((x) => x < setup.entry - risk), -Infinity);
  const roomAtr = numOk(nextOpp) && Number.isFinite(nextOpp) ? Math.abs(nextOpp - setup.entry) / (a1 || risk) : 3;

  const dxc = dxyConfirmFor(dir, cfg, inp.dxy); out.dxyConfirm = dxc.confirm; out.dxyNote = dxc.note;
  const { score, rows } = scoreSetup(setup, { regime: rg.regime, strength: rg.strength, dxy: inp.dxy, dxyConfirm: dxc.confirm, session: inp.session, cfg, spreadPips: spread, rr1, rrMain, roomAtr, h1, m5, price: price! });
  out.score = score; out.scoreBreakdown = rows;

  // Overextension check (distance of entry from 5m 20EMA)
  const e20_5 = ema(C(m5), 20);
  const extended = e20_5 != null && Math.abs(setup.entry - e20_5) > (atr(m5, 14) || risk) * 2.6 && setup.entryType === "MARKET";

  // ── Hard vetoes (override score) ──────────────────────────────────────────
  const risePips = pips(setup.entry, setup.stop, cfg);
  if (rrMain < cfg.minRRmain) out.vetoes.push(`Reward-to-risk ${rrMain.toFixed(1)} below the ${cfg.minRRmain} floor after costs.`);
  if (risePips < cfg.minStopPips) out.vetoes.push("Stop tighter than the pair floor — no structural basis.");
  if (risePips > (a1 / cfg.pip) * cfg.maxStopAtr) out.vetoes.push("Structural stop too wide for a scalp.");
  if (extended) out.vetoes.push("Price already extended from value — would be chasing.");
  if (roomAtr < 1.2) out.vetoes.push("Next opposing level too close — not enough room to target.");
  if (dxc.confirm === "conflicts" && score < 82) out.vetoes.push("DXY strongly conflicts with a non-exceptional setup.");

  out.rr1 = +rr1.toFixed(2); out.rrMain = +rrMain.toFixed(2);
  out.entryLow = setup.entryType === "MARKET" ? setup.entry : rnd(Math.min(setup.entry, setup.keyLevel), cfg);
  out.entryHigh = setup.entryType === "MARKET" ? setup.entry : rnd(Math.max(setup.entry, setup.keyLevel), cfg);
  out.stop = setup.stop; out.tps = tps; out.invalidation = setup.invalidation; out.keyLevel = setup.keyLevel;
  out.notLateReason = setup.notLate; out.supporting = setup.supporting.slice();
  out.usdLeg = (dir === "BUY") === (cfg.usdLongSign === 1) ? "long-usd" : "short-usd";
  out.conflicting = dxc.confirm === "conflicts" ? [dxc.note] : [];
  out.estDurationMin = 30;
  out.expiresAtUtc = new Date(inp.nowMs + cfg.expiryMin * 60000).toISOString();
  out.recheckMin = 5;
  out.developingStage = `${setup.family} (${dir})`;

  // Grade + execution state (only if no veto)
  if (out.vetoes.length === 0) {
    out.grade = score >= 85 ? "A+" : score >= 78 ? "A" : score >= 70 ? "B" : "NONE";
    if (score >= 78) {
      out.tradeable = setup.entryType === "MARKET";
      out.entryType = setup.entryType;
      out.execState = setup.entryType === "MARKET" ? "ENTER_NOW" : setup.entryType === "LIMIT" ? "LIMIT_ENTRY" : "WAIT_FOR_CONFIRMATION";
      out.triggerRequired = setup.entryType === "MARKET" ? "" : setup.trigger;
    } else if (score >= 70) {
      out.execState = "WATCHLIST"; out.entryType = "NONE"; out.triggerRequired = setup.trigger;
    } else {
      out.execState = "NO_TRADE";
    }
  } else {
    out.execState = "NO_TRADE"; out.grade = "NONE"; out.tradeable = false;
  }

  out.thesis = `${setup.family} on ${cfg.label} (${dir}). ${setup.notLate}`;
  const day = new Date(inp.nowMs).toISOString().slice(0, 10);
  out.fingerprint = [cfg.label, dir, setup.family, rnd(setup.entry, cfg), day, inp.session].join("|");
  return out;
}
