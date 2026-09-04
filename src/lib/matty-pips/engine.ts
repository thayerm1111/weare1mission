/**
 * MATTY PIPS — the ONE deterministic engine. Both modes (FIND ME A TRADE and,
 * later, AUTO TRADE) call exactly this function; there is no second brain.
 * Top-down: Daily → 4H → 1H structure, zones, location, 15M confirmation.
 * "NO TRADE RIGHT NOW" is a successful, first-class output.
 */
import type { ConfirmationFlag, DecisionObject, EngineResult, Mode, SetupStatus, SetupType, Zone } from "./types";
import { ENGINE_VERSION } from "./types";
import { fetchMarket } from "./data";
import { atr, readStructure } from "./structure";
import { buildZones, nearestZone } from "./zones";
import { locate, rangePosition } from "./location";
import { confirmations as confirm15 } from "./confirm15m";
import { breakoutRead } from "./breakout";
import { buildTrade, MIN_RR_DEFAULT } from "./targets";
import { scoreDecision } from "./score";
import { getInstrument, priceToPips } from "./pips";
import { whyThisTrade, watchLine } from "./narrate";

export const MIN_SCORE: Record<Mode, number> = { conservative: 80, aggressive: 67 };
export const MIN_CONFIRMS: Record<Mode, number> = { conservative: 2, aggressive: 1 };

