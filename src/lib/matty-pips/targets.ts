/**
 * MATTY PIPS — stops, targets, management. STRUCTURAL stops (where the thesis
 * is actually wrong — beyond the sweep extreme / complex / breakout structure,
 * plus a volatility buffer) — NEVER tightened to satisfy a pip limit. Wider
 * stop → smaller position (sizing is auto-trade's job later).
 * Targets: TP1 ≈ 1R (capped at the next meaningful level if closer),
 * TP2 ≈ 2R when structure permits, runner toward the range midpoint and/or
 * the next major level. Management: BE → partial → LOCKED PROFIT (+30),
 * never backward.
 */
import type { ManagementPlan, RankedLevel, SetupType, TradeIdea } from "./types";
import { pipsToPrice, priceToPips, roundPx } from "./pips";

export function buildTrade(o: {
  symbol: string;
  setupType: SetupType;
  direction: "buy" | "sell";
  price: number;
  node: { low: number; high: number };
  sweepExtreme: number | null;      // stop goes beyond this when a sweep happened
  breakStructure: number | null;    // breakout candle low/high or retest structure
  levels: RankedLevel[];
  rangeMid: number;                 // 50% of the active range
  atr15: number;
}): { trade: Omit<TradeIdea, "management"> | null; reason: string | null; riskDist: number; roomToNext: number | null } {
  const long = o.direction === "buy";
  const buf = 0.5 * o.atr15;

  // STOP — beyond whichever structure actually invalidates the idea.
  const candidates: number[] = [];
  if (long) {
    candidates.push(o.node.low - buf);
    if (o.sweepExtreme != null) candidates.push(o.sweepExtreme - buf);
    if (o.breakStructure != null) candidates.push(o.breakStructure - buf);
  } else {
    candidates.push(o.node.high + buf);
    if (o.sweepExtreme != null) candidates.push(o.sweepExtreme + buf);
    if (o.breakStructure != null) candidates.push(o.breakStructure + buf);
  }
  const stop = roundPx(o.symbol, long ? Math.min(...candidates) : Math.max(...candidates));
  const riskDist = Math.abs(o.price - stop);
  if (!(riskDist > 0)) return { trade: null, reason: "Stop distance computed to zero.", riskDist: 0, roomToNext: null };

  // ROOM — distance to the next meaningful opposing level.
  const opposing = o.levels
    .filter((l) => (long ? l.kind === "resistance" && l.low > o.price : l.kind === "support" && l.high < o.price))
    .sort((a, b) => (long ? a.low - b.low : b.high - a.high));
  const nextLevel = opposing[0] ?? null;
  const roomToNext = nextLevel ? (long ? nextLevel.low - o.price : o.price - nextLevel.high) : null;

  // TP1 ≈ 1R, capped at the next level's near edge if that's closer.
  const oneR = long ? o.price + riskDist : o.price - riskDist;
  let tp1 = oneR;
  if (nextLevel) {
    const edge = long ? nextLevel.low : nextLevel.high;
    tp1 = long ? Math.min(oneR, edge) : Math.max(oneR, edge);
  }
  tp1 = roundPx(o.symbol, tp1);
  const reward1 = Math.abs(tp1 - o.price);
  if (reward1 < 0.35 * riskDist) {
    return { trade: null, reason: `Next level is only ${priceToPips(o.symbol, reward1)} pips away against a ${priceToPips(o.symbol, riskDist)}-pip structural stop — no room. WAIT.`, riskDist, roomToNext };
  }

  // TP2 ≈ 2R when structure permits (capped at the second level).
  const twoR = long ? o.price + 2 * riskDist : o.price - 2 * riskDist;
  let tp2: number | null = twoR;
  const second = opposing[1] ?? null;
  const cap2 = second ? (long ? second.low : second.high) : null;
  if (cap2 != null) tp2 = long ? Math.min(twoR, cap2) : Math.max(twoR, cap2);
  if (Math.abs((tp2 as number) - o.price) <= reward1 * 1.1) tp2 = null; // structure doesn't permit a real second target
  if (tp2 != null) tp2 = roundPx(o.symbol, tp2);

  // RUNNER — 50% of the active range and/or the next MAJOR level, whichever is
  // the meaningful destination in the trade direction.
  const majors = opposing.filter((l) => l.rank >= 55);
  const majorTarget = majors.length ? (long ? majors[0].low : majors[0].high) : null;
  const midOk = long ? o.rangeMid > o.price + reward1 : o.rangeMid < o.price - reward1;
  let runner: number | null = null;
  if (majorTarget != null && midOk) runner = long ? Math.max(o.rangeMid, majorTarget) : Math.min(o.rangeMid, majorTarget);
  else if (majorTarget != null) runner = majorTarget;
  else if (midOk) runner = o.rangeMid;
  if (runner != null) runner = roundPx(o.symbol, runner);

  return {
    trade: {
      direction: o.direction, setupType: o.setupType,
      entry: roundPx(o.symbol, o.price),
      entryZone: { low: roundPx(o.symbol, o.node.low), high: roundPx(o.symbol, o.node.high) },
      stopLoss: stop, tp1, tp2, runnerTarget: runner,
      riskReward: +(reward1 / riskDist).toFixed(2),
      invalidationLevel: stop,
      stopPips: priceToPips(o.symbol, riskDist),
      tp1Pips: priceToPips(o.symbol, reward1),
    },
    reason: null, riskDist, roomToNext,
  };
}

/** Management plan: BE first, partial at ~halfway/+50–70p, then LOCK ~+30. */
export function managementPlan(o: { symbol: string; setupType: SetupType; tp1Pips: number; runnerDesc: string }): ManagementPlan {
  const halfway = Math.round(o.tp1Pips / 2);
  const isBreakout = o.setupType.startsWith("BREAKOUT") || o.setupType.startsWith("CONTINUATION");
  return {
    breakevenAtPips: 30,
    partialAtPips: isBreakout ? 60 : Math.max(40, halfway),
    partialAtHalfwayToTarget: !isBreakout,
    lockProfitPips: 30,   // after the partial the stop LOCKS ~+30 in profit — never backward
    runnerToward: o.runnerDesc,
  };
}

// keep the pip helper imported surface stable
export { pipsToPrice };
