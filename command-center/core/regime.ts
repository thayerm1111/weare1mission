/**
 * TIMEFRAME STATE, PRESSURE AND REGIME.
 *
 * These are the system's opinions — and every one of them is a deterministic function of the measurements
 * in math.ts and structure.ts. When Atlas says "the market is in compression", that sentence can be
 * traced to an efficiency number and a volatility ratio, not to a model's mood.
 */
import type { Bar, Features, Pressure, Regime, StructureState, TfState } from "./types";
import { features } from "./math";
import { structureOf } from "./structure";

/** One timeframe's state. Thresholds are deliberately explicit so they can be argued with and tuned. */
export function tfState(f: Features, s: StructureState): TfState {
  const trending = f.slopeR2 >= 0.55 && f.efficiency >= 0.35;
  const strong = Math.abs(f.slope) >= 1.5 && f.efficiency >= 0.5;

  if (f.volRatio <= 0.65 && f.efficiency < 0.3) return "compression";
  if (f.rangeExpansion >= 2.2 && f.volRatio >= 1.3) return "volatility_expansion";
  if (s.brokeStructure && !s.failedBreak && f.rangeExpansion >= 1.4) return "breakout";

  if (trending && f.slope > 0) {
    if (strong && f.slope >= 2.5) return "strong_uptrend";
    return f.slope >= 1 ? "uptrend" : "weak_uptrend";
  }
  if (trending && f.slope < 0) {
    if (strong && f.slope <= -2.5) return "strong_downtrend";
    return f.slope <= -1 ? "downtrend" : "weak_downtrend";
  }
  if (s.sequence === "HH_HL" && f.slope > 0) return "bullish_transition";
  if (s.sequence === "LH_LL" && f.slope < 0) return "bearish_transition";
  if (f.efficiency < 0.18 && f.slopeR2 < 0.25) return "chaotic";
  return "range";
}

const BULLISH_STATES: TfState[] = ["strong_uptrend", "uptrend", "weak_uptrend", "bullish_transition"];
const BEARISH_STATES: TfState[] = ["strong_downtrend", "downtrend", "weak_downtrend", "bearish_transition"];
export const isBullish = (s: TfState) => BULLISH_STATES.includes(s);
export const isBearish = (s: TfState) => BEARISH_STATES.includes(s);

/**
 * PRESSURE — who is winning, from evidence that actually exists for a CFD: where candles close inside their
 * range, which side the wicks punish, momentum, and whether structure is being accepted or rejected.
 *
 * This is explicitly NOT an order book. Calling an estimate "order flow" would be a lie, and a lie in a
 * measurement is worse than a missing measurement.
 */
export function pressureOf(f: Features, s: StructureState, prev?: Pressure | null): Pressure {
  const sig = (x: number) => 1 / (1 + Math.exp(-x));
  const momentum = sig(f.velocity * 2.2);
  const closes = sig(f.bodyBias * 3);
  const wicks = sig(-f.wickBias * 3);
  const trend = sig(f.slope * 0.9);
  const accept = s.brokeStructure === "up" && !s.failedBreak ? 0.75
    : s.brokeStructure === "down" && !s.failedBreak ? 0.25
    : s.failedBreak === "up" ? 0.3 : s.failedBreak === "down" ? 0.7 : 0.5;

  const bull = (momentum * 0.28 + closes * 0.22 + wicks * 0.18 + trend * 0.2 + accept * 0.12) * 100;
  const bullish = Math.round(Math.max(0, Math.min(100, bull)));
  const bearish = 100 - bullish;
  const net = bullish - bearish;
  return { bullish, bearish, net, acceleration: prev ? net - prev.net : 0 };
}

/**
 * THE REGIME — what kind of market this is, which decides which strategies are even eligible. Higher
 * timeframes set the context; the execution timeframe supplies the texture.
 */
export function regimeOf(input: {
  exec: { f: Features; s: StructureState };
  context: { f: Features; s: StructureState } | null;
  newsShock?: boolean;
  minutesSinceNews?: number | null;
}): Regime {
  const { exec, context } = input;
  if (input.newsShock) return "news_shock";
  if (input.minutesSinceNews != null && input.minutesSinceNews <= 30) return "post_news_discovery";

  if (exec.f.efficiency < 0.15 && exec.f.slopeR2 < 0.2) return "chaotic";
  if (exec.f.volRatio <= 0.6 && exec.f.efficiency < 0.3) return exec.f.volRatio <= 0.45 ? "volatility_squeeze" : "compression";

  if (exec.s.sweptLevel != null && exec.s.reclaimed) return "liquidity_sweep";
  if (exec.s.failedBreak) return "breakout_failure";
  if (exec.s.brokeStructure && exec.f.rangeExpansion >= 1.5) return "breakout";
  if (exec.s.brokeStructure && exec.f.rangeExpansion < 1.2 && exec.f.volRatio < 1.1) return "breakout_retest";
  if (exec.f.rangeExpansion >= 2.2) return "expansion";

  const ctxSlope = context?.f.slope ?? exec.f.slope;
  const aligned = Math.sign(ctxSlope) === Math.sign(exec.f.slope) && Math.abs(exec.f.slope) >= 1;
  if (aligned && exec.f.efficiency >= 0.45 && exec.f.slopeR2 >= 0.6) {
    if (Math.abs(exec.f.slope) >= 3 && exec.f.volRatio >= 1.5) return "parabolic";
    if (Math.abs(exec.f.slope) >= 2) return "strong_momentum";
    return exec.f.slope > 0 ? "trend_up" : "trend_down";
  }
  if (aligned && exec.f.slopeR2 >= 0.5) return "orderly_trend";

  if (Math.abs(exec.f.zScore) >= 2 && exec.f.efficiency < 0.35) return "mean_reversion";
  if (exec.s.positionInRange != null && exec.f.efficiency < 0.3) {
    const width = (exec.s.rangeHigh ?? 0) - (exec.s.rangeLow ?? 0);
    return width > 0 && width < exec.f.atr * 6 ? "tight_range" : "sideways_range";
  }
  if (Math.sign(ctxSlope) !== Math.sign(exec.f.slope)) return "transition";
  return "sideways_range";
}

/** Convenience: build state + structure + pressure for one timeframe's bars. */
export function analyseTf(bars: Bar[], prev?: Pressure | null): { f: Features; s: StructureState; state: TfState; pressure: Pressure } | null {
  const f = features(bars);
  if (!f) return null;
  const s = structureOf(bars);
  return { f, s, state: tfState(f, s), pressure: pressureOf(f, s, prev) };
}
