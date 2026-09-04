/**
 * MATTY PIPS — stops, targets, R:R. Structure + volatility, never arbitrary.
 * WAIT (null) when no sensible trade exists is a first-class result.
 */
import type { SetupType, TradeIdea, Zone } from "./types";
import { minStopPips, pipsToPrice, priceToPips, roundPx } from "./pips";

export const MIN_RR_DEFAULT = 2.0;

/**
 * Build the trade numbers for a setup at a zone. Returns null (with a reason)
 * when the math doesn't clear the R:R floor — that's a WAIT, not a failure.
 */
export function buildTrade(o: {
  symbol: string;
  setupType: SetupType;
  direction: "buy" | "sell";
  price: number;
  zone: Zone;                 // the zone we're trading from (or breaking)
  zones: Zone[];              // all zones (for targets)
  atr15: number;
  minRR?: number;
}): { trade: TradeIdea | null; reason: string | null } {
  const z = o.zone;
  const minRR = o.minRR ?? MIN_RR_DEFAULT;
  const long = o.direction === "buy";

  // STOP: beyond the zone's far edge + 0.5×ATR(15M), floored per instrument.
  const structuralStop = long ? z.zoneLow - 0.5 * o.atr15 : z.zoneHigh + 0.5 * o.atr15;
  const floorDist = pipsToPrice(o.symbol, minStopPips(o.symbol));
  let stop = structuralStop;
  if (long && o.price - stop < floorDist) stop = o.price - floorDist;
  if (!long && stop - o.price < floorDist) stop = o.price + floorDist;
  stop = roundPx(o.symbol, stop);
  const risk = Math.abs(o.price - stop);
  if (!(risk > 0)) return { trade: null, reason: "Stop distance computed to zero — no trade." };

  // TARGETS: next opposing zones, nearest-first.
  const opposing = o.zones
    .filter((x) => (long ? x.zoneType === "resistance" && x.zoneLow > o.price : x.zoneType === "support" && x.zoneHigh < o.price))
    .sort((a, b) => (long ? a.zoneLow - b.zoneLow : b.zoneHigh - a.zoneHigh));

  if (!opposing.length) {
    // Breakout runner into open air: project from volatility instead of a zone.
    if (o.setupType === "BREAKOUT_RUNNER") {
      const tp1 = roundPx(o.symbol, long ? o.price + minRR * risk : o.price - minRR * risk);
      const runner = roundPx(o.symbol, long ? o.price + 2 * minRR * risk : o.price - 2 * minRR * risk);
      return {
        trade: {
          direction: o.direction, setupType: o.setupType,
          entry: roundPx(o.symbol, o.price),
          entryZone: { low: roundPx(o.symbol, z.zoneLow), high: roundPx(o.symbol, z.zoneHigh) },
          stopLoss: stop, tp1, tp2: null, runnerTarget: runner,
          riskReward: minRR,
          invalidationLevel: roundPx(o.symbol, long ? z.zoneLow - 0.25 * o.atr15 : z.zoneHigh + 0.25 * o.atr15),
          stopPips: priceToPips(o.symbol, risk), tp1Pips: priceToPips(o.symbol, Math.abs(tp1 - o.price)),
        },
        reason: null,
      };
    }
    return { trade: null, reason: "No opposing zone to target — nothing sensible to aim at." };
  }

  const t1z = opposing[0];
  const tp1 = roundPx(o.symbol, long ? t1z.zoneLow : t1z.zoneHigh); // near edge — conservative target
  const reward = Math.abs(tp1 - o.price);
  const rr = +(reward / risk).toFixed(2);
  if (rr < minRR) {
    return { trade: null, reason: `Best target ${tp1} gives only ${rr}:1 against a ${priceToPips(o.symbol, risk)}-pip stop — below the ${minRR}:1 floor. WAIT.` };
  }

  const t2z = opposing[1] ?? null;
  const tp2 = t2z ? roundPx(o.symbol, long ? t2z.zoneLow : t2z.zoneHigh) : null;
  // Runner: the strongest Daily-weighted opposing zone (major level), else TP2/TP1.
  const major = opposing.filter((x) => x.timeframes.includes("D")).sort((a, b) => b.strengthScore - a.strengthScore)[0] ?? null;
  const runnerTarget = major ? roundPx(o.symbol, long ? major.zoneLow : major.zoneHigh) : tp2 ?? tp1;

  return {
    trade: {
      direction: o.direction, setupType: o.setupType,
      entry: roundPx(o.symbol, o.price),
      entryZone: { low: roundPx(o.symbol, z.zoneLow), high: roundPx(o.symbol, z.zoneHigh) },
      stopLoss: stop, tp1, tp2, runnerTarget,
      riskReward: rr,
      invalidationLevel: roundPx(o.symbol, long ? z.zoneLow - 0.25 * o.atr15 : z.zoneHigh + 0.25 * o.atr15),
      stopPips: priceToPips(o.symbol, risk), tp1Pips: priceToPips(o.symbol, reward),
    },
    reason: null,
  };
}
