import type { Side, Zone } from "../core/types";
import { dirOf } from "../core/types";
import { roundToStep } from "../core/decimal";
import { nearestObstacle } from "./zones";
import type { RapidConfig } from "../config/defaults";

/**
 * Targets.
 *
 * Rapid is looking for $5-$15 of movement in the QUOTED PRICE of gold. That is a distance, not a
 * profit: what it is worth in the account depends entirely on the position size.
 *
 * The target never reaches through nearer meaningful opposition to make the numbers look better. If
 * the structure only pays $7, the trade is a $7 trade and the full exit is at $7 — there is no $10
 * partial to promise.
 */

export type TargetPlan = {
  target: number;
  distance: number;
  buffer: number;
  obstacle: { zoneId: string; price: number } | null;
  /** Progress markers that actually fit inside this target. */
  markers: number[];
  reason: string;
};

export function planTarget(
  side: Side,
  entry: number,
  obstacles: Zone[],
  excludeParentIds: string[],
  spread: number,
  tick: number,
  cfg: RapidConfig,
): { plan: TargetPlan | null; reason: string } {
  const d = dirOf(side);
  const buffer = Math.max(cfg.target.bufferMinUsd, spread, 2 * tick);
  const found = nearestObstacle(obstacles, entry, d, excludeParentIds);

  // With no known opposing obstacle the target is the product maximum, not infinity.
  const structuralRoom = found ? d * (found.price - entry) - buffer : cfg.target.maxUsd;
  const distance = Math.min(cfg.target.maxUsd, structuralRoom);

  if (!(distance >= cfg.target.minUsd)) {
    return {
      plan: null,
      reason: found
        ? `only ${Math.max(0, structuralRoom).toFixed(2)} of room before ${found.zone.id} at ${found.price.toFixed(2)} (need ${cfg.target.minUsd})`
        : `no room for the ${cfg.target.minUsd} minimum target`,
    };
  }

  const target = roundToStep(entry + d * distance, tick, d === 1 ? "down" : "up");
  const actual = Math.abs(target - entry);
  const markers = cfg.target.markersUsd.filter((m) => m < actual - 1e-9);

  return {
    plan: {
      target,
      distance: actual,
      buffer,
      obstacle: found ? { zoneId: found.zone.id, price: found.price } : null,
      markers,
      reason: found
        ? `capped short of ${found.zone.id} at ${found.price.toFixed(2)} with a ${buffer.toFixed(2)} buffer`
        : `no opposing structure within ${cfg.target.maxUsd}; using the product maximum`,
    },
    reason: "ok",
  };
}

export type CostModel = {
  /** Slippage allowance on entry, in price units. */
  entrySlippage: number;
  /** Slippage allowance on exit, in price units. */
  exitSlippage: number;
  /** Commission expressed in price units per unit of the underlying. */
  commissionPrice: number;
  spread: number;
};

export function buildCostModel(spread: number, tick: number, contractSize: number | null, cfg: RapidConfig): CostModel {
  return {
    entrySlippage: cfg.risk.entrySlippageTicks * tick,
    exitSlippage: cfg.risk.exitSlippageTicks * tick,
    commissionPrice: contractSize && contractSize > 0 ? cfg.risk.commissionPerLotRoundTrip / contractSize : 0,
    spread,
  };
}

/**
 * Net reward / risk.
 *
 * The spread is paid ONCE and is already inside the prices: a long enters at the ask and exits at the
 * bid, which is how `entry`, `stop` and `target` are expressed. Subtracting it again here would
 * double-charge the trade. What is added is the slippage allowance and commission.
 */
export function netRewardRisk(side: Side, entry: number, stop: number, target: number, costs: CostModel): number {
  const d = dirOf(side);
  const risk = d * (entry - stop);
  const reward = d * (target - entry);
  if (!(risk > 0) || !(reward > 0)) return 0;
  const extra = costs.entrySlippage + costs.exitSlippage + costs.commissionPrice;
  return (reward - extra) / (risk + extra);
}

/** Modelled costs as a fraction of the target distance. */
export function costRatio(targetDistance: number, costs: CostModel): number {
  if (!(targetDistance > 0)) return Infinity;
  return (costs.spread + costs.entrySlippage + costs.exitSlippage + costs.commissionPrice) / targetDistance;
}
