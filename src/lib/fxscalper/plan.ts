import { legs, PAIRS, type PairKey } from "./pairs";
import { floorLots, notionalPerLot, pipValuePerLot, r2, snap, type Quote, type Rates } from "./money";
import type { Settings } from "./settings";

/**
 * THE ENTRY PLAN — from a signal and a fresh executable quote to an order, or to the reason there is
 * none. Pure. Every number on it is shown on the dashboard and kept on the trade row.
 *
 * TARGET (owner 10-23: "10 executable pips per trade"). A buy is closed when the executable BID reaches
 * 10 pips above the actual fill; a sell when the executable ASK reaches 10 pips below it. The broker's
 * take-profit is placed there (rounded AWAY from the fill to the tick, so it is never short of 10 pips)
 * and moved onto the real fill once the order fills. Measured on executable prices, so the spread is
 * already in it and is not deducted again; commission and other charges are separate. The optional
 * "after fees" mode widens the distance by the round-trip charges per lot, and is labelled as such.
 *
 * STOP = max(3 pips, 0.5 × the 1-minute ATR(14), 2 × the current spread), rounded out to the tick.
 * Wider than the pair's maximum (5 pips) → no trade. The maximum is never raised to fit a trade.
 *
 * COSTS. spread + round-trip commission + other charges + slippage allowance, all in pips, must be
 * within the pair's limit (1.5 pips). A screening rule, not a promise of profit.
 *
 * SIZE. The smallest of: the per-trade risk budget, the room under the open-risk cap, the per-trade lot
 * cap, the broker's maximum, the room under the gross-notional cap (every position on the account
 * counts, the owner's own included) and the room the margin reserve leaves — then rounded DOWN to the
 * lot step. Below the broker's minimum lot → no trade (the minimum is never forced onto a budget it
 * does not fit). The cash risked at the stop counts the slippage allowance and both sides' charges.
 */

export type InstrumentSpec = {
  pair: PairKey;
  brokerSymbol: string;
  tradableInstrumentId: string;
  tradeRouteId: string;
  infoRouteId: string;
  lotSize: number;
  lotStep: number;
  minLot: number;
  maxLot: number;
  tickSize: number;
  pipSize: number;
  decimals: number;
  barSource: "BID" | "ASK" | "TRADE";
  quote: string;
  base: string;
  leverage: number | null;
};

/** A bot trade that is in flight or open: what it can still lose, and which way it leans. */
export type OpenExposure = { pair: PairKey; side: "buy" | "sell"; riskCash: number };

export type AccountView = {
  currency: string;
  equity: number;
  /** Equity less excluded capital (promotional credit, payouts left in the account). */
  eligibleEquity: number;
  availableFunds: number | null;
  /** Gross notional of EVERY position on the account plus bot orders in flight, account currency. */
  grossNotional: number;
};

export type Plan = {
  side: "buy" | "sell";
  /** The executable price the plan was made from: the ask for a buy, the bid for a sell. */
  entryRef: number;
  stopPrice: number;
  targetPrice: number;
  stopPips: number;
  targetPips: number;
  lots: number;
  spreadPips: number;
  atrPips: number;
  stopParts: { min: number; atr: number; spread: number };
  costs: { spreadPips: number; commissionPips: number; otherPips: number; slippagePips: number; totalPips: number; maxPips: number };
  commissionRtPerLot: number;
  otherRtPerLot: number;
  pipValuePerLot: number;
  riskCash: number;
  estGrossAtTarget: number;
  estChargesCash: number;
  estNetAtTarget: number;
  marginEst: number;
  notional: number;
  bound: "risk" | "open_risk" | "lot_cap" | "broker_max" | "notional" | "margin";
  tpMode: Settings["strategy"]["tpMode"];
};

export type PlanResult = { ok: true; plan: Plan } | { ok: false; code: string; reason: string; detail?: Record<string, unknown> };

const no = (code: string, reason: string, detail?: Record<string, unknown>): PlanResult => ({ ok: false, code, reason, detail });

