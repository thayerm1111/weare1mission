import type { BrokerPosition } from "../rapid/exec/port";
import type { Side } from "../rapid/core/types";
import { verifiedOwnedPosition } from "../src/lib/nitrous/policy";

type PositionLimits = {
  broker_position_id: string;
  broker_strategy_id: string;
  side: Side;
  original_qty: number;
  initial_stop: number;
};

export type OngoingHazard = "oversize" | "missing_stop" | "weaker_stop";

/** An actionable breach on an already protected position. Unknown broker data cannot confirm a breach. */
export function ongoingHazard(position: PositionLimits, live: BrokerPosition | undefined, tick: number): OngoingHazard | null {
  if (!live || !verifiedOwnedPosition(position, live) || live.side !== position.side) return null;
  const originalQty = Number(position.original_qty);
  if (!Number.isFinite(originalQty) || originalQty <= 0 || live.qty === null || !Number.isFinite(live.qty) || live.qty <= 0) return null;
  if (live.qty > originalQty + 1e-8) return "oversize";
  if (live.stopReadUnknown) return null;
  if (live.stopLoss === null || live.stopLoss === 0) return "missing_stop";
  const floor = Number(position.initial_stop);
  if (!Number.isFinite(floor) || floor <= 0 || !Number.isFinite(tick) || tick <= 0 ||
      !Number.isFinite(live.stopLoss) || live.stopLoss < 0) return null;
  const distance = position.side === "buy" ? floor - live.stopLoss : live.stopLoss - floor;
  return distance > tick + tick * 1e-8 ? "weaker_stop" : null;
}