export async function runEngine(o: {
  symbol: string;               // canonical, e.g. XAUUSD
  mode?: Mode;
  mdKey: string;
  fresh?: boolean;
  minRR?: number;
}): Promise<EngineResult> {
  const mode: Mode = o.mode === "aggressive" ? "aggressive" : "conservative";
  const meta = getInstrument(o.symbol);
  const mkt = await fetchMarket(o.symbol, o.mdKey, o.fresh === true);
  if (!mkt.ok) return { ok: false, error: mkt.error, detail: mkt.detail };

  // 1) Structure, top-down.
  const daily = readStructure("D", mkt.d);
  const h4 = readStructure("H4", mkt.h4);
  const h1 = readStructure("H1", mkt.h1);
  const atr15 = atr(mkt.m15);
  const price = mkt.price;

  // 2) Zones + location.
  const zones = buildZones({ d: mkt.d, h4: mkt.h4, h1: mkt.h1, price });
  const nSup = nearestZone(zones, price, "support");
  const nRes = nearestZone(zones, price, "resistance");
  const rangePos = rangePosition(price, daily.recentLow, daily.recentHigh);
  const location = locate({ price, nearestSupport: nSup, nearestResistance: nRes, atr1h: h1.atr, m15: mkt.m15, atr15, rangePos });

  // 3) Candidate setup from location + Daily context. Only three setups exist.
  let setupType: SetupType | null = null;
  let direction: "buy" | "sell" | null = null;
  let zone: Zone | null = null;
  let confirms: ConfirmationFlag[] = [];
  let breakout: { phase: DecisionObject["breakoutPhase"]; detail: string } = { phase: "NONE", detail: "" };

  const atSupport = location === "AT_SUPPORT" || location === "NEAR_SUPPORT";
  const atResistance = location === "AT_RESISTANCE" || location === "NEAR_RESISTANCE";
  const breakingUp = location === "BREAKING_RESISTANCE" || location === "ABOVE_RESISTANCE";
  const breakingDown = location === "BREAKING_SUPPORT" || location === "BELOW_SUPPORT";

  if (atSupport && nSup && daily.marketState !== "DOWNTREND") {
    setupType = "BUY_SUPPORT"; direction = "buy"; zone = nSup;
    confirms = confirm15({ side: "buy", zone: nSup, m15: mkt.m15, atr15 });
  } else if (atResistance && nRes && daily.marketState !== "UPTREND") {
    setupType = "SELL_RESISTANCE"; direction = "sell"; zone = nRes;
    confirms = confirm15({ side: "sell", zone: nRes, m15: mkt.m15, atr15 });
  } else if (breakingUp && nSup && daily.marketState !== "DOWNTREND") {
    // The broken resistance now sits just under price (typed support by position).
    setupType = "BREAKOUT_RUNNER"; direction = "buy"; zone = nSup;
    breakout = breakoutRead({ zone: nSup, direction: "up", price, m15: mkt.m15, atr15, atr1h: h1.atr });
    confirms = confirm15({ side: "buy", zone: nSup, m15: mkt.m15, atr15 });
  } else if (breakingDown && nRes && daily.marketState !== "UPTREND") {
    setupType = "BREAKOUT_RUNNER"; direction = "sell"; zone = nRes;
    breakout = breakoutRead({ zone: nRes, direction: "down", price, m15: mkt.m15, atr15, atr1h: h1.atr });
    confirms = confirm15({ side: "sell", zone: nRes, m15: mkt.m15, atr15 });
  }

  // 4) Mode gates (structure agreement + confirmation count + breakout phase).
  const against = direction === "buy" ? "DOWNTREND" : "UPTREND";
  let gateOk = false, gateReason = "";
  if (setupType && direction) {
    if (mode === "conservative") {
      const structOk = daily.marketState !== against && h4.marketState !== against &&
        (daily.marketState !== "LEFT_TO_RIGHT" || h4.marketState !== "LEFT_TO_RIGHT" || (zone?.strengthScore ?? 0) >= 60);
      const confOk = confirms.length >= MIN_CONFIRMS.conservative;
      const boOk = setupType !== "BREAKOUT_RUNNER" || breakout.phase === "CONTINUATION";
      gateOk = structOk && confOk && boOk;
      if (!structOk) gateReason = "Higher timeframes don't agree yet (conservative needs Daily + 4H on side).";
      else if (!confOk) gateReason = `Only ${confirms.length} of the ${MIN_CONFIRMS.conservative} required 15M confirmations so far.`;
      else if (!boOk) gateReason = `Breakout is at ${breakout.phase} — conservative waits for the retest to hold and continue.`;
    } else {
      const structOk = daily.marketState !== against && h4.marketState !== against;
      const confOk = confirms.length >= MIN_CONFIRMS.aggressive;
      const boOk = setupType !== "BREAKOUT_RUNNER" || breakout.phase === "CONFIRMED" || breakout.phase === "RETEST" || breakout.phase === "CONTINUATION";
      gateOk = structOk && confOk && boOk;
      if (!structOk) gateReason = "Daily/4H structure is against this side.";
      else if (!confOk) gateReason = "No 15M confirmation has printed yet.";
      else if (!boOk) gateReason = `Breakout is at ${breakout.phase} — needs a confirmed 15M close beyond the zone.`;
    }
  }

  // 5) Trade math (only meaningful when a setup exists).
  let trade = null, tradeReason: string | null = null;
  if (setupType && direction && zone) {
    const built = buildTrade({ symbol: o.symbol, setupType, direction, price, zone, zones, atr15, minRR: o.minRR ?? MIN_RR_DEFAULT });
    trade = built.trade; tradeReason = built.reason;
  }

  // 6) Score.
  const score = scoreDecision({ direction, daily, h4, h1, zone, location, confirmations: confirms, trade });

  // 7) The visible state machine.
  let status: SetupStatus = "WAIT";
  let finalTrade = trade;
  let noTradeReason: string | null = null;
  if (setupType && trade && gateOk && score.total >= MIN_SCORE[mode]) {
    status = "TAKE_NOW";
  } else {
    finalTrade = null;
    if (setupType && (location === "AT_SUPPORT" || location === "AT_RESISTANCE" || breakout.phase === "CONFIRMED" || breakout.phase === "RETEST") && confirms.length >= 1) {
      status = "ARMED";
    } else if (setupType || location === "NEAR_SUPPORT" || location === "NEAR_RESISTANCE" || breakout.phase === "APPROACHING" || breakout.phase === "TESTING") {
      status = "APPROACHING";
    }
    noTradeReason =
      !setupType ? (location === "MIDDLE_OF_RANGE"
        ? "Price is in the middle of the range — no edge at either level. The worst place to enter is the middle."
        : "No valid setup at this location with the current Daily structure.")
      : tradeReason ? tradeReason
      : gateReason ? gateReason
      : score.total < MIN_SCORE[mode] ? `Score ${score.total} is under the ${MIN_SCORE[mode]} ${mode} floor.`
      : "Waiting on confirmation.";
  }

  // 8) What we're monitoring while waiting.
  const watchZone = zone ?? (daily.marketState === "DOWNTREND" ? nRes : daily.marketState === "UPTREND" ? nSup : (rangePos >= 50 ? nRes : nSup));
  const watchType: SetupType | null = setupType ?? (watchZone ? (watchZone.zoneType === "support" ? "BUY_SUPPORT" : "SELL_RESISTANCE") : null);
  const distancePips = watchZone
    ? priceToPips(o.symbol, watchZone.zoneType === "support" ? Math.max(0, price - watchZone.zoneHigh) : Math.max(0, watchZone.zoneLow - price))
    : null;

  const decision: DecisionObject = {
    ok: true,
    symbol: o.symbol,
    displayName: meta.displayName,
    price,
    asOf: new Date().toISOString(),
    mode,
    structures: [daily, h4, h1],
    daily,
    zones,
    location,
    rangePosition: rangePos,
    nearestSupport: nSup,
    nearestResistance: nRes,
    confirmations: confirms,
    breakoutPhase: breakout.phase,
    breakoutDetail: breakout.detail,
    status,
    trade: finalTrade,
    noTradeReason: finalTrade ? null : noTradeReason,
    monitoring: {
      setupType: watchType,
      zone: watchZone ? { low: watchZone.zoneLow, high: watchZone.zoneHigh } : null,
      distancePips,
      watching: watchLine({ symbol: o.symbol, watchType, watchZone, distancePips, status, daily }),
    },
    score,
    whyThisTrade: [],
    engineVersion: ENGINE_VERSION,
  };
  decision.whyThisTrade = whyThisTrade(decision);
  return decision;
}