export function planEntry(inp: {
  side: "buy" | "sell";
  spec: InstrumentSpec;
  quote: Quote;
  /** The 1-minute ATR(14) in price units. */
  atr: number | null;
  settings: Settings;
  /** Slippage allowance in pips actually used (the configured one, raised if measured fills were worse). */
  slippagePips: number;
  account: AccountView;
  open: OpenExposure[];
  rates: Rates;
}): PlanResult {
  const { side, spec, quote, settings: s, account, open } = inp;
  const pair = spec.pair;
  const ps = s.pairs[pair];
  const pip = spec.pipSize;

  if (!(quote.bid > 0) || !(quote.ask > 0) || quote.ask < quote.bid) return no("bad_quote", "The quote is missing or crossed.", { bid: quote.bid, ask: quote.ask });
  if (s.costs.commissionPerLotPerSide == null) return no("costs_unset", "The account's commission per lot has not been entered.");
  if (!s.costs.confirmed) return no("costs_unconfirmed", "The account's costs have not been confirmed.");
  if (!(account.eligibleEquity > 0) || !(account.equity > 0)) return no("no_equity", "No eligible equity to size from.", { equity: account.equity, eligible: account.eligibleEquity });

  const pipValue = pipValuePerLot({ lotSize: spec.lotSize, pipSize: pip, quote: spec.quote, base: spec.base, leverage: spec.leverage }, account.currency, inp.rates);
  if (pipValue == null || !(pipValue > 0)) return no("no_rate", `No live rate to turn ${spec.quote} into ${account.currency}.`);

  // ---- Costs, in pips -----------------------------------------------------------------------------
  const spreadPips = (quote.ask - quote.bid) / pip;
  const commissionRtPerLot = s.costs.commissionPerLotPerSide * 2;
  const otherRtPerLot = s.costs.otherChargesPerLotRoundTrip;
  const commissionPips = commissionRtPerLot / pipValue;
  const otherPips = otherRtPerLot / pipValue;
  const slippagePips = Math.max(0, inp.slippagePips);
  const totalPips = spreadPips + commissionPips + otherPips + slippagePips;
  const costs = { spreadPips: r2(spreadPips), commissionPips: r2(commissionPips), otherPips: r2(otherPips), slippagePips: r2(slippagePips), totalPips: r2(totalPips), maxPips: ps.maxCostPips };
  if (totalPips > ps.maxCostPips + 1e-9) {
    return no("cost_over_limit", `Costs ${r2(totalPips)} pips (spread ${r2(spreadPips)} + commission ${r2(commissionPips)} + other ${r2(otherPips)} + slippage ${r2(slippagePips)}) are over the ${ps.maxCostPips}-pip limit.`, { costs });
  }

  // ---- Stop -----------------------------------------------------------------------------------------
  if (inp.atr == null || !(inp.atr >= 0)) return no("no_atr", "The one-minute ATR is not available.");
  const atrPips = inp.atr / pip;
  const stopParts = { min: s.strategy.stopMinPips, atr: s.strategy.stopAtrMult * atrPips, spread: s.strategy.stopSpreadMult * spreadPips };
  const rawStopPips = Math.max(stopParts.min, stopParts.atr, stopParts.spread);
  const stopTicks = Math.ceil((rawStopPips * pip) / spec.tickSize - 1e-9);
  const stopDist = stopTicks * spec.tickSize;
  const stopPips = stopDist / pip;
  if (stopPips > ps.maxStopPips + 1e-9) {
    return no("stop_over_max", `The stop would need ${r2(stopPips)} pips (minimum ${stopParts.min}, ATR ${r2(stopParts.atr)}, spread ${r2(stopParts.spread)}); this pair's maximum is ${ps.maxStopPips}.`, { stopParts, stopPips: r2(stopPips) });
  }
  const entryRef = side === "buy" ? quote.ask : quote.bid;
  const stopPrice = side === "buy" ? snap(entryRef - stopDist, spec.tickSize, "down") : snap(entryRef + stopDist, spec.tickSize, "up");

  // ---- Target ---------------------------------------------------------------------------------------
  const feePips = s.strategy.tpMode === "after_fees" ? commissionPips + otherPips : 0;
  const targetPips = s.strategy.tpPips + feePips;
  const targetPrice = side === "buy" ? snap(entryRef + targetPips * pip, spec.tickSize, "up") : snap(entryRef - targetPips * pip, spec.tickSize, "down");

  // ---- Positions and exposure -------------------------------------------------------------------------
  if (open.length >= s.risk.maxConcurrent) return no("max_concurrent", `Already ${open.length} bot trades in flight or open (maximum ${s.risk.maxConcurrent}).`);
  if (open.some((o) => o.pair === pair)) return no("pair_busy", "This pair already has a bot trade in flight or open.");
  for (const leg of legs(pair, side)) {
    const n = open.filter((o) => legs(o.pair, o.side).some((l) => l.ccy === leg.ccy && l.dir === leg.dir)).length;
    if (n >= s.risk.maxSameCurrencyDirection) {
      return no("currency_exposure", `Already ${n} bot positions ${leg.dir} ${leg.ccy} (maximum ${s.risk.maxSameCurrencyDirection}).`, { ccy: leg.ccy, dir: leg.dir });
    }
  }

  // ---- Size -----------------------------------------------------------------------------------------
  const lossPerLot = (stopPips + slippagePips) * pipValue + commissionRtPerLot + otherRtPerLot;
  const eq = account.eligibleEquity;
  const openRisk = open.reduce((a, o) => a + Math.max(0, o.riskCash), 0);
  const npl = notionalPerLot({ lotSize: spec.lotSize, pipSize: pip, quote: spec.quote, base: spec.base, leverage: spec.leverage }, entryRef, account.currency, inp.rates);
  if (npl == null || !(npl > 0)) return no("no_rate", `No live rate to value ${pair} in ${account.currency}.`);
  if (spec.leverage == null || !(spec.leverage > 0)) return no("no_leverage", "The contract details give no leverage, so the margin cannot be estimated.");
  const marginPerLot = npl / spec.leverage;

  const caps: Array<{ bound: Plan["bound"]; lots: number }> = [
    { bound: "risk", lots: ((s.risk.riskPerTradePct / 100) * eq) / lossPerLot },
    { bound: "open_risk", lots: ((s.risk.maxOpenRiskPct / 100) * eq - openRisk) / lossPerLot },
    { bound: "lot_cap", lots: s.risk.maxLotsPerTrade },
    { bound: "broker_max", lots: spec.maxLot },
    { bound: "notional", lots: (s.risk.maxGrossNotionalX * eq - account.grossNotional) / npl },
  ];
  if (account.availableFunds != null) {
    caps.push({ bound: "margin", lots: (account.availableFunds - (s.risk.marginReservePct / 100) * account.equity) / marginPerLot });
  } else {
    return no("no_margin_data", "The account's available funds could not be read, so the margin reserve cannot be checked.");
  }
  const binding = caps.reduce((a, c) => (c.lots < a.lots ? c : a));
  const lots = floorLots(Math.max(0, binding.lots), spec.lotStep);
  if (!(lots >= spec.minLot - 1e-12)) {
    const what: Record<Plan["bound"], string> = {
      risk: `the ${s.risk.riskPerTradePct}% risk budget`,
      open_risk: `the room left under the ${s.risk.maxOpenRiskPct}% open-risk cap`,
      lot_cap: "the per-trade lot cap",
      broker_max: "the broker's maximum",
      notional: `the room left under the ${s.risk.maxGrossNotionalX}× gross-notional cap`,
      margin: `the margin left after the ${s.risk.marginReservePct}% reserve`,
    };
    return no("below_min_lot", `The broker's minimum of ${spec.minLot} lots does not fit ${what[binding.bound]} (${Math.max(0, binding.lots).toFixed(4)} lots).`, { bound: binding.bound, lots: binding.lots, lossPerLot: r2(lossPerLot) });
  }

  const plan: Plan = {
    side, entryRef, stopPrice, targetPrice,
    stopPips: r2(stopPips), targetPips: r2(targetPips), lots,
    spreadPips: r2(spreadPips), atrPips: r2(atrPips),
    stopParts: { min: stopParts.min, atr: r2(stopParts.atr), spread: r2(stopParts.spread) },
    costs, commissionRtPerLot, otherRtPerLot, pipValuePerLot: pipValue,
    riskCash: lots * lossPerLot,
    estGrossAtTarget: lots * targetPips * pipValue,
    estChargesCash: lots * (commissionRtPerLot + otherRtPerLot),
    estNetAtTarget: lots * targetPips * pipValue - lots * (commissionRtPerLot + otherRtPerLot),
    marginEst: lots * marginPerLot,
    notional: lots * npl,
    bound: binding.bound,
    tpMode: s.strategy.tpMode,
  };
  return { ok: true, plan };
}

