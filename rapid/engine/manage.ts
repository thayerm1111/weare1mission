import type { Bar, Pivot, Side } from "../core/types";
import { dirOf } from "../core/types";
import { bodyRatio } from "../market/bars";
import { cmpAtTick, roundOutward } from "../core/decimal";
import { protectedSwing } from "./structure";
import type { RapidConfig } from "../config/defaults";

/**
 * Management rules. Pure decisions; the caller does the broker work and confirms the outcome.
 *
 * Two invariants run through all of it:
 *   - Protection only ever TIGHTENS. Nothing here can widen a stop, move a target further away, or
 *     add to a losing position.
 *   - A request is not an outcome. Nothing is marked protected until the broker acknowledges it.
 */

export type ManagedTrade = {
  side: Side;
  /** Actual fill price. */
  entry: number;
  /** Original stop at fill. The breakeven trigger is measured against this distance. */
  initialStop: number;
  currentStop: number;
  target: number;
  /** Quantity at fill, before any partial. */
  originalQty: number;
  currentQty: number;
  /** ATR of the execution timeframe at the moment of the fill. */
  atrAtFill: number;
  /** Attributable round-trip costs, expressed in price units. */
  costPrice: number;
  breakevenDone: boolean;
  partialDone: boolean;
  managementVersion: string;
  /** Structural reference the change-of-character test runs against. */
  protectedSwing: number | null;
};

export const stopDistance = (t: ManagedTrade) => Math.abs(t.entry - t.initialStop);

/** Favourable movement so far, in price units. Negative when the trade is offside. */
export const favourableMove = (t: ManagedTrade, price: number) => dirOf(t.side) * (price - t.entry);

/** breakeven trigger = max(beMinUsd, beStopFraction x D_stop, beAtrMult x ATR_at_fill) */
export function breakevenTrigger(t: ManagedTrade, cfg: RapidConfig): number {
  const m = cfg.management;
  return Math.max(m.beMinUsd, m.beStopFraction * stopDistance(t), m.beAtrMult * t.atrAtFill);
}

/**
 * Net breakeven: entry plus the price-equivalent of the round-trip costs, so "breakeven" is actually
 * flat rather than flat-minus-fees. It is approximate, and a gap can still go through it.
 */
export function breakevenStop(t: ManagedTrade, tick: number): number {
  const d = dirOf(t.side);
  return roundOutward(t.entry + d * t.costPrice, tick, d === 1 ? 1 : -1);
}

export type ManageAction =
  | { kind: "none"; reason: string }
  | { kind: "breakeven"; stop: number; reason: string }
  | { kind: "partial"; qty: number; reason: string }
  | { kind: "trail"; stop: number; reason: string }
  | { kind: "exit"; reason: string };

/**
 * Decide the next management action. Order matters: the target winning is checked by the caller
 * before this is consulted, then protection, then profit-taking, then the structural exit.
 */
