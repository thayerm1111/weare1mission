import { valuePerPricePerLot, contractKey, minStopDistance } from "@/lib/flow/sizing";
import { FOREX_PIP, FOREX_MAX_LOTS, FOREX_MAX_RISK_PCT, FOREX_MIN_STOP_PIPS } from "@/lib/forex/forexConfig";

/**
 * FOREX RISK MODEL — percent-of-equity sizing with HARD CAPS. Pure + unit-tested.
 *
 * This is the piece that failed on the mixed engine: percent-risk on a tight stop produced
 * absurd lot counts (27 lots of AUDUSD). Here the size is bounded three ways:
 *   1. the risk % itself is clamped to FOREX_MAX_RISK_PCT,
 *   2. the stop distance used for sizing is floored to a sane minimum (so a noise-tight stop
 *      can't divide the risk into a huge position), and
 *   3. the resulting lots are hard-capped at FOREX_MAX_LOTS.
 * Whichever binds first wins, and `capped` names it.
 */
export function sizeForex(o: {
  pair: string; equity: number; riskPct: number; entry: number; stop: number;
}): { lots: number; stopPips: number; riskUsd: number; capped: string | null } {
  const pair = contractKey(o.pair);
  const pip = FOREX_PIP[pair] ?? 0.0001;
  const stopDist = Math.abs(o.entry - o.stop);
  const stopPips = +(stopDist / pip).toFixed(1);

  // 1) clamp the risk %.
  const riskPct = Math.min(Math.max(o.riskPct, 0), FOREX_MAX_RISK_PCT);
  const riskUsd = o.equity > 0 ? +((o.equity * riskPct) / 100).toFixed(2) : 0;

  // 2) size off AT LEAST the minimum sane stop distance, so a tight stop can't balloon size
  //    even if a caller skipped the entry gate.
  const minDist = minStopDistance(pair) || pip * FOREX_MIN_STOP_PIPS;
  const effStopDist = Math.max(stopDist, minDist);
  const valPerPrice = valuePerPricePerLot(pair, o.entry); // $ per 1.0 price move, per 1.0 lot
  const perLotRisk = effStopDist * valPerPrice;           // $ risked per 1.0 lot at this stop

  let lots = perLotRisk > 0 && riskUsd > 0 ? riskUsd / perLotRisk : 0;
  let capped: string | null = null;

  // 3) hard lot ceiling — the "no monster position" backstop.
  if (lots > FOREX_MAX_LOTS) { lots = FOREX_MAX_LOTS; capped = "max_lots"; }

  lots = Math.floor(lots * 100) / 100; // broker lot step 0.01, round DOWN (never over-risk)
  if (lots < 0.01 && riskUsd > 0 && perLotRisk > 0) { lots = 0.01; capped = capped ?? "min_lot"; }

  return { lots, stopPips, riskUsd, capped };
}
