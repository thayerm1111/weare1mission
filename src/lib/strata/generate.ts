/**
 * STRATA / on-demand Opportunity Generator.
 *
 * This is a read-only scenario planner, NOT a trade signal emitter or a broker
 * executor. It uses only the same completed OHLC structure supplied to the
 * existing STRATA analyzer. The user can request a possible plan even when
 * the automatic readiness gate says "NO_SETUP"; doing so NEVER changes that
 * gate or the paper/real execution path.
 */
import { validBars, pivotsOf, type Analysis, type Bar, type Direction, type Scenario } from "./engine";

export type OpportunityTier = "ready" | "conditional" | "aggressive" | "none";
export type GeneratedOpportunity = {
  tier: OpportunityTier;
  label: string;
  scenario: Scenario | null;
  direction: Direction | null;
  reasons: string[];
  confirmationNeeded: string[];
  asOf: number;
  generatedAt: number;
  quoteAtGeneration: number | null;
  disclaimer: string;
};

type Input = {
  analysis: Analysis;
  bars: readonly Bar[];
  price: number;
  generatedAt: number;
  marketOpen: boolean;
  dataStale: boolean;
};

const r2 = (value: number) => Math.round(value * 100) / 100;
const fmt = (value: number) => r2(value).toFixed(2);
const isValid = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const statement = "Conditional research scenario, not a market order or a calibrated prediction.";

function none(input: Input, reason: string): GeneratedOpportunity {
  return {
    tier: "none", label: "No high-quality setup",
    scenario: null, direction: null,
    reasons: [reason],
    confirmationNeeded: ["Wait for fresh completed candles and a defensible structural level."],
    asOf: input.analysis.asOf, generatedAt: input.generatedAt,
    quoteAtGeneration: isValid(input.price) ? r2(input.price) : null,
    disclaimer: statement,
  };
}

function scenarioFrom(o: {
  side: Direction;
  type: Scenario["type"];
  title: string;
  level: number;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  atr: number;
  asOf: number;
  quality: number;
  trigger: string;
  invalidation: string;
  checks: Scenario["checks"];
}): Scenario | null {
  const { side, level, entry, stop, tp1, tp2, atr } = o;
  if (![level, entry, stop, tp1, tp2, atr].every(isValid) || atr < .01) return null;
  const correct = side === "buy"
    ? stop < entry && entry < tp1 && tp1 < tp2
    : stop > entry && entry > tp1 && tp1 > tp2;
  const risk = Math.abs(entry - stop);
  if (!correct || risk < Math.max(.30, atr * .22) ||
      risk > atr * 3.5 || Math.abs(tp1 - entry) / risk < 1.40) return null;
  const width = Math.max(atr * .23, .14);
  return {
    id: "generated:" + o.type + ":" + side + ":" + Math.round(level * 100) + ":" + o.asOf,
    type: o.type, side, stage: "watch", title: o.title,
    level: r2(level), entry: r2(entry), stop: r2(stop),
    targets: [r2(tp1), r2(tp2)], riskReward: r2(Math.abs(tp1 - entry) / risk),
    score: Math.max(0, Math.min(100, Math.round(o.quality))),
    zone: {
      low: r2(level - width), high: r2(level + width),
      label: "Conditional decision zone", kind: o.type === "range_fade"
        ? side === "buy" ? "support" : "resistance" : "retest",
    },
    reference: true, trigger: o.trigger, invalidation: o.invalidation,
    startedAt: o.asOf, checks: o.checks,
  };
}

