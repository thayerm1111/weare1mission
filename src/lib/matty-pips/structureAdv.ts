/**
 * MATTY PIPS — advanced market-structure intelligence. Context, never a
 * trade generator: external vs internal structure, structure breaks, change
 * of character, impulse/corrective legs, compression, exhaustion, and the
 * APPROACH QUALITY read (how price arrived at the level matters).
 */
import type { ApproachQuality, Candle, MarketState, StructureContext } from "./types";
import { atr, findPivots, type Pivot } from "./structure";

const f = (n: number) => (n >= 100 ? n.toFixed(1) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));

function trendOf(highs: Pivot[], lows: Pivot[]): MarketState {
  if (highs.length >= 2 && lows.length >= 2) {
    const [h1, h2] = highs.slice(-2), [l1, l2] = lows.slice(-2);
    if (h2.price > h1.price && l2.price > l1.price) return "UPTREND";
    if (h2.price < h1.price && l2.price < l1.price) return "DOWNTREND";
  }
  return "LEFT_TO_RIGHT";
}

/** Full structure read on the 15M (internal, k=2) vs 1H (external, k=2). */
export function structureContext(o: { h1: Candle[]; m15: Candle[] }): StructureContext {
  const h1c = o.h1.slice(0, -1), m15c = o.m15.slice(0, -1);
  const ext = findPivots(h1c, 2);
  const int_ = findPivots(m15c, 2);
  const extHighs = ext.filter((p) => p.kind === "high"), extLows = ext.filter((p) => p.kind === "low");
  const intHighs = int_.filter((p) => p.kind === "high"), intLows = int_.filter((p) => p.kind === "low");
  const externalTrend = trendOf(extHighs, extLows);
  const internalTrend = trendOf(intHighs, intLows);
  const price = m15c.length ? m15c[m15c.length - 1].c : 0;
  const a15 = atr(m15c);

  // Last structure break: latest close beyond the prior internal/external swing.
  let lastBreak: "internal" | "external" | null = null;
  let breakDir: "up" | "down" | null = null;
  const lastExtHigh = extHighs.length ? extHighs[extHighs.length - 1].price : null;
  const lastExtLow = extLows.length ? extLows[extLows.length - 1].price : null;
  const lastIntHigh = intHighs.length >= 2 ? intHighs[intHighs.length - 2].price : null;
  const lastIntLow = intLows.length >= 2 ? intLows[intLows.length - 2].price : null;
  const recent = m15c.slice(-8);
  if (lastExtHigh != null && recent.some((c) => c.c > lastExtHigh)) { lastBreak = "external"; breakDir = "up"; }
  else if (lastExtLow != null && recent.some((c) => c.c < lastExtLow)) { lastBreak = "external"; breakDir = "down"; }
  else if (lastIntHigh != null && recent.some((c) => c.c > lastIntHigh)) { lastBreak = "internal"; breakDir = "up"; }
  else if (lastIntLow != null && recent.some((c) => c.c < lastIntLow)) { lastBreak = "internal"; breakDir = "down"; }

  // Change of character: internal structure turned against external.
  const changeOfCharacter =
    (externalTrend === "UPTREND" && (internalTrend === "DOWNTREND" || breakDir === "down")) ||
    (externalTrend === "DOWNTREND" && (internalTrend === "UPTREND" || breakDir === "up"));

  // Impulse vs retracement: displacement of the last 6 candles vs ATR, and how
  // deep the current corrective leg cuts into the last impulse.
  const leg = m15c.slice(-6);
  const legMove = leg.length ? leg[leg.length - 1].c - leg[0].o : 0;
  const impulseStrength = Math.min(100, Math.round((Math.abs(legMove) / Math.max(a15 * 3, 1e-9)) * 100));
  let retracementStrength = 0;
  const lastSwing = int_[int_.length - 1];
  const prevSwing = int_[int_.length - 2];
  if (lastSwing && prevSwing && lastSwing.kind !== prevSwing.kind) {
    const legSize = Math.abs(lastSwing.price - prevSwing.price);
    const pullback = Math.abs(price - lastSwing.price);
    retracementStrength = legSize > 0 ? Math.min(100, Math.round((pullback / legSize) * 100)) : 0;
  }

  // Compression: highs flat-ish while lows step up (bullish), or mirror.
  let compression: StructureContext["compression"] = "none";
  if (intHighs.length >= 2 && intLows.length >= 2) {
    const hFlat = Math.abs(intHighs[intHighs.length - 1].price - intHighs[intHighs.length - 2].price) <= 0.6 * a15;
    const lFlat = Math.abs(intLows[intLows.length - 1].price - intLows[intLows.length - 2].price) <= 0.6 * a15;
    const lUp = intLows[intLows.length - 1].price > intLows[intLows.length - 2].price + 0.2 * a15;
    const hDn = intHighs[intHighs.length - 1].price < intHighs[intHighs.length - 2].price - 0.2 * a15;
    if (hFlat && lUp) compression = "bullish";
    else if (lFlat && hDn) compression = "bearish";
  }

  // Exhaustion evidence: big same-direction run + shrinking bodies + growing wicks.
  const run = m15c.slice(-5);
  const sameDir = run.every((c) => c.c >= c.o) || run.every((c) => c.c <= c.o);
  const traveled = run.length ? Math.abs(run[run.length - 1].c - run[0].o) : 0;
  const bodies = run.map((c) => Math.abs(c.c - c.o));
  const shrinking = bodies.length >= 3 && bodies[bodies.length - 1] < bodies[bodies.length - 3] * 0.6;
  const lastTwoWicky = run.slice(-2).every((c) => {
    const r = Math.max(c.h - c.l, 1e-9);
    return (r - Math.abs(c.c - c.o)) / r >= 0.55;
  });
  const exhaustion = traveled >= 3 * a15 && sameDir && (shrinking || lastTwoWicky);

  const bits: string[] = [];
  bits.push(`External ${externalTrend.replace(/_/g, " ").toLowerCase()}, internal ${internalTrend.replace(/_/g, " ").toLowerCase()}.`);
  if (lastBreak) bits.push(`Last ${lastBreak} structure break: ${breakDir}.`);
  if (changeOfCharacter) bits.push("Change of character — internal structure turned against the external trend.");
  if (compression !== "none") bits.push(`${compression === "bullish" ? "Bullish" : "Bearish"} compression building.`);
  if (exhaustion) bits.push(`Possible exhaustion after a ${f(traveled)} run.`);

  return {
    externalTrend, internalTrend,
    lastMajorSwingHigh: lastExtHigh, lastMajorSwingLow: lastExtLow,
    lastInternalSwingHigh: intHighs.length ? intHighs[intHighs.length - 1].price : null,
    lastInternalSwingLow: intLows.length ? intLows[intLows.length - 1].price : null,
    lastStructureBreak: lastBreak, structureBreakDirection: breakDir,
    changeOfCharacter, impulseStrength, retracementStrength, compression, exhaustion,
    detail: bits.join(" "),
  };
}

