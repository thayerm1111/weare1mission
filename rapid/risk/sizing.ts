import type { InstrumentSpec, Side } from "../core/types";
import { dirOf } from "../core/types";
import { roundDownToStep, roundOutward } from "../core/decimal";
import type { RapidConfig } from "../config/defaults";

/**
 * Broker-aware position sizing.
 *
 * Nothing here assumes XAUUSD is 100 ounces per lot, that 0.01 is a valid size, or that the account
 * is denominated in the instrument's profit currency. Every one of those is read from the account's
 * own instrument metadata, and a missing value BLOCKS the trade rather than being guessed.
 *
 * The entry and the stop both carry an adverse allowance before sizing, so slippage eats into the
 * position size rather than into the risk limit. Slippage and gaps can still exceed the model; that
 * is reported honestly after the fact, never hidden by widening the stop.
 */

export type SizingInput = {
  side: Side;
  /** Executable ask for a long, bid for a short. */
  executable: number;
  /** The structural stop, already buffered and rounded outward. */
  stop: number;
  equity: number;
  riskPct: number;
  spec: InstrumentSpec;
  /** Rate to multiply a profit-currency amount by to get account currency. 1 when they match. */
  conversionRate: number | null;
  /** Remaining allowance from the shared account risk ledger, in account currency. */
  remainingAccountRisk?: number | null;
  /** Remaining allowance under the strategy's own session loss ceiling, in account currency. */
  remainingSessionRisk?: number | null;
  cfg: RapidConfig;
};

export type SizingResult =
  | {
      ok: true;
      qty: number;
      /** Entry used for sizing, including the adverse allowance. */
      entryWorst: number;
      stopWorst: number;
      riskBudget: number;
      riskPerLot: number;
      estimatedRisk: number;
      valuePerPricePerLot: number;
      notes: string[];
    }
  | { ok: false; reason: string; blockers: string[] };

/**
 * Account-currency value of a 1.0 lot position per 1.0 of price movement.
 *
 * Preferred source is tickValue/tickSize because the broker states it directly. contractSize is the
 * fallback. If neither is available the trade is blocked — a guess here is a guess about how much
 * money is at stake.
 */
export function valuePerPricePerLot(spec: InstrumentSpec, conversionRate: number | null): { value: number; source: string } | null {
  const rate = conversionRate ?? 1;
  if (spec.tickValue != null && spec.tickSize != null && spec.tickSize > 0 && spec.tickValue > 0) {
    return { value: (spec.tickValue / spec.tickSize) * rate, source: `tickValue ${spec.tickValue} / tickSize ${spec.tickSize}` };
  }
  if (spec.contractSize != null && spec.contractSize > 0) {
    return { value: spec.contractSize * rate, source: `contractSize ${spec.contractSize}` };
  }
  return null;
}

