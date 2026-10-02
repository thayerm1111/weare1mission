import { type FxPair } from "@/lib/genfx/pairs";

/**
 * GEN FX POSITION SIZING — how many lots risk the member's % on this stop.
 *
 * Its own function rather than the desk's sizeFromRisk, for one reason: GBP/JPY is a cross. A pip of
 * GBP/JPY is worth yen, and turning yen into dollars takes the USD/JPY rate — a number the pair's own
 * price does not contain. The shared sizing can only approximate that. Here the rate is a required
 * input and its absence is a refusal:
 *
 *     value of a 1.0 price move, per lot   EUR/USD  100,000 × 1            = $100,000
 *                                          GBP/JPY  100,000 ÷ USD/JPY      ≈ $667 at 150
 *     dollars one lot controls             EUR/USD  100,000 × EUR/USD      ≈ $108,000
 *                                          GBP/JPY  100,000 × GBP/JPY ÷ USD/JPY ≈ $133,000
 *
 * (Checked by hand in tests/genfx-sizing.test.ts: a 30-pip GBP/JPY stop at USD/JPY 150 is $200 a lot,
 * so $100 of risk is half a lot.)
 *
 * WHAT IT WILL NOT DO, each one a lesson already paid for on this desk:
 *   • size without a stop distance, an account size or — for a yen pair — a believable USD/JPY rate;
 *   • let one position control more than `maxLeverage` × the account (the August forex run put 30
 *     lots on a 4-pip stop: the risk % was "right" and the position was absurd);
 *   • place more than `maxLots` in one order, whatever the arithmetic says;
 *   • force the minimum lot onto an account it is too big for. Gold takes 0.01 on any account and
 *     separately keeps small accounts out of swing trades; here it is one rule for every horizon —
 *     if the smallest order a broker allows would lose more than `maxMinLotRiskPct` of the account
 *     at the stop, the account sits the trade out.
 *
 * The small-account caps are the desk's own (executor.placeOnActiveAccounts): under $2,000 the
 * effective risk is at most 2%, at $600 or less at most 0.5%.
 */

export const FX_LOT_UNITS = 100_000;

export type FxSizeLimits = { maxMinLotRiskPct: number; maxLots: number; maxLeverage: number };
export type FxSize = {
  ok: boolean;
  lots: number;
  /** The % of equity actually risked after the small-account caps. */
  riskPct: number;
  riskUsd: number;
  stopPips: number;
  /** Dollars per pip, per 1.0 lot. */
  pipValue: number;
  estLossAtStop: number;
  notionalUsd: number;
  /** What bounded the size, when something other than the risk % did. */
  bound: "risk" | "leverage" | "max_lots" | "min_lot";
  reason?: string;
};

/** A USD/JPY rate this code will believe. The pair has not traded outside 75–200 in fifty years. */
export const usdJpyOk = (r: number | null | undefined): r is number => typeof r === "number" && Number.isFinite(r) && r >= 60 && r <= 400;

/** Dollars per 1.0 of price movement, per 1.0 lot. Null when the conversion rate is missing. */
export function valuePerPrice(pair: FxPair, usdJpy?: number | null): number | null {
  if (pair.quote === "USD") return FX_LOT_UNITS;
  return usdJpyOk(usdJpy) ? FX_LOT_UNITS / usdJpy : null;
}

/** Dollars one lot controls at this price. Null when the conversion rate is missing. */
export function notionalPerLot(pair: FxPair, price: number, usdJpy?: number | null): number | null {
  if (!(price > 0)) return null;
  if (pair.quote === "USD") return FX_LOT_UNITS * price;
  return usdJpyOk(usdJpy) ? (FX_LOT_UNITS * price) / usdJpy : null;
}

/** The desk's small-account caps on risk %. Pure. */
export function cappedRiskPct(riskPct: number, equity: number): number {
  let r = riskPct;
  if (equity < 2000) r = Math.min(r, 2);
  if (equity <= 600) r = Math.min(r, 0.5);
  return r;
}

const fail = (reason: string, partial: Partial<FxSize> = {}): FxSize => ({
  ok: false, lots: 0, riskPct: 0, riskUsd: 0, stopPips: 0, pipValue: 0, estLossAtStop: 0, notionalUsd: 0, bound: "risk", ...partial, reason,
});

export function sizeFx(pair: FxPair, o: {
  entry: number; stop: number; equity: number; riskPct: number;
  usdJpy?: number | null;
  broker?: { quantityStep?: number | null; minQuantity?: number | null };
  limits: FxSizeLimits;
}): FxSize {
  const entry = Number(o.entry), stop = Number(o.stop), equity = Number(o.equity);
  const stopDist = Math.abs(entry - stop);
  if (!(entry > 0) || !(stop > 0) || !(stopDist > 0)) return fail("no_stop_distance");
  if (!(equity > 0)) return fail("no_equity");
  if (!(o.riskPct > 0)) return fail("no_risk_pct");
  const vpp = valuePerPrice(pair, o.usdJpy);
  const npl = notionalPerLot(pair, entry, o.usdJpy);
  if (vpp == null || npl == null) return fail("no_usdjpy_rate");

  const step = o.broker?.quantityStep && o.broker.quantityStep > 0 ? o.broker.quantityStep : 0.01;
  const min = o.broker?.minQuantity && o.broker.minQuantity > 0 ? o.broker.minQuantity : 0.01;
  const decimals = (String(step).split(".")[1] || "").length;
  const floorStep = (lots: number) => +(Math.floor(lots / step + 1e-9) * step).toFixed(decimals);

  const stopPips = Math.round((stopDist / pair.pip) * 10) / 10;
  const pipValue = +(vpp * pair.pip).toFixed(4);
  const lossPerLot = stopDist * vpp;
  const riskPct = cappedRiskPct(o.riskPct, equity);
  const riskUsd = equity * (riskPct / 100);
  const base = { riskPct, riskUsd: +riskUsd.toFixed(2), stopPips, pipValue };

  const byRisk = riskUsd / lossPerLot;
  const byLeverage = (equity * o.limits.maxLeverage) / npl;
  let bound: FxSize["bound"] = "risk";
  let raw = byRisk;
  if (byLeverage < raw) { raw = byLeverage; bound = "leverage"; }
  if (o.limits.maxLots < raw) { raw = o.limits.maxLots; bound = "max_lots"; }

  let lots = floorStep(raw);
  if (lots < min) {
    // The risk % (or the leverage limit) asks for less than the broker will place. The minimum is
    // taken only where it is still a small trade for this account.
    if (byLeverage < min) return fail("min_lot_over_leverage", { ...base, lots: min, notionalUsd: +(min * npl).toFixed(2) });
    const lossAtMin = min * lossPerLot;
    if (lossAtMin > equity * (o.limits.maxMinLotRiskPct / 100)) {
      return fail("min_lot_over_risk", { ...base, lots: min, estLossAtStop: +lossAtMin.toFixed(2), notionalUsd: +(min * npl).toFixed(2), bound: "min_lot" });
    }
    lots = min; bound = "min_lot";
  }
  return {
    ok: true, lots, ...base, bound,
    estLossAtStop: +(lots * lossPerLot).toFixed(2),
    notionalUsd: +(lots * npl).toFixed(2),
  };
}
