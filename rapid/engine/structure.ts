import type { Bar, Pivot, Regime, Timeframe } from "../core/types";
import { atr } from "../market/bars";
import { TF_MS } from "../market/bars";

/**
 * Swing structure.
 *
 * A swing high is a bar whose high exceeds the highs of the `left` completed bars before it and the
 * `right` completed bars after it. Ties are resolved deterministically: STRICTLY greater to the left,
 * greater-or-EQUAL to the right. On a plateau of equal highs only the leftmost bar qualifies, because
 * every later member of the plateau fails the strict left-hand test. One plateau, one pivot, always
 * the same one.
 *
 * `t` is where the pivot is drawn. `knownAt` is the close of the last right-hand confirming bar —
 * the earliest moment any rule is allowed to use it. Everything downstream filters on knownAt.
 */
export function findPivots(bars: Bar[], timeframe: Timeframe, left: number, right: number): Pivot[] {
  const out: Pivot[] = [];
  const barMs = TF_MS[timeframe];
  for (let i = left; i < bars.length - right; i++) {
    const b = bars[i];
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= left && (isHigh || isLow); k++) {
      if (!(b.h > bars[i - k].h)) isHigh = false;
      if (!(b.l < bars[i - k].l)) isLow = false;
    }
    for (let k = 1; k <= right && (isHigh || isLow); k++) {
      if (!(b.h >= bars[i + k].h)) isHigh = false;
      if (!(b.l <= bars[i + k].l)) isLow = false;
    }
    // knownAt = the close of the last confirming bar to the right.
    const knownAt = bars[i + right].t + barMs;
    if (isHigh) out.push({ kind: "high", price: b.h, barIndex: i, t: b.t, knownAt, timeframe });
    if (isLow) out.push({ kind: "low", price: b.l, barIndex: i, t: b.t, knownAt, timeframe });
  }
  return out;
}

/** Only the pivots that were knowable at `asOf`. Nothing else may be read. */
export const pivotsKnownBy = (pivots: Pivot[], asOf: number): Pivot[] => pivots.filter((p) => p.knownAt <= asOf);

export type RegimeResult = {
  regime: Regime;
  reason: string;
  /** The four structural points the verdict rests on, when they exist. */
  highs: number[];
  lows: number[];
  tolerance: number;
};

/**
 * Regime from the last two confirmed highs and the last two confirmed lows on one timeframe.
 *
 * Both highs and both lows rising -> up. Both falling -> down. Anything else is sideways, and
 * "sideways" is NOT by itself a tradable range: a range must additionally pass validation.
 * Fewer than two confirmed swings per side is `unknown`, never a guess.
 *
 * The comparison tolerance absorbs noise so a one-tick difference is not read as a trend.
 */
export function classifyRegime(
  bars: Bar[],
  pivots: Pivot[],
  asOf: number,
  opts: { atrPeriod: number; noiseTicks: number; noiseAtrMult: number; tickSize: number; minSwingsPerSide: number },
): RegimeResult {
  const known = pivotsKnownBy(pivots, asOf);
  const highs = known.filter((p) => p.kind === "high").slice(-opts.minSwingsPerSide).map((p) => p.price);
  const lows = known.filter((p) => p.kind === "low").slice(-opts.minSwingsPerSide).map((p) => p.price);
  const a = atr(bars, opts.atrPeriod);
  const tolerance = Math.max(opts.noiseTicks * opts.tickSize, (a ?? 0) * opts.noiseAtrMult);

  if (highs.length < opts.minSwingsPerSide || lows.length < opts.minSwingsPerSide) {
    return {
      regime: "unknown",
      reason: `insufficient confirmed structure (${highs.length} highs, ${lows.length} lows; need ${opts.minSwingsPerSide} of each)`,
      highs, lows, tolerance,
    };
  }

  const risingHighs = highs[highs.length - 1] > highs[highs.length - 2] + tolerance;
  const risingLows = lows[lows.length - 1] > lows[lows.length - 2] + tolerance;
  const fallingHighs = highs[highs.length - 1] < highs[highs.length - 2] - tolerance;
  const fallingLows = lows[lows.length - 1] < lows[lows.length - 2] - tolerance;

  if (risingHighs && risingLows) return { regime: "up", reason: "higher high and higher low", highs, lows, tolerance };
  if (fallingHighs && fallingLows) return { regime: "down", reason: "lower high and lower low", highs, lows, tolerance };
  return { regime: "sideways", reason: "highs and lows disagree", highs, lows, tolerance };
}

/**
 * The protected swing a trend must keep for the position to stay valid.
 *
 * For a long: the most recent confirmed higher low WHOSE SUBSEQUENT ADVANCE BROKE the preceding
 * confirmed swing high. Both the pivot and the break must already be known — a low is not promoted
 * to "protected" just because price is currently above it.
 */
export function protectedSwing(
  bars: Bar[],
  pivots: Pivot[],
  side: "buy" | "sell",
  asOf: number,
): { price: number; knownAt: number; pivotT: number } | null {
  const known = pivotsKnownBy(pivots, asOf).slice().sort((a, b) => a.t - b.t);
  const wantLow = side === "buy";
  const anchors = known.filter((p) => (wantLow ? p.kind === "low" : p.kind === "high"));
  const opposites = known.filter((p) => (wantLow ? p.kind === "high" : p.kind === "low"));

  for (let i = anchors.length - 1; i >= 0; i--) {
    const anchor = anchors[i];
    // The confirmed opposite swing immediately preceding this anchor.
    const prior = [...opposites].reverse().find((p) => p.t < anchor.t);
    if (!prior) continue;
    // Did price break that prior swing AFTER the anchor, on a completed bar we already know about?
    const brokeAt = bars.find((b) => {
      const barClose = b.t + (bars.length > 1 ? bars[1].t - bars[0].t : 0);
      if (b.t <= anchor.t || barClose > asOf) return false;
      return wantLow ? b.c > prior.price : b.c < prior.price;
    });
    if (brokeAt) return { price: anchor.price, knownAt: Math.max(anchor.knownAt, brokeAt.t), pivotT: anchor.t };
  }
  return null;
}