/** Expose a price and risk geometry only as an explicitly future, conditional plan. */
function trendCandidate(input: Input, bars: Bar[], side: Direction,
  aggressive: boolean): { scenario: Scenario; tier: OpportunityTier; reasons: string[] } | null {
  const { analysis } = input, atr = analysis.atr;
  const direction = side === "buy" ? 1 : -1;
  const relevant = pivotsOf(bars.slice(-100)).filter((p) => p.side === (side === "buy" ? "high" : "low"));
  const recentBars = bars.slice(-38, -1);
  if (!recentBars.length) return null;
  // A confirmed 15m pivot is preferable; otherwise label an observed range extreme
  // as a watch level, never as a confirmed pivot.
  const recentPivot = relevant.at(-1);
  const observed = side === "buy"
    ? Math.max(...recentBars.map((b) => b.h))
    : Math.min(...recentBars.map((b) => b.l));
  const level = recentPivot?.price ?? observed;
  if (!isValid(level) || Math.abs(input.price - level) > atr * 7) return null;
  const entry = level + direction * Math.max(.13, atr * .16);
  const stop = level - direction * Math.max(.55, atr * .78);
  const risk = Math.abs(entry - stop);
  const tp1 = entry + direction * risk * 1.8;
  const tp2 = entry + direction * risk * 2.8;
  const sideVerb = side === "buy" ? "above" : "below";
  const retest = side === "buy" ? "support" : "resistance";
  const trend = aggressive ? "Unconfirmed regime" : "Aligned trend";
  const candidate = scenarioFrom({
    side, type: "break_retest",
    title: aggressive ? (side === "buy" ? "Aggressive bullish breakout watch" : "Aggressive bearish breakdown watch")
      : side === "buy" ? "Break the high · buy the retest" : "Break the low · sell the retest",
    level, entry, stop, tp1, tp2, atr, asOf: analysis.asOf,
    quality: aggressive ? 38 : Math.min(70, 53 + (recentPivot ? 8 : 0) +
      (analysis.momentum === (side === "buy" ? "Rising" : "Falling") ? 7 : 0)),
    trigger: "Wait for a completed 15m close " + sideVerb + " " + fmt(level) +
      ", then a separate retest that holds as " + retest +
      ". The reference entry at " + fmt(entry) + " is NOT a market order.",
    invalidation: "Cancel if 15m closes " + (side === "buy" ? "below " : "above ") + fmt(stop) +
      " or the break fails to hold the retest.",
    checks: [
      { label: "Market context", done: !aggressive,
        detail: aggressive ? "Higher timeframe structure conflicts. This is a speculative watch." :
          "Existing 1H and 4H trend alignment supports this direction." },
      { label: "Key price mapped", done: true,
        detail: recentPivot ? "Level comes from a confirmed 15-minute pivot." :
          "Level is a recorded 15-minute range extreme, not a confirmed pivot." },
      { label: "Break and close", done: false,
        detail: "A completed 15-minute candle must close through the level." },
      { label: "Retest acceptance", done: false,
        detail: "A later candle must retest, reject, and hold on the correct side." },
    ],
  });
  return candidate ? {
    scenario: candidate, tier: aggressive ? "aggressive" : "conditional",
    reasons: [trend + ": observed " + (side === "buy" ? "resistance" : "support") + " at " + fmt(level) + ".",
      "A break is NOT confirmed by this generated plan; wait for the break, retest, and acceptance close.",
      "The stop is placed across the mapped level using recorded 15m volatility (ATR " + fmt(atr) + ")."],
  } : null;
}

function rangeCandidate(input: Input, side: Direction, aggressive: boolean):
  { scenario: Scenario; tier: OpportunityTier; reasons: string[] } | null {
  const { analysis } = input, atr = analysis.atr, hi = analysis.range.high, lo = analysis.range.low;
  if (!isValid(lo) || !isValid(hi) || hi <= lo || hi - lo < atr * 1.7) return null;
  const up = side === "buy", level = up ? lo : hi;
  // The center is the first price-action objective; no invented 2R target.
  const width = hi - lo;
  const inside = Math.min(atr * .24, width * .055);
  const buffer = Math.max(atr * .49, width * .055);
  const entry = up ? lo + inside : hi - inside;
  const stop = up ? lo - buffer : hi + buffer;
  const mid = (lo + hi) / 2;
  const opposite = up ? hi - atr * .19 : lo + atr * .19;
  if (up ? opposite <= mid : opposite >= mid) return null;
  const scenario = scenarioFrom({
    side, type: "range_fade",
    title: side === "buy" ? "Buy support · bullish rejection" : "Sell resistance · bearish rejection",
    level, entry, stop, tp1: mid, tp2: opposite, atr,
    asOf: analysis.asOf,
    quality: aggressive ? 40 : 57 + (side === "buy"
      ? Math.min(13, analysis.range.bottomTouches * 3)
      : Math.min(13, analysis.range.topTouches * 3)),
    trigger: "Wait until gold reaches " + fmt(level) + " and a completed 15m " +
      (up ? "bullish rejection candle closes back ABOVE support." :
        "bearish rejection candle closes back BELOW resistance.") +
      " The plotted entry is conditional until that happens.",
    invalidation: "Cancel if a 15m candle closes " + (up ? "below " : "above ") + fmt(stop) +
      " or price breaks outside the range.",
    checks: [
      { label: "Market range", done: !aggressive,
        detail: aggressive ? "The higher-timeframe range is unconfirmed; no trade is ready." :
          "STRATA verified a balanced range with repeated highs and lows." },
      { label: "Decision zone", done: true,
        detail: "Support/resistance comes from recorded 15m candles." },
      { label: "Touch and rejection", done: false,
        detail: "Price must touch the edge and close back into the range." },
      { label: "Entry confirmation", done: false,
        detail: "A reversal candle must close before considering the reference entry." },
    ],
  });
  return scenario ? {
    scenario, tier: aggressive ? "aggressive" : "conditional",
    reasons: [(aggressive ? "Unconfirmed balance" : "Range structure") +
      ": recorded boundaries " + fmt(lo) + "–" + fmt(hi) + ".",
      side === "buy" ? "The closest buy reference is the lower edge; waiting for a bullish rejection." :
        "The closest sell reference is the upper edge; waiting for a bearish rejection.",
      "First objective is the recorded range midpoint at " + fmt(mid) + "; the outer edge is a secondary objective."],
  } : null;
}

