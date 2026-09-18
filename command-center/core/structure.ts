/**
 * MARKET STRUCTURE — swings, sequence, breaks, ranges, sweeps and reclaims.
 *
 * A pivot is only real once `right` bars have closed beyond it. That delay is the point: a structure engine
 * that recognises a swing high on the bar it prints will "see" highs that later turn out never to have
 * existed, and every downstream decision inherits that lie.
 */
import type { Bar, StructureState } from "./types";

export type Pivot = { kind: "high" | "low"; i: number; t: number; price: number };

export function pivots(bars: Bar[], left = 2, right = 2): Pivot[] {
  const out: Pivot[] = [];
  for (let i = left; i < bars.length - right; i++) {
    const w = bars.slice(i - left, i + right + 1);
    const b = bars[i];
    if (w.every((x, k) => k === left || x.h <= b.h)) out.push({ kind: "high", i, t: b.t, price: b.h });
    if (w.every((x, k) => k === left || x.l >= b.l)) out.push({ kind: "low", i, t: b.t, price: b.l });
  }
  return out;
}

/** HH/HL vs LH/LL from the last two confirmed highs and lows. */
export function sequenceOf(ps: Pivot[]): StructureState["sequence"] {
  const highs = ps.filter((p) => p.kind === "high").slice(-2);
  const lows = ps.filter((p) => p.kind === "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "unknown";
  const hh = highs[1].price > highs[0].price;
  const hl = lows[1].price > lows[0].price;
  if (hh && hl) return "HH_HL";
  if (!hh && !hl) return "LH_LL";
  return "mixed";
}

/** The box price has been trading in over the last n bars. */
export function box(bars: Bar[], n = 60): { high: number; low: number; width: number } | null {
  if (bars.length < Math.min(n, 10)) return null;
  const w = bars.slice(-n);
  const high = Math.max(...w.map((b) => b.h));
  const low = Math.min(...w.map((b) => b.l));
  return { high, low, width: high - low };
}

/**
 * A break of structure needs a CLOSE beyond the level, not a wick through it. A wick that pokes a level and
 * comes back is the opposite signal — it is the market rejecting that level.
 */
export function breakOfStructure(bars: Bar[], level: number, dir: "up" | "down", lookback = 6): boolean {
  return bars.slice(-lookback).some((b) => (dir === "up" ? b.c > level : b.c < level));
}

/** Price traded beyond the level and closed back inside within `lookback` bars: a sweep that reclaimed. */
export function sweepReclaim(bars: Bar[], level: number, dir: "above" | "below", lookback = 8):
  { swept: boolean; reclaimed: boolean; extreme: number | null } {
  const w = bars.slice(-lookback);
  if (!w.length) return { swept: false, reclaimed: false, extreme: null };
  const swept = dir === "above" ? w.some((b) => b.h > level) : w.some((b) => b.l < level);
  if (!swept) return { swept: false, reclaimed: false, extreme: null };
  const extreme = dir === "above" ? Math.max(...w.map((b) => b.h)) : Math.min(...w.map((b) => b.l));
  const lastBar = w[w.length - 1];
  const reclaimed = dir === "above" ? lastBar.c < level : lastBar.c > level;
  return { swept: true, reclaimed, extreme };
}

/**
 * Retest quality, 0–1: price came back to a broken level and defended it. Measured on the bar that touched
 * the level — how much of its range closed away from the level. A 0.9 is a wick rejection; a 0.5 is a
 * shrug; below the floor it is not a retest at all, it is acceptance back inside.
 */
export function retestQuality(bar: Bar, level: number, dir: "up" | "down", tol: number): number | null {
  const rng = Math.max(bar.h - bar.l, 1e-9);
  if (dir === "up") {
    if (!(bar.l <= level + tol && bar.c > level)) return null;
    return Math.max(0, Math.min(1, (bar.c - bar.l) / rng));
  }
  if (!(bar.h >= level - tol && bar.c < level)) return null;
  return Math.max(0, Math.min(1, (bar.h - bar.c) / rng));
}

export function structureOf(bars: Bar[], opts: { pivotLeft?: number; pivotRight?: number; boxBars?: number } = {}): StructureState {
  const ps = pivots(bars, opts.pivotLeft ?? 2, opts.pivotRight ?? 2);
  const highs = ps.filter((p) => p.kind === "high");
  const lows = ps.filter((p) => p.kind === "low");
  const swingHigh = highs.length ? highs[highs.length - 1].price : null;
  const swingLow = lows.length ? lows[lows.length - 1].price : null;
  const b = box(bars, opts.boxBars ?? 60);
  const c = bars.length ? bars[bars.length - 1].c : 0;

  let brokeStructure: "up" | "down" | null = null;
  if (swingHigh != null && breakOfStructure(bars, swingHigh, "up")) brokeStructure = "up";
  else if (swingLow != null && breakOfStructure(bars, swingLow, "down")) brokeStructure = "down";

  // A failed break: it broke, then closed back inside. The market tried and was refused.
  let failedBreak: "up" | "down" | null = null;
  if (brokeStructure === "up" && swingHigh != null && c < swingHigh) failedBreak = "up";
  if (brokeStructure === "down" && swingLow != null && c > swingLow) failedBreak = "down";

  const sweptHigh = swingHigh != null ? sweepReclaim(bars, swingHigh, "above") : null;
  const sweptLow = swingLow != null ? sweepReclaim(bars, swingLow, "below") : null;
  const swept = sweptHigh?.swept && sweptHigh.reclaimed ? swingHigh
    : sweptLow?.swept && sweptLow.reclaimed ? swingLow : null;

  return {
    swingHigh, swingLow,
    sequence: sequenceOf(ps),
    brokeStructure, failedBreak,
    rangeHigh: b?.high ?? null,
    rangeLow: b?.low ?? null,
    positionInRange: b && b.width > 0 ? Math.max(0, Math.min(1, (c - b.low) / b.width)) : null,
    sweptLevel: swept,
    reclaimed: !!swept,
  };
}