export function sizePosition(inp: SizingInput): SizingResult {
  const blockers: string[] = [];
  const notes: string[] = [];
  const s = inp.spec;
  const cfg = inp.cfg;
  const d = dirOf(inp.side);

  const tick = s.tickSize;
  if (tick == null || !(tick > 0)) blockers.push("instrument tick size unavailable");
  const lotStep = s.lotStep;
  if (lotStep == null || !(lotStep > 0)) blockers.push("instrument lot step unavailable");
  const minLot = s.minLot;
  if (minLot == null || !(minLot > 0)) blockers.push("instrument minimum quantity unavailable");
  if (inp.conversionRate == null) blockers.push(`no conversion rate from ${s.currency ?? "the profit currency"} to the account currency`);
  if (!(inp.equity > 0)) blockers.push("account equity unavailable or zero");
  if (blockers.length) return { ok: false, reason: "instrument or account metadata incomplete", blockers };

  const vp = valuePerPricePerLot(s, inp.conversionRate);
  if (!vp) return { ok: false, reason: "cannot value the instrument", blockers: ["neither tickValue/tickSize nor contractSize is available"] };
  notes.push(`value per 1.00 of price per lot: ${vp.value.toFixed(2)} (${vp.source})`);

  // Clamp the user's choice to the operator ceiling; a higher request never bypasses the checks.
  const pct = Math.min(Math.max(inp.riskPct, 0), cfg.risk.maxPct);
  if (pct !== inp.riskPct) notes.push(`risk clamped from ${inp.riskPct}% to the ${cfg.risk.maxPct}% operator ceiling`);

  const candidates = [inp.equity * (pct / 100)];
  if (inp.remainingAccountRisk != null) candidates.push(inp.remainingAccountRisk);
  if (inp.remainingSessionRisk != null) candidates.push(inp.remainingSessionRisk);
  const riskBudget = Math.min(...candidates);
  if (!(riskBudget > 0)) {
    return { ok: false, reason: "no risk budget remaining", blockers: ["account or session risk allowance is exhausted"] };
  }

  // Adverse allowances: worse entry, worse exit. Both widen the modelled loss.
  const entryWorst = roundOutward(inp.executable + d * cfg.risk.entrySlippageTicks * tick!, tick!, d === 1 ? 1 : -1);
  const stopWorst = roundOutward(inp.stop - d * cfg.risk.exitSlippageTicks * tick!, tick!, d === 1 ? -1 : 1);
  const distance = Math.abs(entryWorst - stopWorst);
  if (!(distance > 0)) return { ok: false, reason: "stop distance is zero after allowances", blockers: ["entry and stop collapsed"] };

  const riskPerLot = distance * vp.value + cfg.risk.commissionPerLotRoundTrip * (inp.conversionRate ?? 1);
  if (!(riskPerLot > 0)) return { ok: false, reason: "risk per lot is not positive", blockers: ["instrument valuation produced zero"] };

  const raw = riskBudget / riskPerLot;
  const qty = roundDownToStep(raw, lotStep!);

  if (qty < minLot!) {
    return {
      ok: false,
      reason: "minimum quantity exceeds the risk budget",
      blockers: [`${minLot} lots would risk ${(minLot! * riskPerLot).toFixed(2)} against a ${riskBudget.toFixed(2)} budget`],
    };
  }
  const capped = s.maxLot != null && s.maxLot > 0 ? Math.min(qty, s.maxLot) : qty;
  if (capped !== qty) notes.push(`reduced to the ${s.maxLot} lot broker maximum`);

  return {
    ok: true,
    qty: capped,
    entryWorst,
    stopWorst,
    riskBudget,
    riskPerLot,
    estimatedRisk: capped * riskPerLot,
    valuePerPricePerLot: vp.value,
    notes,
  };
}

/** Estimated reward at the target, for the same quantity and valuation. */
export function estimateReward(qty: number, entry: number, target: number, valuePerPrice: number): number {
  return qty * Math.abs(target - entry) * valuePerPrice;
}

/**
 * Margin feasibility. Blocked rather than guessed when the broker does not report a requirement.
 */
export function marginOk(
  qty: number,
  price: number,
  spec: InstrumentSpec,
  freeMargin: number | null,
  marginRatePerLot: number | null,
): { ok: boolean; required: number | null; reason?: string } {
  if (marginRatePerLot == null || freeMargin == null) {
    return { ok: false, required: null, reason: "broker did not report a margin requirement or free margin" };
  }
  const required = qty * marginRatePerLot;
  void price;
  void spec;
  return required <= freeMargin ? { ok: true, required } : { ok: false, required, reason: `needs ${required.toFixed(2)} of a ${freeMargin.toFixed(2)} free margin` };
}

/**
 * After the fills are known, recompute exposure. More than `exposureTolerance` above what was
 * reserved must be reduced to a valid smaller quantity, or closed if no valid reduction exists.
 * Widening the stop to absorb it is never an option.
 */
export function reconcileExposure(
  filledQty: number,
  reservedQty: number,
  spec: InstrumentSpec,
  cfg: RapidConfig,
): { action: "ok" | "reduce" | "close"; reduceBy?: number; reason: string } {
  if (filledQty <= reservedQty * (1 + cfg.risk.exposureTolerance)) {
    return { action: "ok", reason: `filled ${filledQty} within tolerance of the reserved ${reservedQty}` };
  }
  const excess = filledQty - reservedQty;
  const step = spec.lotStep ?? 0;
  const minLot = spec.minLot ?? 0;
  const reduceBy = step > 0 ? roundDownToStep(excess, step) : 0;
  const remaining = filledQty - reduceBy;
  if (reduceBy >= minLot && remaining >= minLot) {
    return { action: "reduce", reduceBy, reason: `filled ${filledQty} exceeds the reserved ${reservedQty}` };
  }
  return { action: "close", reason: `filled ${filledQty} exceeds the reserved ${reservedQty} and no valid partial reduction exists` };
}