export function nextAction(
  t: ManagedTrade,
  price: number,
  bars: Bar[],
  pivots: Pivot[],
  asOf: number,
  tick: number,
  minStopDistance: number,
  bid: number,
  ask: number,
  cfg: RapidConfig,
): ManageAction {
  const d = dirOf(t.side);
  const moved = favourableMove(t, price);

  // 1. Breakeven.
  if (!t.breakevenDone) {
    const trigger = breakevenTrigger(t, cfg);
    if (moved >= trigger) {
      const proposed = breakevenStop(t, tick);
      const legal = tightenedStop(t.side, t.currentStop, proposed, bid, ask, tick, minStopDistance);
      if (legal != null) {
        return { kind: "breakeven", stop: legal, reason: `moved ${moved.toFixed(2)} >= trigger ${trigger.toFixed(2)}` };
      }
    }
  }

  // 2. Partial, once, and only when the final target is strictly beyond the partial level.
  if (!t.partialDone && Math.abs(t.target - t.entry) > cfg.management.partialAtUsd + 1e-9 && moved >= cfg.management.partialAtUsd) {
    const qty = t.originalQty * cfg.management.partialFraction;
    return { kind: "partial", qty, reason: `moved ${moved.toFixed(2)} >= ${cfg.management.partialAtUsd} with the target beyond it` };
  }

  // 3. Trail, only behind NEWER confirmed supporting structure.
  const swing = protectedSwing(bars, pivots, t.side, asOf);
  if (swing && t.partialDone) {
    const buffer = Math.max(cfg.protection.stopMinUsd, cfg.protection.stopAtrMult * t.atrAtFill, 2 * tick);
    const proposed = roundOutward(swing.price - d * buffer, tick, d === 1 ? -1 : 1);
    const legal = tightenedStop(t.side, t.currentStop, proposed, bid, ask, tick, minStopDistance);
    if (legal != null) return { kind: "trail", stop: legal, reason: `behind the confirmed swing at ${swing.price.toFixed(2)}` };
  }

  // 4. Change of character.
  const coc = changeOfCharacter(t, bars, pivots, asOf, cfg);
  if (coc.exit) return { kind: "exit", reason: coc.reason };

  return { kind: "none", reason: "holding" };
}

/**
 * A broker-valid tightening. Returns null when the proposal is not actually tighter, and clamps to
 * the broker's minimum distance rather than sending something that will be rejected.
 */
export function tightenedStop(
  side: Side,
  current: number,
  proposed: number,
  bid: number,
  ask: number,
  tick: number,
  minDistance: number,
): number | null {
  const ticks = Math.max(1, Math.round(minDistance / tick));
  if (side === "buy") {
    if (cmpAtTick(proposed, current, tick) <= 0) return null;
    const ceiling = bid - ticks * tick;
    return proposed > ceiling ? (ceiling > current ? ceiling : null) : proposed;
  }
  if (cmpAtTick(proposed, current, tick) >= 0) return null;
  const floor = ask + ticks * tick;
  return proposed < floor ? (floor < current ? floor : null) : proposed;
}

/**
 * Change of character.
 *
 * For a long: a COMPLETED candle closing below the protected higher low minus the break buffer, with
 * a bearish body of at least 55% of its range. A wick through the entry line, one red candle, or an
 * ordinary pullback that is still above the structural stop does NOT qualify — which is exactly the
 * case where a trade dipped under the entry and then ran.
 *
 * The exit executes at the next available quote, never retroactively at the candle close.
 */
export function changeOfCharacter(
  t: ManagedTrade,
  bars: Bar[],
  pivots: Pivot[],
  asOf: number,
  cfg: RapidConfig,
): { exit: boolean; reason: string } {
  const reference = t.protectedSwing ?? protectedSwing(bars, pivots, t.side, asOf)?.price ?? null;
  if (reference == null) return { exit: false, reason: "no protected structural reference yet" };

  const buffer = Math.max(cfg.protection.stopMinUsd, cfg.protection.stopAtrMult * t.atrAtFill);
  const last = bars[bars.length - 1];
  if (!last) return { exit: false, reason: "no completed candle" };

  const br = bodyRatio(last);
  if (br < cfg.management.cocMinBodyRatio) {
    return { exit: false, reason: `last candle body ${(br * 100).toFixed(0)}% below the ${(cfg.management.cocMinBodyRatio * 100).toFixed(0)}% requirement` };
  }
  if (t.side === "buy") {
    const bearish = last.c < last.o;
    if (bearish && last.c < reference - buffer) {
      return { exit: true, reason: `completed candle closed ${last.c.toFixed(2)} below the protected low ${reference.toFixed(2)} minus ${buffer.toFixed(2)}` };
    }
  } else {
    const bullish = last.c > last.o;
    if (bullish && last.c > reference + buffer) {
      return { exit: true, reason: `completed candle closed ${last.c.toFixed(2)} above the protected high ${reference.toFixed(2)} plus ${buffer.toFixed(2)}` };
    }
  }
  return { exit: false, reason: "structure intact" };
}
