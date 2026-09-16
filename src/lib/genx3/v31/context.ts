/** Market context at a decision time: volatility state, regime, bias, session, liquidity levels. */
import { SIZES, type Series, lastClosed, atrMean, efficiencyAt, hiLo, confirmedPivots } from "./series";

export type VolState = "LOW" | "NORMAL" | "HIGH" | "EXTREME";
export type Regime31 = "TREND_UP" | "TREND_DOWN" | "RANGE" | "COMPRESSION" | "TRANSITION" | "DISORDERED";
export type Session = "ASIA" | "LONDON" | "NY" | "LATE";
export type Level = { name: string; px: number };
export type Ctx = {
  asOf: number; i1: number; i5: number; i15: number; i1h: number; i4h: number;
  atr5: number; atr15: number; atr1h: number; volRatio: number; volState: VolState;
  er15: number; regime: Regime31; bias1h: -1 | 0 | 1; bias4h: -1 | 0 | 1; trend15: -1 | 0 | 1; mom20d: -1 | 0 | 1; mom5d: -1 | 0 | 1; mom20dAtr: number;
  session: Session; hourUtc: number; levels: Level[]; range15: { high: number; low: number; width: number; touchesH: number; touchesL: number } | null;
  asia: { high: number; low: number } | null; london: { high: number; low: number } | null; day: { high: number; low: number; open: number } | null;
};

const DAY = 86_400_000, H = 3_600_000;

function dayHL(s: Series, from: number, to: number): { high: number; low: number; open: number } | null {
  // scan m15 bars in [from, to)
  const tf = s.m15; let lo = 0, hi = tf.t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tf.t[m] < from) lo = m + 1; else hi = m; }
  let h = -Infinity, l = Infinity, open = NaN;
  for (let k = lo; k < tf.t.length && tf.t[k] + tf.size <= to; k++) { const b = tf.bars[k]; if (Number.isNaN(open)) open = b.o; if (b.h > h) h = b.h; if (b.l < l) l = b.l; }
  return Number.isFinite(h) ? { high: h, low: l, open } : null;
}

export function buildContext(s: Series, asOf: number): Ctx | null {
  const i1 = lastClosed(s.m1, asOf), i5 = lastClosed(s.m5, asOf), i15 = lastClosed(s.m15, asOf), i1h = lastClosed(s.h1, asOf), i4h = lastClosed(s.h4, asOf);
  if (i5 < 60 || i15 < 120 || i1h < 60 || i4h < 20) return null;
  const atr5 = s.m5.atr[i5], atr15 = s.m15.atr[i15], atr1h = s.h1.atr[i1h];
  const base = atrMean(s.m15, i15 - 1, 1800);           // ~20 trading days of 15m ATR
  const volRatio = atr15 / Math.max(base, 1e-9);
  // 1m spike: a closed 1m bar in the last 10 with range > 3×ATR15 → execution unreliable
  let spike = false; for (let k = Math.max(0, i1 - 9); k <= i1; k++) if (s.m1.bars[k].h - s.m1.bars[k].l > 3 * atr15) spike = true;
  const volState: VolState = spike || volRatio > 2.6 ? "EXTREME" : volRatio > 1.4 ? "HIGH" : volRatio < 0.7 ? "LOW" : "NORMAL";
  const er15 = efficiencyAt(s.m15, i15, 16);
  const c15 = s.m15.bars[i15].c, e20 = s.m15.ema20[i15], e50 = s.m15.ema50[i15];
  const trend15: -1 | 0 | 1 = e20 > e50 && c15 > e50 && e50 > s.m15.ema50[i15 - 4] ? 1 : e20 < e50 && c15 < e50 && e50 < s.m15.ema50[i15 - 4] ? -1 : 0;
  const bias = (tf: Series["h1"], i: number): -1 | 0 | 1 => { const c = tf.bars[i].c, e = tf.ema50[i], sl = e - tf.ema50[i - 5]; return c > e && sl > 0 ? 1 : c < e && sl < 0 ? -1 : 0; };
  const bias1h = bias(s.h1, i1h), bias4h = bias(s.h4, i4h);
  // Multi-day momentum from 4h closes (≈6 bars per trading day): 20-day and 5-day, in ATR(4h) units.
  const c4 = s.h4.bars[i4h].c, a4 = s.h4.atr[i4h];
  const r20 = i4h >= 120 ? (c4 - s.h4.bars[i4h - 120].c) / a4 : 0, r5 = i4h >= 30 ? (c4 - s.h4.bars[i4h - 30].c) / a4 : 0;
  const mom20d: -1 | 0 | 1 = r20 > 2 ? 1 : r20 < -2 ? -1 : 0, mom5d: -1 | 0 | 1 = r5 > 1 ? 1 : r5 < -1 ? -1 : 0;
  const rb = hiLo(s.m15, i15 - 31, i15); const rw = rb.h - rb.l;
  let tH = 0, tL = 0; for (let k = i15 - 31; k <= i15; k++) { if (rb.h - s.m15.bars[k].h <= 0.25 * atr15) tH++; if (s.m15.bars[k].l - rb.l <= 0.25 * atr15) tL++; }
  const range15 = { high: rb.h, low: rb.l, width: rw, touchesH: tH, touchesL: tL };
  const cb = hiLo(s.m15, i15 - 15, i15);
  let regime: Regime31 = "TRANSITION";
  if (volState === "EXTREME") regime = "DISORDERED";
  else if (cb.h - cb.l <= 2.5 * atrMean(s.m15, i15, 40) && volRatio < 0.9) regime = "COMPRESSION";
  else if (er15 >= 0.3 && trend15 !== 0) regime = trend15 > 0 ? "TREND_UP" : "TREND_DOWN";
  else if (er15 <= 0.22 && rw >= 3 * atr15 && rw <= 10 * atr15 && tH >= 2 && tL >= 2) regime = "RANGE";
  const hourUtc = new Date(asOf).getUTCHours();
  const session: Session = hourUtc < 7 ? "ASIA" : hourUtc < 12 ? "LONDON" : hourUtc < 17 ? "NY" : "LATE";
  const dayStart = Math.floor(asOf / DAY) * DAY;
  // previous trading day = last day before today that has bars
  let prev: { high: number; low: number; open: number } | null = null;
  for (let d = 1; d <= 4 && !prev; d++) prev = dayHL(s, dayStart - d * DAY, dayStart - (d - 1) * DAY);
  const day = dayHL(s, dayStart, asOf);
  const asia = asOf >= dayStart + 7 * H ? dayHL(s, dayStart, dayStart + 7 * H) : null;
  const london = asOf >= dayStart + 12 * H ? dayHL(s, dayStart + 7 * H, dayStart + 12 * H) : null;
  const levels: Level[] = [];
  if (prev) levels.push({ name: "PDH", px: prev.high }, { name: "PDL", px: prev.low });
  if (asia) levels.push({ name: "ASIA_H", px: asia.high }, { name: "ASIA_L", px: asia.low });
  if (london) levels.push({ name: "LDN_H", px: london.high }, { name: "LDN_L", px: london.low });
  for (const p of confirmedPivots(s.h1, i1h, 3, 3, 72)) levels.push({ name: p.kind === "high" ? "H1_SWING_H" : "H1_SWING_L", px: p.price });
  return { asOf, i1, i5, i15, i1h, i4h, atr5, atr15, atr1h, volRatio, volState, er15, regime, bias1h, bias4h, trend15, mom20d, mom5d, mom20dAtr: r20, session, hourUtc, levels, range15, asia, london, day };
}
export { SIZES };
