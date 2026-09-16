import { type Bar, atr } from "./candles";

/**
 * Non-repainting structure. A pivot at index i is CONFIRMED only after `right` further
 * CLOSED bars exist; `confirmedAt` is the close time of bar i+right. Tentative pivots
 * (fewer right bars) are reported separately and never used for decisions.
 */
export type Pivot = { kind: "high" | "low"; i: number; t: number; price: number; confirmedAt: number };

export function pivots(bars: Bar[], left: number, right: number, tfMs: number): { confirmed: Pivot[]; tentative: Pivot[] } {
  const confirmed: Pivot[] = [], tentative: Pivot[] = [];
  for (let i = left; i < bars.length; i++) {
    const avail = Math.min(right, bars.length - 1 - i);
    let hi = true, lo = true;
    for (let k = i - left; k <= i + avail; k++) {
      if (k === i) continue;
      if (bars[k].h >= bars[i].h) hi = false;
      if (bars[k].l <= bars[i].l) lo = false;
    }
    const push = (p: Pivot) => (avail >= right ? confirmed : tentative).push(p);
    const confirmedAt = bars[Math.min(i + right, bars.length - 1)].t + tfMs;
    if (hi) push({ kind: "high", i, t: bars[i].t, price: bars[i].h, confirmedAt });
    if (lo) push({ kind: "low", i, t: bars[i].t, price: bars[i].l, confirmedAt });
  }
  return { confirmed, tentative };
}

export type SwingState = {
  lastHigh: Pivot | null; prevHigh: Pivot | null; lastLow: Pivot | null; prevLow: Pivot | null;
  hh: boolean; hl: boolean; lh: boolean; ll: boolean;
  trend: "up" | "down" | "none";
  bos: "up" | "down" | null;     // latest close beyond the last confirmed swing in the trend direction
  choch: "up" | "down" | null;   // latest close beyond the last confirmed swing AGAINST the prior trend
};

export function swingState(bars: Bar[], conf: Pivot[]): SwingState {
  const highs = conf.filter((p) => p.kind === "high");
  const lows = conf.filter((p) => p.kind === "low");
  const lastHigh = highs.at(-1) ?? null, prevHigh = highs.at(-2) ?? null;
  const lastLow = lows.at(-1) ?? null, prevLow = lows.at(-2) ?? null;
  const hh = !!(lastHigh && prevHigh && lastHigh.price > prevHigh.price);
  const hl = !!(lastLow && prevLow && lastLow.price > prevLow.price);
  const lh = !!(lastHigh && prevHigh && lastHigh.price < prevHigh.price);
  const ll = !!(lastLow && prevLow && lastLow.price < prevLow.price);
  const trend = hh && hl ? "up" : lh && ll ? "down" : "none";
  const close = bars.at(-1)?.c ?? NaN;
  let bos: SwingState["bos"] = null, choch: SwingState["choch"] = null;
  if (lastHigh && close > lastHigh.price) { if (trend === "down") choch = "up"; else bos = "up"; }
  if (lastLow && close < lastLow.price) { if (trend === "up") choch = "down"; else bos = "down"; }
  return { lastHigh, prevHigh, lastLow, prevLow, hh, hl, lh, ll, trend, bos, choch };
}

export type Box = { high: number; low: number; width: number; touchesHigh: number; touchesLow: number; bars: number };
export function box(bars: Bar[], n: number, touchTol: number, end = bars.length): Box | null {
  if (end < n) return null;
  const w = bars.slice(end - n, end);
  const high = Math.max(...w.map((b) => b.h)), low = Math.min(...w.map((b) => b.l));
  return {
    high, low, width: high - low, bars: n,
    touchesHigh: w.filter((b) => high - b.h <= touchTol).length,
    touchesLow: w.filter((b) => b.l - low <= touchTol).length,
  };
}

/** |net move| ÷ path length over the last n closes (1 = straight line, 0 = pure chop). */
export function efficiency(bars: Bar[], n: number, end = bars.length): number | null {
  if (end < n + 1) return null;
  let path = 0;
  for (let i = end - n; i < end; i++) path += Math.abs(bars[i].c - bars[i - 1].c);
  return path > 0 ? Math.abs(bars[end - 1].c - bars[end - n - 1].c) / path : 0;
}

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1); const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

/** Liquidity sweep of `level` within the last `lookback` closed bars, reclaimed by the latest close. */
export function sweepReclaim(bars: Bar[], level: number, side: "below" | "above", buffer: number, lookback: number): { swept: boolean; extreme: number | null; barsAgo: number | null } {
  const n = bars.length;
  if (n < 2) return { swept: false, extreme: null, barsAgo: null };
  const last = bars[n - 1];
  let extreme: number | null = null, barsAgo: number | null = null;
  for (let k = 0; k < lookback && n - 1 - k >= 0; k++) {
    const b = bars[n - 1 - k];
    if (side === "below" && b.l < level - buffer) { if (extreme == null || b.l < extreme) { extreme = b.l; barsAgo = k; } }
    if (side === "above" && b.h > level + buffer) { if (extreme == null || b.h > extreme) { extreme = b.h; barsAgo = k; } }
  }
  const reclaimed = side === "below" ? last.c > level : last.c < level;
  return { swept: extreme != null && reclaimed, extreme, barsAgo };
}

export { atr };