/** How did price ARRIVE at the level? Probability evidence, not a rule. */
export function approachQuality(o: { m15: Candle[]; node: { low: number; high: number; kind: "support" | "resistance" } }): ApproachQuality {
  const c = o.m15.slice(0, -1).slice(-16);
  if (c.length < 8) return { kind: "NEUTRAL", detail: "Not enough recent candles to judge the approach." };
  const a15 = atr(o.m15.slice(0, -1));
  const toward = o.node.kind === "resistance" ? 1 : -1;
  const dirCandles = c.slice(-6).filter((k) => (toward === 1 ? k.c > k.o : k.c < k.o)).length;
  const traveled = Math.abs(c[c.length - 1].c - c[0].o);
  const lastRanges = c.slice(-4).map((k) => k.h - k.l);
  const avgRange = lastRanges.reduce((x, y) => x + y, 0) / lastRanges.length;
  const expanding = avgRange >= 1.4 * a15;
  const contracting = avgRange <= 0.7 * a15;
  const touches = c.filter((k) => k.h >= o.node.low && k.l <= o.node.high).length;
  // pullback depth across the approach
  let maxPull = 0, extreme = toward === 1 ? -Infinity : Infinity;
  for (const k of c) {
    if (toward === 1) { extreme = Math.max(extreme, k.h); maxPull = Math.max(maxPull, extreme - k.l); }
    else { extreme = Math.min(extreme, k.l); maxPull = Math.max(maxPull, k.h - extreme); }
  }
  const shallowPullbacks = maxPull <= 1.0 * a15;

  if (expanding && traveled >= 3 * a15 && dirCandles >= 4) {
    return { kind: "FAST_EXPANSION", detail: `Vertical ${f(traveled)} run into the level on expanding candles — raises exhaustion/profit-taking odds at the first touch; a temporary rejection is more likely.` };
  }
  if (touches >= 3) {
    return { kind: "REPEATED_ATTACK", detail: `${touches} attacks on the level in the last ${c.length} candles — each defense spends the level's orders; repeated pressure often precedes a break.` };
  }
  if ((contracting || shallowPullbacks) && dirCandles >= 3) {
    return { kind: "GRIND_COMPRESSION", detail: `Grinding into the level with ${shallowPullbacks ? "shallow pullbacks" : "contracting candles"} — compression raises breakout probability; blindly fading first touch is lower quality.` };
  }
  if (dirCandles <= 2 && traveled < 1.5 * a15) {
    return { kind: "WEAK_CORRECTIVE", detail: "Drifting into the level on a weak corrective leg — the level has a better chance of holding." };
  }
  return { kind: "NEUTRAL", detail: "Ordinary approach — no strong lean from how price arrived." };
}
