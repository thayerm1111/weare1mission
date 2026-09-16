/**
 * GENX 3.2 market-state router. Classifies XAUUSD from CLOSED bars only into one of six states
 * and returns the evidence used, so every routing decision is auditable.
 *
 *   EXPANSION           — a 5m/15m bar just displaced out of recent structure (≥1.8×ATR, strong body)
 *   POST_BREAK_RETRACE  — an expansion/break happened in the last hour and price is pulling back
 *                         toward the broken level without closing back through it
 *   COMPRESSION         — contracting range + falling ATR + falling realized vol + boundary tests
 *   TRENDING            — directional efficiency with EMA alignment on 15m and/or 1H
 *   RANGING             — low efficiency, bounded box with touches on both sides
 *   TRANSITION          — none of the above with enough certainty
 */
import { type Series, atrMean, efficiencyAt, hiLo } from "../v31/series";
import type { Ctx } from "../v31/context";

export type MarketState = "TRENDING" | "RANGING" | "COMPRESSION" | "EXPANSION" | "POST_BREAK_RETRACE" | "TRANSITION";
export type BreakEvent = { dir: 1 | -1; level: number; barT: number; i5: number; kind: "box" | "level"; name: string };
export type StateResult = {
  state: MarketState; dir: -1 | 0 | 1; confidence: number;
  atrPct: number;                      // ATR15 percentile vs ~20 trading days (0..1)
  rvRatio: number;                     // 60m realized vol / 20-day median of the same measure
  er15: number; er1h: number; trend15: -1 | 0 | 1; trend1h: -1 | 0 | 1;
  compression: { high: number; low: number; width: number; touchesH: number; touchesL: number; atrSlope: number } | null;
  lastBreak: BreakEvent | null;
  evidence: string[];
};

const pctCache = new Map<number, number[]>();   // keyed by the 15m bar index — reuse across minutes

function atrPercentile(s: Series, i15: number): number {
  let sample = pctCache.get(i15);
  if (!sample) {
    sample = []; for (let k = Math.max(15, i15 - 1800); k < i15; k += 3) sample.push(s.m15.atr[k]);
    sample.sort((a, b) => a - b);
    if (pctCache.size > 64) pctCache.clear();
    pctCache.set(i15, sample);
  }
  const v = s.m15.atr[i15]; let lo = 0, hi = sample.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sample[m] <= v) lo = m + 1; else hi = m; }
  return sample.length ? lo / sample.length : 0.5;
}

function realizedVol(s: Series, i1: number, n: number): number {
  if (i1 < n + 1) return 0; let sum = 0;
  for (let k = i1 - n + 1; k <= i1; k++) { const r = s.m1.bars[k].c - s.m1.bars[k - 1].c; sum += r * r; }
  return Math.sqrt(sum / n);
}
const rvCache = new Map<number, number>();
function rvBaseline(s: Series, i15: number): number {
  const c = rvCache.get(i15); if (c != null) return c;
  // median of the 60-minute realized vol sampled every 15m over ~20 trading days
  const vals: number[] = []; const i1 = s.m1.t.length;
  for (let k = Math.max(16, i15 - 1800); k < i15; k += 4) {
    const t = s.m15.t[k] + 15 * 60000; let lo = 0, hi = i1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s.m1.t[m] < t) lo = m + 1; else hi = m; }
    if (lo > 61) vals.push(realizedVol(s, lo - 1, 60));
  }
  vals.sort((a, b) => a - b); const med = vals.length ? vals[vals.length >> 1] : 0;
  if (rvCache.size > 64) rvCache.clear(); rvCache.set(i15, med); return med;
}

/** Most recent displacement break of a meaningful level within `lookback` closed 5m bars. */
export function findBreak(s: Series, ctx: Ctx, lookback: number): BreakEvent | null {
  const m5 = s.m5.bars, i = ctx.i5;
  for (let j = i; j > i - lookback && j > 40; j--) {
    const b = m5[j], a5 = s.m5.atr[j - 1] || ctx.atr5, body = Math.abs(b.c - b.o), rng = b.h - b.l;
    if (body < 0.9 * a5 || body < 0.55 * rng) continue;
    const dir: 1 | -1 = b.c > b.o ? 1 : -1;
    const box = hiLo(s.m5, j - 36, j - 1);
    const boxEdge = dir > 0 ? box.h : box.l;
    if (dir * (b.c - boxEdge) >= 0.15 * a5) return { dir, level: boxEdge, barT: b.t, i5: j, kind: "box", name: "3h_box" };
    for (const lv of ctx.levels) {
      const before = dir > 0 ? m5[j - 1].c <= lv.px : m5[j - 1].c >= lv.px;
      if (before && dir * (b.c - lv.px) >= 0.15 * a5) return { dir, level: lv.px, barT: b.t, i5: j, kind: "level", name: lv.name };
    }
  }
  return null;
}

