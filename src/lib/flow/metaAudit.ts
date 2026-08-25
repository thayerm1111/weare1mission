import { valuePerPricePerLot, contractKey } from "@/lib/flow/sizing";
import type { TLInstrument } from "@/lib/flow/tradelocker";

/**
 * METADATA AUDIT (diagnostics only — NEVER wired into live sizing).
 *
 * Compares the point-value CONSTANT FLOW uses for sizing against what the broker actually
 * reports for the instrument, and shows the risk-% impact if the broker value is the truth.
 * This exists so a sizing constant is only ever changed on EVIDENCE (per the Phase-2 rule),
 * never blindly from an unverified broker field.
 */

/** FLOW's ASSUMED value of a 1.0 price-unit ("point") move, per 1.0 lot, in USD. */
export function assumedPointValue(canonical: string, price = 0): number {
  return valuePerPricePerLot(contractKey(canonical), price);
}

/** The broker's REPORTED value of a 1.0 price-unit move per lot, derived from its metadata:
 *  tickValue / tickSize when both are present (most precise), else contractSize for a
 *  USD-quoted instrument. null when the broker doesn't report enough to derive it. */
export function brokerPointValue(inst: Pick<TLInstrument, "tickValue" | "tickSize" | "contractSize">): number | null {
  if (inst.tickValue != null && inst.tickSize != null && inst.tickSize > 0) return +(inst.tickValue / inst.tickSize);
  if (inst.contractSize != null && inst.contractSize > 0) return inst.contractSize;
  return null;
}

export type ImpactRow = { riskPct: number; intendedRisk: number; realizedRisk: number; ratio: number };

/**
 * If the broker's point value is the real one but FLOW sizes off the assumed one, the ACTUAL
 * dollar risk taken scales by (actual / assumed). Shows intended vs realized risk at each %.
 */
export function riskImpact(assumedPV: number, actualPV: number | null, equity: number, risks: number[] = [0.5, 1, 2, 5]): ImpactRow[] {
  const ratio = actualPV != null && assumedPV > 0 ? actualPV / assumedPV : 1;
  return risks.map((r) => {
    const intended = +((equity * r) / 100).toFixed(2);
    return { riskPct: r, intendedRisk: intended, realizedRisk: +(intended * ratio).toFixed(2), ratio: +ratio.toFixed(3) };
  });
}

/** A verdict on whether the assumed constant looks WRONG vs the broker (and by how much).
 *  'match' within 1%, 'diverges' otherwise, 'unknown' when the broker didn't report enough. */
export function pointValueVerdict(assumedPV: number, actualPV: number | null): { verdict: "match" | "diverges" | "unknown"; ratio: number | null } {
  if (actualPV == null || !(assumedPV > 0)) return { verdict: "unknown", ratio: null };
  const ratio = actualPV / assumedPV;
  return { verdict: Math.abs(ratio - 1) <= 0.01 ? "match" : "diverges", ratio: +ratio.toFixed(3) };
}
