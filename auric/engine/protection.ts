import type { AuricConfig } from "../config/defaults";
import type { Side } from "../core/types";
import { addTicks, cmpAtTick, roundToStep } from "../core/decimal";

/**
 * Stop buffer: max(2 × spread, 0.1 × M5 ATR, 1 tick). Evaluated, not asserted optimal.
 */
export function stopBuffer(spread: number, atrM5: number, tick: number, cfg: AuricConfig["protection"]): number {
  return Math.max(cfg.bufferSpreadMult * spread, cfg.bufferAtrMult * atrM5, tick);
}

/** Stop beyond the invalidation by the buffer, rounded away from the entry. */
export function stopFromInvalidation(side: Side, invalidation: number, buffer: number, tick: number): number {
  return side === "buy" ? roundToStep(invalidation - buffer, tick, "down") : roundToStep(invalidation + buffer, tick, "up");
}

/**
 * Target selection: seek $5–$10 of price movement from the entry, but never beyond obvious opposing
 * structure (minus a buffer). Returns null when the structure cannot support the minimum target.
 */
export function selectTarget(
  side: Side, entry: number, opposing: number | null, atrM5: number, tick: number, cfg: AuricConfig["setups"], buffer: number,
): { target: number; usd: number; reason: string } | null {
  // desired = clamp(1.2 × ATR-derived move, min, max)  — volatility-aware but bounded to the product's intent
  const desiredUsd = Math.min(cfg.targetMaxUsd, Math.max(cfg.targetMinUsd, 1.2 * atrM5));
  let target = side === "buy" ? entry + desiredUsd : entry - desiredUsd;
  let reason = `volatility-based ${desiredUsd.toFixed(2)} (1.2 × M5 ATR ${atrM5.toFixed(2)}, clamped ${cfg.targetMinUsd}–${cfg.targetMaxUsd})`;
  if (opposing != null) {
    const capped = side === "buy" ? opposing - buffer : opposing + buffer;
    const capIsCloser = side === "buy" ? capped < target : capped > target;
    if (capIsCloser) { target = capped; reason = `capped in front of opposing structure ${opposing.toFixed(2)} (buffer ${buffer.toFixed(2)})`; }
  }
  target = roundToStep(target, tick);
  const usd = Math.abs(target - entry);
  if (usd + 1e-9 < cfg.targetMinUsd) return null;
  return { target, usd, reason };
}

/** Broker-valid modification: only ever tightens, never through the market. */
export function tightenedStop(side: Side, current: number, proposed: number, bid: number, ask: number, tick: number, minDistance: number): number | null {
  if (side === "buy") {
    if (cmpAtTick(proposed, current, tick) <= 0) return null;                  // not tighter
    const maxAllowed = addTicks(bid, -Math.max(1, Math.round(minDistance / tick)), tick);
    return cmpAtTick(proposed, maxAllowed, tick) > 0 ? maxAllowed : proposed;
  }
  if (cmpAtTick(proposed, current, tick) >= 0) return null;
  const minAllowed = addTicks(ask, Math.max(1, Math.round(minDistance / tick)), tick);
  return cmpAtTick(proposed, minAllowed, tick) < 0 ? minAllowed : proposed;
}
