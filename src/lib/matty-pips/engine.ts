/**
 * MATTY PIPS — the ONE deterministic engine, built on the owner's hierarchy:
 *
 *   LEVELS → LOCATION → HOW PRICE ARRIVED → LIQUIDITY → REACTION →
 *   CLOSED-15M CONFIRMATION → STRUCTURE → GOOD-vs-POSSIBLE → INVALIDATION →
 *   TARGET → MANAGEMENT.   HTF alignment is EVIDENCE, never the process.
 *
 * "NO TRADE RIGHT NOW" and "SETUP VALID BUT TRADE QUALITY POOR — WAIT" are
 * successful, first-class outputs. Standard signals use CLOSED candles only.
 */
import type {
  ConfirmationFlag, DecisionObject, EngineResult, ExpansionOutcome, Mode,
  MomentumVerdict, SetupStatus, SetupType, TradeQuality, Zone,
} from "./types";
import { ENGINE_VERSION } from "./types";
import { fetchMarket } from "./data";
import { atr, readStructure } from "./structure";
import { buildZones } from "./zones";
import { buildLevels, activeNode, activeRange } from "./levels";
import { readReaction } from "./reaction";
import { structureContext, approachQuality } from "./structureAdv";
import { liquidityContext } from "./liquidity";
import { confirmations as confirm15 } from "./confirm15m";
import { parabolicSar, fractalRead, continuationVerdict, expansionOutcome } from "./momentum";
import { breakoutQuality, acceptanceRead, entryQuality, badLocation, asymmetry, tradeQualityVerdict } from "./quality";
import { buildTrade, managementPlan } from "./targets";
import { scoreDecision } from "./score";
import { dxyContext } from "./dxy";
import { newsRead } from "./news";
import { getInstrument, priceToPips, formatPrice } from "./pips";
import { whyThisTrade, coachLines, watchLine } from "./narrate";

const QUALITY_FLOOR: Record<Mode, TradeQuality[]> = {
  conservative: ["HIGH_QUALITY", "A_PLUS"],
  aggressive: ["VALID", "HIGH_QUALITY", "A_PLUS"],
};