export function generatePossibleEntry(input: Input): GeneratedOpportunity {
  const bars = validBars(input.bars);
  if (!input.analysis || !isValid(input.price) || !Number.isFinite(input.generatedAt) ||
      bars.length < 75 || !isValid(input.analysis.atr) ||
      !Number.isFinite(input.analysis.asOf)) {
    return none(input, "There is not enough verified market data to calculate a defensible entry.");
  }
  if (input.dataStale || input.generatedAt - (input.analysis.asOf + 900_000) > 35 * 60_000) {
    return none(input, "Completed price-action candles are stale; new entry scenarios are withheld.");
  }
  const analysis = input.analysis;
  const ready = analysis.primary;
  // Only the automatic, completed-candle qualified setup can receive READY.
  // This generator cannot upgrade a speculative idea to an executable signal.
  const liveReady = input.marketOpen && analysis.status === "READY" &&
    ready?.stage === "ready" && ready.entry !== null && ready.stop !== null &&
    ready.targets.length > 0 && Math.abs(input.price - ready.entry) <= analysis.atr * .4;
  if (liveReady && ready) {
    return {
      tier: "ready", label: "Ready setup", scenario: ready, direction: ready.side,
      reasons: ["STRATA's standard engine confirmed this setup on completed candles.",
        ...analysis.reasons.slice(0, 2)],
      confirmationNeeded: ["Re-check current spread and broker quote before any trade.",
        "Validate risk and any scheduled economic news."],
      asOf: analysis.asOf, generatedAt: input.generatedAt,
      quoteAtGeneration: r2(input.price), disclaimer: statement,
    };
  }

  const regime = analysis.regime;
  let picked: ReturnType<typeof trendCandidate> | ReturnType<typeof rangeCandidate> = null;
  if (regime === "uptrend" || regime === "downtrend") {
    picked = trendCandidate(input, bars, regime === "uptrend" ? "buy" : "sell", false);
  } else if (regime === "range") {
    const nearBuy = Math.abs(input.price - analysis.range.low) <=
      Math.abs(input.price - analysis.range.high);
    // Choose the nearer edge, but do not force it if geometry is invalid.
    picked = rangeCandidate(input, nearBuy ? "buy" : "sell", false) ??
      rangeCandidate(input, nearBuy ? "sell" : "buy", false);
  } else {
    // Mixed market: search the real last-40-bar high and low. Momentum influences
    // which breakout to monitor, but conflicting structure NEVER grants READY.
    // A range-edge watch is a fallback only when its geometry is defensible.
    const side = analysis.momentum === "Rising" ? "buy" :
      analysis.momentum === "Falling" ? "sell" :
        Math.abs(input.price - analysis.range.high) < Math.abs(input.price - analysis.range.low)
          ? "buy" : "sell";
    picked = trendCandidate(input, bars, side, true) ??
      rangeCandidate(input, side === "buy" ? "sell" : "buy", true);
  }
  if (!picked) return none(input, "Neither the recorded swings nor range edges offer defensible stop-and-target geometry.");

  const suffix = !input.marketOpen
    ? "Gold is closed. This is a plan for a future session, not a live opportunity."
    : "The trigger has not completed. This is a conditional watch, not an entry now.";
  return {
    tier: picked.tier,
    label: picked.tier === "aggressive" ? "Aggressive watchlist" : "Conditional setup",
    scenario: picked.scenario, direction: picked.scenario.side,
    reasons: [...picked.reasons, suffix],
    confirmationNeeded: [
      ...picked.scenario.checks.filter((step) => !step.done).map((step) => step.label + ": " + step.detail),
      "Invalidate the idea if price breaks its structural stop or conditions change.",
    ],
    asOf: analysis.asOf, generatedAt: input.generatedAt,
    quoteAtGeneration: r2(input.price), disclaimer: statement,
  };
}
