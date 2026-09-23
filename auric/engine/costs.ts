import type { AuricConfig } from "../config/defaults";
import type { InstrumentSpec, Quote, Side } from "../core/types";

/**
 * Execution-cost model. The spread is paid ONCE, by entering at the ask (long) or bid (short) and
 * exiting on the opposite side — which is already how `entryPrice`, stop and target are expressed.
 * So the extra cost here is ONLY the slippage allowance and any commission, never a second spread.
 */
export type CostEstimate = { entryPrice: number; slippagePrice: number; commissionPrice: number; totalExtraPrice: number; spread: number };

export function estimateCosts(side: Side, q: Quote, spec: Pick<InstrumentSpec, "tickSize" | "contractSize">, cfg: AuricConfig["sizing"]): CostEstimate {
  const tick = spec.tickSize ?? 0.01;
  const spread = q.ask - q.bid;
  const entryPrice = side === "buy" ? q.ask : q.bid;
  const slippagePrice = cfg.slippageAllowanceTicks * tick;
  // commission per lot round trip → price-units per unit: commission / contractSize
  const commissionPrice = spec.contractSize && spec.contractSize > 0 ? cfg.commissionPerLotRoundTrip / spec.contractSize : 0;
  return { entryPrice, slippagePrice, commissionPrice, totalExtraPrice: slippagePrice + commissionPrice, spread };
}

/** Net reward-to-risk given planned stop/target and the extra (non-spread) costs. */
export function netRewardRisk(side: Side, entry: number, stop: number, target: number, extra: number): number {
  const risk = side === "buy" ? entry - stop : stop - entry;
  const reward = side === "buy" ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0)) return 0;
  return (reward - extra) / (risk + extra);
}