export async function runEngine(o: {
  symbol: string;
  mode?: Mode;
  mdKey: string;
  fresh?: boolean;
}): Promise<EngineResult> {
  const mode: Mode = o.mode === "aggressive" ? "aggressive" : "conservative";
  const meta = getInstrument(o.symbol);
  const mkt = await fetchMarket(o.symbol, o.mdKey, o.fresh === true);
  if (!mkt.ok) return { ok: false, error: mkt.error, detail: mkt.detail };

  // 1) Context structure (D/4H/1H) — evidence, not gates.
  const daily = readStructure("D", mkt.d);
  const h4 = readStructure("H4", mkt.h4);
  const h1 = readStructure("H1", mkt.h1);
  const atr15 = atr(mkt.m15.slice(0, -1));
  const price = mkt.price;

  // 2) THE LEVEL MAP (time-based + structural + zones, ranked, complexed).
  const zones = buildZones({ d: mkt.d, h4: mkt.h4, h1: mkt.h1, price });
  const { levels, complexes } = buildLevels({ d: mkt.d, zones, structHigh: daily.recentHigh, structLow: daily.recentLow, price, atr1h: h1.atr });
  const node = activeNode({ levels, complexes, price, atr1h: h1.atr });
  const range = activeRange(levels, price, daily.recentHigh, daily.recentLow);
  const rangePosition = range.high > range.low ? Math.max(0, Math.min(100, Math.round(((price - range.low) / (range.high - range.low)) * 100))) : 50;

  // 3) Advanced structure + how price arrived + liquidity.
  const sctx = structureContext({ h1: mkt.h1, m15: mkt.m15 });
  const approach = node ? approachQuality({ m15: mkt.m15, node }) : { kind: "NEUTRAL" as const, detail: "No active level to approach." };
  const liq = liquidityContext({ m15: mkt.m15, levels, node, price, atr15, atr1h: h1.atr });
  const sar = parabolicSar(mkt.m15, atr15);
  const fractals = fractalRead(mkt.m15);

  // 4) THE REACTION (closed 15M candles only).
  const reaction = node
    ? readReaction({ node, price, m15: mkt.m15, atr15, atr1h: h1.atr })
    : { state: "NONE" as const, detail: "Price is between meaningful levels — the middle is the worst place to act without a secondary level.", brokeDirection: null, confirmedByClose: false };

  // 5) Resolve direction + setup FROM THE REACTION (never from timeframe votes).
  let direction: "buy" | "sell" | null = null;
  let setupType: SetupType | null = null;
  let momentumV: MomentumVerdict | null = null;
  let expansion: ExpansionOutcome | null = null;
  let expansionDetail = "";
  let gateReason = "";

  const roomFor = (dir: "buy" | "sell"): number | null => {
    const opp = levels.filter((l) => dir === "buy" ? l.kind === "resistance" && l.low > price : l.kind === "support" && l.high < price)
      .sort((a, b) => (dir === "buy" ? a.low - b.low : b.high - a.high))[0];
    return opp ? (dir === "buy" ? opp.low - price : price - opp.high) : null;
  };

  if (node) {
    switch (reaction.state) {
      case "REJECTING":
        direction = node.kind === "resistance" ? "sell" : "buy";
        setupType = node.kind === "resistance" ? "REJECTION_SELL" : "REJECTION_BUY";
        if (!reaction.confirmedByClose) gateReason = "Rejection seen — waiting for the confirming 15M close.";
        break;
      case "FAILED_BREAK":
        direction = node.kind === "resistance" ? "sell" : "buy";
        setupType = node.kind === "resistance" ? "FAILED_BREAK_SELL" : "FAILED_BREAK_BUY";
        if (!reaction.confirmedByClose) gateReason = "Failed break / liquidity sweep — waiting for the confirming close.";
        break;
      case "BREAK_RETEST":
        direction = reaction.brokeDirection === "up" ? "buy" : "sell";
        setupType = direction === "buy" ? "BREAKOUT_RUNNER_BUY" : "BREAKOUT_RUNNER_SELL";
        if (!reaction.confirmedByClose) gateReason = "Retest holding — waiting for the confirming close in the break direction.";
        break;
      case "ACCEPTED_BREAK":
        direction = reaction.brokeDirection === "up" ? "buy" : "sell";
        setupType = direction === "buy" ? "BREAKOUT_RUNNER_BUY" : "BREAKOUT_RUNNER_SELL";
        gateReason = mode === "conservative" ? "Break accepted — conservative waits for the retest to hold." : "";
        break;
      case "MOMENTUM_CONTINUATION": {
        const dir = reaction.brokeDirection === "up" ? "buy" : "sell";
        const edge = reaction.brokeDirection === "up" ? node.high : node.low;
        const mv = continuationVerdict({ direction: reaction.brokeDirection as "up" | "down", edge, price, m15: mkt.m15, atr15, roomToNext: roomFor(dir), sar, fractals });
        momentumV = mv.verdict;
        if (mv.verdict === "CONTINUATION_ENTRY_AVAILABLE") { direction = dir; setupType = dir === "buy" ? "CONTINUATION_BUY" : "CONTINUATION_SELL"; }
        else gateReason = mv.detail;
        break;
      }
      case "EXPANSION_BREAKOUT": {
        const bd = reaction.brokeDirection as "up" | "down";
        const edge = bd === "up" ? node.high : node.low;
        const ex = expansionOutcome({ direction: bd, edge, price, m15: mkt.m15, atr15, sar, fractals });
        expansion = ex.outcome; expansionDetail = ex.detail;
        if (ex.outcome === "CONTINUATION") { direction = bd === "up" ? "buy" : "sell"; setupType = direction === "buy" ? "CONTINUATION_BUY" : "CONTINUATION_SELL"; }
        else if (ex.outcome === "EXHAUSTION_REVERSAL") { direction = bd === "up" ? "sell" : "buy"; setupType = direction === "sell" ? "FAILED_BREAK_SELL" : "FAILED_BREAK_BUY"; }
        else gateReason = ex.detail;
        break;
      }
      case "RESPECTING":
        gateReason = "Level is being respected — no confirmed rejection candle yet.";
        break;
      case "TESTING":
        gateReason = "Price is at the level — it hasn't given its verdict yet.";
        break;
      case "APPROACHING":
        gateReason = "Still traveling toward the level.";
        break;
      default:
        gateReason = reaction.detail;
    }
  } else {
    gateReason = "No meaningful level within reach — watching the map, not forcing the middle.";
  }

  // 6) 15M confirmation evidence for the chosen side.
  let confirms: ConfirmationFlag[] = [];
  if (node && direction) {
    const zone: Zone = { zoneLow: node.low, zoneHigh: node.high, zoneType: node.kind, timeframes: ["H1"], touchCount: 0, freshness: 0, strengthScore: node.rank, lastReactionTime: null, brokeAndRetested: false };
    confirms = confirm15({ side: direction, zone, m15: mkt.m15, atr15 });
  }

  // 7) Acceptance + breakout grade (when a break is in play).
  const acceptance = node ? acceptanceRead({ node, m15: mkt.m15, atr15 }).acceptance : "UNDECIDED";
  let boGrade: DecisionObject["breakoutQuality"] = null;
  if (node && reaction.brokeDirection && ["ACCEPTED_BREAK", "BREAK_RETEST", "MOMENTUM_CONTINUATION", "EXPANSION_BREAKOUT"].includes(reaction.state)) {
    const bd = reaction.brokeDirection;
    boGrade = breakoutQuality({
      direction: bd, edge: bd === "up" ? node.high : node.low, m15: mkt.m15, atr15,
      retestHeld: reaction.state === "BREAK_RETEST",
      structureAligned: bd === "up" ? fractals.higherLows : fractals.lowerHighs,
      roomToNext: direction ? roomFor(direction) : null,
    }).grade;
  }

  // 8) Cross-market + news context (gold gets DXY; everything gets the calendar).
  const atLevel = !!node && price >= node.low - 0.7 * atr15 && price <= node.high + 0.7 * atr15;
  const last4 = mkt.m15.slice(0, -1).slice(-4);
  const volExpanding = last4.length === 4 && last4.reduce((s, k) => s + (k.h - k.l), 0) / 4 >= 1.3 * atr15;
  const [dxy, news] = await Promise.all([
    o.symbol === "XAUUSD" ? dxyContext({ goldM15: mkt.m15, proposedDirection: direction, mdKey: o.mdKey, fresh: o.fresh === true }) : Promise.resolve({ verdict: "DXY_NEUTRAL" as const, detail: "DXY context applies to gold." }),
    newsRead({ symbol: o.symbol, atLevel, volatilityExpanding: volExpanding, hasOpenPosition: false }),
  ]);

  // 9) Trade math — structural stop (sweep extreme / complex / break structure).
  let built: ReturnType<typeof buildTrade> | null = null;
  if (node && direction && setupType) {
    const sweepExtreme = liq.sweep && ((liq.sweep.side === "buy-side" && direction === "sell") || (liq.sweep.side === "sell-side" && direction === "buy")) ? liq.sweep.extreme : null;
    const breakStructure = setupType.startsWith("BREAKOUT") || setupType.startsWith("CONTINUATION")
      ? (direction === "buy" ? fractals.lastLow : fractals.lastHigh) : null;
    built = buildTrade({ symbol: o.symbol, setupType, direction, price, node, sweepExtreme, breakStructure, levels, rangeMid: range.mid, atr15 });
    if (!built.trade && built.reason) gateReason = gateReason || built.reason;
  }
  const roomToNext = direction ? roomFor(direction) : null;
  const asym = built?.trade ? asymmetry(roomToNext, built.riskDist) : null;

  // 10) Bad-location filter + entry quality.
  const boxedIn = built?.trade && direction ? badLocation({ direction, price, riskDist: built.riskDist, levels, atr15 }) : null;
  const eq = node && direction ? entryQuality({ price, node, reaction, atr15, continuationOk: momentumV === "CONTINUATION_ENTRY_AVAILABLE" }) : null;

  // 11) Score + GOOD-vs-POSSIBLE verdict.
  const score = scoreDecision({
    direction, nodeRank: node?.rank ?? null, atLevel, reaction, approach, structure: sctx,
    liquidity: liq, confirmations: confirms, trade: built?.trade ? { ...built.trade, management: managementPlan({ symbol: o.symbol, setupType: built.trade.setupType, tp1Pips: built.trade.tp1Pips, runnerDesc: "" }) } : null,
    asymmetryRatio: asym, daily, h4, h1, dxyVerdict: dxy.verdict, news,
  });
  const quality = tradeQualityVerdict({
    total: score.total, hasTradeMath: !!built?.trade, confirmed: reaction.confirmedByClose,
    boxedIn: !!boxedIn, entry: eq?.quality ?? null,
  });

  // 12) Status + final trade decision.
  const qualityOk = QUALITY_FLOOR[mode].includes(quality);
  const newsOk = news.action !== "WAIT_FOR_EVENT";
  let status: SetupStatus = "WAIT";
  let finalTrade: DecisionObject["trade"] = null;
  let noTradeReason: string | null = null;

  if (built?.trade && direction && reaction.confirmedByClose && !gateReason && !boxedIn && qualityOk && newsOk) {
    status = "TAKE_NOW";
    const runnerDesc = built.trade.runnerTarget != null
      ? `${formatPrice(o.symbol, built.trade.runnerTarget)} (range midpoint / next major level)`
      : "next major level";
    finalTrade = { ...built.trade, management: managementPlan({ symbol: o.symbol, setupType: built.trade.setupType, tp1Pips: built.trade.tp1Pips, runnerDesc }) };
  } else {
    if (node && (["TESTING", "RESPECTING"].includes(reaction.state) || (["REJECTING", "FAILED_BREAK", "BREAK_RETEST"].includes(reaction.state) && !reaction.confirmedByClose))) status = "ARMED";
    else if (node && (reaction.state === "APPROACHING" || reaction.state === "ACCEPTED_BREAK" || reaction.state === "MOMENTUM_CONTINUATION" || reaction.state === "EXPANSION_BREAKOUT")) status = "APPROACHING";
    noTradeReason =
      boxedIn ? boxedIn
      : !newsOk ? news.note
      : gateReason ? gateReason
      : built?.trade && !qualityOk ? `Setup exists but grades ${quality.replace(/_/g, " ")} (score ${score.total}) — under the ${mode} floor. A possible trade isn't a good trade.`
      : !node ? "No meaningful level within reach right now."
      : reaction.detail;
  }

  const distancePips = node ? priceToPips(o.symbol, node.kind === "support" ? Math.max(0, price - node.high) : Math.max(0, node.low - price)) : null;

  const decision: DecisionObject = {
    ok: true, symbol: o.symbol, displayName: meta.displayName, price, asOf: new Date().toISOString(), mode,
    structures: [daily, h4, h1], daily,
    levels, complexes,
    activeNode: node,
    scenarios: node ? [
      node.kind === "resistance"
        ? { direction: "sell" as const, label: "Rejection / sweep SELL", needs: "15M rejects or sweeps the level and a red close confirms" }
        : { direction: "buy" as const, label: "Rejection / sweep BUY", needs: "15M rejects or sweeps the level and a green close confirms" },
      node.kind === "resistance"
        ? { direction: "buy" as const, label: "Break & hold BUY", needs: "15M closes above, then the level holds as support (retest)" }
        : { direction: "sell" as const, label: "Break & hold SELL", needs: "15M closes below, then the level holds as resistance (retest)" },
    ] : [],
    rangePosition,
    reaction, confirmations: confirms,
    momentumVerdict: momentumV, expansionOutcome: expansion, expansionDetail,
    structureContext: sctx, approach, liquidity: liq,
    breakoutQuality: boGrade, acceptance,
    tradeQuality: quality, entryQuality: eq?.quality ?? null,
    badLocation: boxedIn,
    coach: [],
    sar, fractals, dxy, news,
    status, trade: finalTrade,
    noTradeReason: finalTrade ? null : noTradeReason,
    monitoring: {
      zone: node ? { low: node.low, high: node.high } : null,
      distancePips,
      watching: watchLine({ symbol: o.symbol, node, distancePips, status, reaction }),
    },
    score, whyThisTrade: [], engineVersion: ENGINE_VERSION,
    chart: {
      m15: mkt.m15.slice(-72).map((c) => ({ t: c.t, o: +c.o.toFixed(meta.pricePrecision), h: +c.h.toFixed(meta.pricePrecision), l: +c.l.toFixed(meta.pricePrecision), c: +c.c.toFixed(meta.pricePrecision) })),
      h1: mkt.h1.slice(-48).map((c) => ({ t: c.t, o: +c.o.toFixed(meta.pricePrecision), h: +c.h.toFixed(meta.pricePrecision), l: +c.l.toFixed(meta.pricePrecision), c: +c.c.toFixed(meta.pricePrecision) })),
    },
  };
  decision.whyThisTrade = whyThisTrade(decision);
  decision.coach = coachLines(decision);
  return decision;
}
