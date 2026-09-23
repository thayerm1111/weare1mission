import type { Bar, Pivot, RangeCandidate } from "../core/types";
import type { AuricConfig } from "../config/defaults";

/** Wilder ATR over closed bars. Returns NaN when there are not enough bars. */
export function atr(bars: Bar[], period: number): number {
  if (bars.length < period + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  let a = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

/** ATR series (one value per bar index ≥ period) for percentile ranking. */
export function atrSeries(bars: Bar[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  if (bars.length < period + 1) return out;
  const trs: number[] = [NaN];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  let a = trs.slice(1, period + 1).reduce((s, x) => s + x, 0) / period;
  out[period] = a;
  for (let i = period + 1; i < bars.length; i++) { a = (a * (period - 1) + trs[i]) / period; out[i] = a; }
  return out;
}

/** Rank of `value` within `window` (0..1). */
export function percentileRank(value: number, window: number[]): number {
  const xs = window.filter((x) => Number.isFinite(x));
  if (!xs.length) return NaN;
  let below = 0; for (const x of xs) if (x < value) below++;
  return below / xs.length;
}

/**
 * Directional efficiency over the last `n` CLOSED bars:
 *   |net change| / Σ|consecutive changes|.
 * A zero denominator (flat closes) is reported explicitly as undefined, never as 0 or 1.
 */
export function efficiency(closes: number[], n: number): { value: number; defined: boolean } {
  if (closes.length < n + 1) return { value: NaN, defined: false };
  const seg = closes.slice(-(n + 1));
  let denom = 0;
  for (let i = 1; i < seg.length; i++) denom += Math.abs(seg[i] - seg[i - 1]);
  if (denom === 0) return { value: 0, defined: false };
  return { value: Math.abs(seg[seg.length - 1] - seg[0]) / denom, defined: true };
}

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let e = NaN;
  for (let i = 0; i < values.length; i++) {
    e = i === 0 ? values[0] : values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

/** EMA slope over `lookback` bars, normalized by ATR. */
export function emaSlopeAtr(closes: number[], period: number, lookback: number, atrValue: number): number {
  if (closes.length < period + lookback || !(atrValue > 0)) return NaN;
  const e = ema(closes, period);
  return (e[e.length - 1] - e[e.length - 1 - lookback]) / atrValue;
}

/**
 * CONFIRMED pivots. A bar i is a pivot high when its high exceeds the `left` bars before it and the `right`
 * bars after it. It becomes KNOWN only once bar i+right has closed — `confirmedAtIndex` records that, and
 * consumers must never use a pivot before that index. Nothing is backdated.
 */
export function confirmedPivots(bars: Bar[], left: number, right: number): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [], lows: Pivot[] = [];
  for (let i = left; i + right < bars.length; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isH = false;
      if (bars[j].l <= bars[i].l) isL = false;
      if (!isH && !isL) break;
    }
    const conf = i + right;
    if (isH) highs.push({ kind: "high", price: bars[i].h, barIndex: i, t: bars[i].t, confirmedAtIndex: conf, confirmedAt: bars[conf].t });
    if (isL) lows.push({ kind: "low", price: bars[i].l, barIndex: i, t: bars[i].t, confirmedAtIndex: conf, confirmedAt: bars[conf].t });
  }
  return { highs, lows };
}

/** Structure from the last two confirmed highs and lows. */
export function structureOf(highs: Pivot[], lows: Pivot[]): "HH_HL" | "LH_LL" | "MIXED" | "INSUFFICIENT" {
  if (highs.length < 2 || lows.length < 2) return "INSUFFICIENT";
  const [h1, h2] = highs.slice(-2), [l1, l2] = lows.slice(-2);
  const hh = h2.price > h1.price, hl = l2.price > l1.price;
  const lh = h2.price < h1.price, ll = l2.price < l1.price;
  if (hh && hl) return "HH_HL";
  if (lh && ll) return "LH_LL";
  return "MIXED";
}

export function bodyRatio(b: Bar): number { const r = b.h - b.l; return r > 0 ? Math.abs(b.c - b.o) / r : 0; }
export function meanBodyRatio(bars: Bar[], n: number): number {
  const seg = bars.slice(-n); if (!seg.length) return NaN;
  return seg.reduce((s, b) => s + bodyRatio(b), 0) / seg.length;
}
/** Overlap of consecutive bars: overlap range / union range, averaged. High = churning candles. */
export function meanOverlap(bars: Bar[], n: number): number {
  const seg = bars.slice(-(n + 1)); if (seg.length < 2) return NaN;
  let s = 0, k = 0;
  for (let i = 1; i < seg.length; i++) {
    const a = seg[i - 1], b = seg[i];
    const ov = Math.max(0, Math.min(a.h, b.h) - Math.max(a.l, b.l));
    const un = Math.max(a.h, b.h) - Math.min(a.l, b.l);
    if (un > 0) { s += ov / un; k++; }
  }
  return k ? s / k : NaN;
}
/** Wick rejection: fraction of range that is the wick on the given side of a bar. */
export function wickRejection(b: Bar, side: "low" | "high"): number {
  const r = b.h - b.l; if (!(r > 0)) return 0;
  const bodyLo = Math.min(b.o, b.c), bodyHi = Math.max(b.o, b.c);
  return side === "low" ? (bodyLo - b.l) / r : (b.h - bodyHi) / r;
}

/**
 * Build a range candidate from confirmed pivots. Boundaries are FROZEN at creation; the candidate is
 * invalidated (never redrawn) if price closes beyond a boundary by more than the tolerance.
 * A candidate needs ≥ minTouches separated reactions on EACH side.
 */
export function detectRange(
  bars: Bar[], highs: Pivot[], lows: Pivot[], atrValue: number, cfg: AuricConfig["regime"], nowIndex: number,
): RangeCandidate | null {
  const lookback = 60;
  const hs = highs.filter((p) => p.confirmedAtIndex <= nowIndex && p.barIndex >= nowIndex - lookback);
  const ls = lows.filter((p) => p.confirmedAtIndex <= nowIndex && p.barIndex >= nowIndex - lookback);
  if (hs.length < cfg.rangeMinTouches || ls.length < cfg.rangeMinTouches) return null;
  const tol = 0.25 * atrValue;
  const cluster = (ps: Pivot[]) => {
    // group pivots whose prices lie within tol; pick the largest cluster
    let best: Pivot[] = [];
    for (const p of ps) {
      const g = ps.filter((q) => Math.abs(q.price - p.price) <= tol);
      if (g.length > best.length) best = g;
    }
    return best;
  };
  const ch = cluster(hs), cl = cluster(ls);
  if (ch.length < cfg.rangeMinTouches || cl.length < cfg.rangeMinTouches) return null;
  const separated = (g: Pivot[]) => { const idx = g.map((p) => p.barIndex).sort((a, b) => a - b); for (let i = 1; i < idx.length; i++) if (idx[i] - idx[i - 1] < cfg.rangeTouchSeparationBars) return false; return true; };
  if (!separated(ch) || !separated(cl)) return null;
  const resistance = Math.max(...ch.map((p) => p.price));
  const support = Math.min(...cl.map((p) => p.price));
  if (resistance - support < cfg.rangeMinWidthAtr * atrValue) return null;
  const createdAtIndex = Math.max(...[...ch, ...cl].map((p) => p.confirmedAtIndex));
  return {
    id: `rng-${bars[createdAtIndex]?.t ?? nowIndex}-${support.toFixed(2)}-${resistance.toFixed(2)}`,
    support, resistance, createdAtIndex, createdAt: bars[createdAtIndex]?.t ?? bars[nowIndex].t,
    touchesHigh: ch.map((p) => p.barIndex), touchesLow: cl.map((p) => p.barIndex), failedBreaks: 0, invalidated: false,
  };
}

/** Invalidate a frozen range when a bar CLOSES beyond a boundary by more than tolerance. Never redraws. */
export function checkRangeValidity(r: RangeCandidate, bar: Bar, atrValue: number): RangeCandidate {
  if (r.invalidated) return r;
  const tol = 0.35 * atrValue;
  if (bar.c > r.resistance + tol) return { ...r, invalidated: true, invalidReason: `M5 close ${bar.c.toFixed(2)} above frozen resistance ${r.resistance.toFixed(2)}` };
  if (bar.c < r.support - tol) return { ...r, invalidated: true, invalidReason: `M5 close ${bar.c.toFixed(2)} below frozen support ${r.support.toFixed(2)}` };
  return r;
}