/**
 * Where the stop and target go once the order has FILLED. The target is re-centred on the real fill
 * (it may move either way — a target is not risk). The stop may only TIGHTEN: if the fill was worse
 * than planned, it comes up to the planned distance from the fill; if the fill was better, the attached
 * stop stays where it is rather than being widened to keep the planned distance.
 */
export function protectionAfterFill(inp: {
  side: "buy" | "sell";
  fill: number;
  attachedStop: number;
  plannedStopPips: number;
  targetPips: number;
  pipSize: number;
  tickSize: number;
}): { stop: number; target: number; stopMoved: boolean } {
  const { side, fill, attachedStop, pipSize, tickSize } = inp;
  const dist = inp.plannedStopPips * pipSize;
  const target = side === "buy" ? snap(fill + inp.targetPips * pipSize, tickSize, "up") : snap(fill - inp.targetPips * pipSize, tickSize, "down");
  if (side === "buy") {
    const desired = snap(fill - dist, tickSize, "down");
    const stop = desired > attachedStop ? desired : attachedStop;
    return { stop, target, stopMoved: stop !== attachedStop };
  }
  const desired = snap(fill + dist, tickSize, "up");
  const stop = desired < attachedStop ? desired : attachedStop;
  return { stop, target, stopMoved: stop !== attachedStop };
}

/** The price a buy is judged by (the bid) and a sell (the ask), and the pair's pip as a number. */
export const exitSide = (side: "buy" | "sell", q: Quote) => (side === "buy" ? q.bid : q.ask);
export const pipOf = (pair: PairKey) => PAIRS[pair].pip;