export function classifyState(s: Series, ctx: Ctx): StateResult {
  const i15 = ctx.i15, i5 = ctx.i5, i1 = ctx.i1, ev: string[] = [];
  const atrPct = atrPercentile(s, i15);
  const rvNow = realizedVol(s, i1, 60), rvBase = rvBaseline(s, i15), rvRatio = rvBase > 0 ? rvNow / rvBase : 1;
  const er15 = efficiencyAt(s.m15, i15, 16), er1h = efficiencyAt(s.h1, ctx.i1h, 12);
  const c15 = s.m15.bars[i15].c, e20 = s.m15.ema20[i15], e50 = s.m15.ema50[i15];
  const trend15: -1 | 0 | 1 = e20 > e50 && c15 > e20 ? 1 : e20 < e50 && c15 < e20 ? -1 : 0;
  const c1h = s.h1.bars[ctx.i1h].c, h20 = s.h1.ema20[ctx.i1h], h50 = s.h1.ema50[ctx.i1h];
  const trend1h: -1 | 0 | 1 = h20 > h50 && c1h > h50 ? 1 : h20 < h50 && c1h < h50 ? -1 : 0;

  // compression: last 12 15m bars narrow vs ATR(40), ATR falling, second half narrower than first
  const box = hiLo(s.m15, i15 - 11, i15), width = box.h - box.l;
  const firstHalf = hiLo(s.m15, i15 - 11, i15 - 6), secondHalf = hiLo(s.m15, i15 - 5, i15);
  const atrSlope = s.m15.atr[i15] / Math.max(s.m15.atr[i15 - 12], 1e-9) - 1;
  let tH = 0, tL = 0; for (let k = i15 - 11; k <= i15; k++) { if (box.h - s.m15.bars[k].h <= 0.2 * ctx.atr15) tH++; if (s.m15.bars[k].l - box.l <= 0.2 * ctx.atr15) tL++; }
  const isCompression = width <= 2.2 * atrMean(s.m15, i15, 40) && atrSlope < -0.08 && rvRatio < 0.9 && (secondHalf.h - secondHalf.l) <= (firstHalf.h - firstHalf.l) && tH >= 2 && tL >= 2;
  const compression = { high: box.h, low: box.l, width, touchesH: tH, touchesL: tL, atrSlope };

  const b5 = s.m5.bars[i5], rng5 = b5.h - b5.l, body5 = Math.abs(b5.c - b5.o);
  const lastBreak = findBreak(s, ctx, 12);
  const expansionNow = rng5 >= 1.8 * (s.m5.atr[i5 - 1] || ctx.atr5) && body5 >= 0.6 * rng5 && lastBreak != null && lastBreak.i5 === i5;

  let state: MarketState = "TRANSITION", dir: -1 | 0 | 1 = 0, confidence = 40;
  if (expansionNow) { state = "EXPANSION"; dir = lastBreak!.dir; confidence = 75; ev.push(`5m range ${(rng5 / ctx.atr5).toFixed(1)}×ATR5 broke ${lastBreak!.name} ${lastBreak!.level.toFixed(2)}`); }
  else if (lastBreak && i5 - lastBreak.i5 >= 2) {
    const since = hiLo(s.m5, lastBreak.i5 + 1, i5);
    const pulledBack = lastBreak.dir > 0 ? b5.c < since.h - 0.5 * ctx.atr5 : b5.c > since.l + 0.5 * ctx.atr5;
    const held = lastBreak.dir > 0 ? since.l > lastBreak.level - 0.5 * ctx.atr5 : since.h < lastBreak.level + 0.5 * ctx.atr5;
    if (pulledBack && held) { state = "POST_BREAK_RETRACE"; dir = lastBreak.dir; confidence = 65; ev.push(`retracing after break of ${lastBreak.name} ${lastBreak.level.toFixed(2)}`); }
  }
  if (state === "TRANSITION") {
    if (isCompression) { state = "COMPRESSION"; confidence = 70; ev.push(`12×15m box ${width.toFixed(2)} (${(width / ctx.atr15).toFixed(1)}×ATR15), ATR ${(atrSlope * 100).toFixed(0)}%, RV ratio ${rvRatio.toFixed(2)}`); }
    else if ((er15 >= 0.3 && trend15 !== 0) || (er1h >= 0.3 && trend1h !== 0)) { state = "TRENDING"; dir = (trend1h !== 0 ? trend1h : trend15); confidence = Math.round(50 + 50 * Math.max(er15, er1h)); ev.push(`efficiency 15m ${er15.toFixed(2)} / 1H ${er1h.toFixed(2)}, EMA trend 15m ${trend15} 1H ${trend1h}`); }
    else if (er15 <= 0.22 && ctx.range15 && ctx.range15.touchesH >= 2 && ctx.range15.touchesL >= 2 && ctx.range15.width <= 10 * ctx.atr15) { state = "RANGING"; confidence = 60; ev.push(`8h range ${ctx.range15.low.toFixed(2)}–${ctx.range15.high.toFixed(2)}, efficiency ${er15.toFixed(2)}`); }
    else ev.push(`no clear state: efficiency ${er15.toFixed(2)}, trend 15m ${trend15} 1H ${trend1h}`);
  }
  return { state, dir, confidence, atrPct, rvRatio, er15, er1h, trend15, trend1h, compression: isCompression ? compression : null, lastBreak, evidence: ev };
}
