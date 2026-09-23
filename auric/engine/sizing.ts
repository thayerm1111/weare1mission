import type { AuricConfig } from "../config/defaults";
import type { InstrumentSpec, Side } from "../core/types";
import { roundDownToStep, ticksBetween } from "../core/decimal";

export type SizingInput = {
  side: Side; entry: number; stop: number; equity: number; riskFraction: number; spec: InstrumentSpec; cfg: AuricConfig["sizing"];
  /** Account currency; sizing refuses when it differs from the instrument's profit currency and no conversion is supplied. */
  accountCurrency: string | null; fxToAccount?: number | null;
};
export type SizingResult =
  | { ok: true; qty: number; riskBudget: number; lossPerLot: number; estLoss: number; explanation: string; usedTickValue: boolean }
  | { ok: false; code: string; explanation: string; riskBudget?: number; minLossAtMinQty?: number };

/**
 * risk_budget   = equity × riskFraction
 * loss_per_lot  = (|entry − stop| + slippage) × value_per_price_unit_per_lot + commission_round_trip
 * qty           = round_down_to_step(risk_budget / loss_per_lot)
 * If qty < minLot → SKIP (never force the minimum, never tighten the stop to fit).
 */
export function sizePosition(i: SizingInput): SizingResult {
  const { spec, cfg } = i;
  const tick = spec.tickSize;
  if (!tick || !(tick > 0)) return { ok: false, code: "NO_TICK_SIZE", explanation: "broker did not report a tick size" };
  if (!spec.lotStep || !(spec.lotStep > 0)) return { ok: false, code: "NO_LOT_STEP", explanation: "broker did not report a quantity increment" };
  if (spec.minLot == null) return { ok: false, code: "NO_MIN_LOT", explanation: "broker did not report a minimum quantity" };
  if (!(i.equity > 0)) return { ok: false, code: "NO_EQUITY", explanation: "account equity unavailable or zero" };
  const frac = Math.min(cfg.riskFractionMax, Math.max(cfg.riskFractionMin, i.riskFraction));
  const riskBudget = i.equity * frac;
  // Value of one price unit per lot: prefer tickValue/tickSize (broker's own), else contractSize.
  let perUnitPerLot: number | null = null; let usedTickValue = false;
  if (spec.tickValue != null && spec.tickValue > 0) { perUnitPerLot = spec.tickValue / tick; usedTickValue = true; }
  else if (spec.contractSize != null && spec.contractSize > 0) perUnitPerLot = spec.contractSize;
  if (perUnitPerLot == null) return { ok: false, code: "NO_CONTRACT_SPEC", explanation: "neither tick value nor contract size was reported — cannot value a price move" };
  if (i.accountCurrency && spec.currency && i.accountCurrency !== spec.currency) {
    if (!(i.fxToAccount && i.fxToAccount > 0)) return { ok: false, code: "CURRENCY_MISMATCH", explanation: `instrument profit currency ${spec.currency} ≠ account currency ${i.accountCurrency} and no verified conversion is available` };
    perUnitPerLot *= i.fxToAccount;
  }
  const stopTicks = ticksBetween(i.entry, i.stop, tick);
  if (stopTicks <= 0) return { ok: false, code: "ZERO_STOP", explanation: "stop equals entry" };
  const adverse = (stopTicks + cfg.slippageAllowanceTicks) * tick;
  const lossPerLot = adverse * perUnitPerLot + cfg.commissionPerLotRoundTrip;
  const rawQty = riskBudget / lossPerLot;
  let qty = roundDownToStep(rawQty, spec.lotStep);
  if (spec.maxLot != null && qty > spec.maxLot) qty = roundDownToStep(spec.maxLot, spec.lotStep);
  if (qty < spec.minLot) {
    const minLoss = spec.minLot * lossPerLot;
    return { ok: false, code: "MIN_QTY_EXCEEDS_RISK", riskBudget, minLossAtMinQty: minLoss,
      explanation: `Minimum broker size ${spec.minLot} would risk $${minLoss.toFixed(2)}; your selected budget is $${riskBudget.toFixed(2)} (${(frac * 100).toFixed(2)}% of $${i.equity.toFixed(2)}).` };
  }
  const estLoss = qty * lossPerLot;
  return { ok: true, qty, riskBudget, lossPerLot, estLoss, usedTickValue,
    explanation: `risk budget $${riskBudget.toFixed(2)} ÷ loss/lot $${lossPerLot.toFixed(2)} (stop ${stopTicks} ticks + ${cfg.slippageAllowanceTicks} slippage ticks × $${perUnitPerLot.toFixed(2)}/unit/lot${cfg.commissionPerLotRoundTrip ? ` + $${cfg.commissionPerLotRoundTrip} commission` : ""}) = ${rawQty.toFixed(4)} → ${qty} (step ${spec.lotStep}); estimated loss $${estLoss.toFixed(2)}` };
}
