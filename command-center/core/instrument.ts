/**
 * INSTRUMENT SPECIFICATION — what a lot is actually worth, according to the broker.
 *
 * The rule here is the one that matters most in this whole file tree: THE PIP IS NOT HARDCODED. Gold is
 * quoted differently by different brokers — two decimals or three, 100-ounce contracts or 10 — and a desk
 * that assumes "$10 a pip" sizes every position wrong the day it meets a broker that disagrees.
 *
 * So this derives everything from the instrument the broker described, and when the broker did not
 * describe enough of it, `resolve` REFUSES. "I cannot size this" is a correct answer. A guess is not.
 */
import type { TLInstrumentSpec } from "../adapters/tradelocker";
import type { Instrument } from "./risk";

export type Resolved =
  | { ok: true; instrument: Instrument; pipSize: number; source: string; warnings: string[] }
  | { ok: false; reason: string; missing: string[] };

/**
 * The price move the product calls "one pip", derived from the broker's own quoting.
 *
 * A tick is the smallest price increment the broker accepts. A pip, by market convention for a
 * two-decimal metal, is ten of them. Both come from the spec; neither is assumed.
 */
export function pipSizeOf(spec: TLInstrumentSpec): { pipSize: number; source: string } | null {
  if (spec.tickSize != null && spec.tickSize > 0) {
    return { pipSize: +(spec.tickSize * 10).toPrecision(12), source: `tickSize ${spec.tickSize}` };
  }
  if (spec.pricePrecision != null && spec.pricePrecision >= 1) {
    return { pipSize: +Math.pow(10, -(spec.pricePrecision - 1)).toPrecision(12), source: `pricePrecision ${spec.pricePrecision}` };
  }
  return null;
}

/**
 * Turn the broker's instrument description into the numbers the risk engine needs.
 *
 * Two independent routes to pip value, preferred in this order:
 *   • tickValue — the broker stating, in account currency, what one tick is worth. Most trustworthy.
 *   • contractSize × pipSize — the arithmetic, valid when the instrument is quoted in the account currency.
 * If neither is available it refuses and names exactly what was missing, so the UI can say so.
 */
export function resolve(spec: TLInstrumentSpec, accountCurrency?: string | null): Resolved {
  const missing: string[] = [];
  const warnings: string[] = [];

  const pip = pipSizeOf(spec);
  if (!pip) missing.push("tick size or price precision");

  const lotStep = spec.lotStep ?? null;
  const minLot = spec.minLot ?? null;
  if (lotStep == null) missing.push("lot step");
  if (minLot == null) missing.push("minimum lot");

  let pipValuePerLot: number | null = null;
  let source = "";

  if (pip && spec.tickValue != null && spec.tickValue > 0 && spec.tickSize != null && spec.tickSize > 0) {
    pipValuePerLot = +(spec.tickValue * (pip.pipSize / spec.tickSize)).toPrecision(10);
    source = `tickValue ${spec.tickValue} per ${spec.tickSize}`;
  } else if (pip && spec.contractSize != null && spec.contractSize > 0) {
    pipValuePerLot = +(spec.contractSize * pip.pipSize).toPrecision(10);
    source = `contractSize ${spec.contractSize} × pip ${pip.pipSize}`;
    // The arithmetic is only true in the account's own currency. Say so rather than silently assuming it.
    if (accountCurrency && spec.currency && spec.currency.toUpperCase() !== accountCurrency.toUpperCase()) {
      warnings.push(`${spec.name || "This instrument"} is quoted in ${spec.currency} but the account is in ${accountCurrency} — the value per pip is approximate until the broker states a tick value.`);
    }
  } else {
    missing.push("tick value or contract size");
  }

  if (missing.length || !pip || pipValuePerLot == null || lotStep == null || minLot == null) {
    return {
      ok: false,
      reason: `The broker did not describe this instrument fully enough to size a position: missing ${missing.join(", ")}.`,
      missing,
    };
  }

  return {
    ok: true,
    pipSize: pip.pipSize,
    source: `${source}; pip from ${pip.source}`,
    warnings,
    instrument: {
      contractSize: spec.contractSize ?? 0,
      minLot,
      maxLot: spec.maxLot ?? 100,
      lotStep,
      pipValuePerLot,
    },
  };
}

/** Price distance → pips, in THIS instrument's terms. */
export const toPips = (priceDistance: number, pipSize: number): number => priceDistance / pipSize;
/** Pips → price distance, in THIS instrument's terms. */
export const toPrice = (pips: number, pipSize: number): number => pips * pipSize;

/** Round a price to what the broker will accept, so a modify is never rejected for precision alone. */
export function roundPrice(price: number, spec: { tickSize: number | null; pricePrecision: number | null }): number {
  if (spec.tickSize != null && spec.tickSize > 0) return +(Math.round(price / spec.tickSize) * spec.tickSize).toFixed(8);
  if (spec.pricePrecision != null && spec.pricePrecision >= 0) return +price.toFixed(spec.pricePrecision);
  return +price.toFixed(2);
}

/** Round a quantity DOWN to a legal lot. Rounding up would quietly increase risk. */
export function roundQty(qty: number, inst: Instrument): number {
  const stepped = Math.floor(qty / inst.lotStep + 1e-9) * inst.lotStep;
  const dp = Math.max(0, Math.min(8, Math.ceil(-Math.log10(inst.lotStep)) + 1));
  return +stepped.toFixed(dp);
}
