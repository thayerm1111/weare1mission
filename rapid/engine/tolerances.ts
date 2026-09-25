import type { FrozenTolerances } from "../core/types";
import type { RapidConfig } from "../config/defaults";

/**
 * Tolerances are computed ONCE, at setup creation, from completed data, and then frozen for the life
 * of that setup. Recomputing them tick by tick would let a band quietly widen around wherever price
 * happens to be, which is how "near the line" turns into "anywhere".
 *
 * The live spread is deliberately NOT frozen into the execution decision: `spreadAtFreeze` is kept
 * for the audit trail only, and the real spread is rechecked immediately before submission.
 */
export function freezeTolerances(atrEntry: number, spread: number | null, tick: number, cfg: RapidConfig): FrozenTolerances {
  const twoTicks = 2 * tick;
  const e = cfg.entry;
  const p = cfg.protection;
  return {
    atrEntry,
    touchTolerance: Math.min(e.touchMaxUsd, Math.max(e.touchMinUsd, e.touchAtrMult * atrEntry, twoTicks)),
    breakBuffer: Math.max(e.breakMinUsd, e.breakAtrMult * atrEntry, twoTicks),
    stopBuffer: Math.max(p.stopMinUsd, p.stopSpreadMult * (spread ?? 0), p.stopAtrMult * atrEntry, twoTicks),
    rearmDistance: Math.max(e.rearmMinUsd, e.rearmAtrMult * atrEntry),
    spreadAtFreeze: spread,
  };
}

/**
 * If the spread has widened since the setup was frozen and a bigger protective buffer is therefore
 * required, the stop must MOVE OUT and the size must come down. It is never acceptable to keep the
 * quantity by shrinking the structural stop, so this returns the required buffer and the caller
 * either resizes or skips.
 */
export function requiredStopBuffer(atrEntry: number, liveSpread: number, tick: number, cfg: RapidConfig): number {
  const p = cfg.protection;
  return Math.max(p.stopMinUsd, p.stopSpreadMult * liveSpread, p.stopAtrMult * atrEntry, 2 * tick);
}
