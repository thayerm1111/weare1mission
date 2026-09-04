/**
 * MATTY PIPS — EXECUTION STATE ENGINE. Direction and entry are DIFFERENT
 * decisions: the market can be a clear BUY while the current price is a bad
 * buy. Three states, never "no trade":
 *
 *   TAKE_NOW        — price is AT a valid zone with the trigger in hand: market order.
 *   WAIT_FOR_PRICE  — right side, wrong price: here is the LIMIT zone to wait for.
 *   BREAKOUT_ENTRY  — the move needs the level to give way first: stop order past the edge.
 *
 * A structural stop that won't fit inside $10 is never "tightened to fit" —
 * that situation IS a WAIT_FOR_PRICE at a better price by definition, and the
 * caller anchors all trade math at entry.price, not the live print.
 */
import type { RankedLevel, ReactionRead, StructureContext } from "./types";
import type { MpConfig } from "./config";
import type { MicroRead } from "./micro";

export type ExecutionState = "TAKE_NOW" | "WAIT_FOR_PRICE" | "BREAKOUT_ENTRY";

export type EntryPlan = {
  type: "MARKET" | "LIMIT" | "STOP";
  price: number;                   // the price all trade math anchors to
  zoneLow: number;                 // the acceptable fill band
  zoneHigh: number;
  note: string;                    // plain-English what/why
};

export type ExecutionRead = {
  state: ExecutionState;
  entry: EntryPlan;
  entryQualityScore: number;       // 0–100 — quality of acting on this plan NOW
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function readExecution(o: {
  cfg: MpConfig;
  direction: "buy" | "sell";
  price: number;
  atr15: number;
  levels: RankedLevel[];
  node: { low: number; high: number; kind: "support" | "resistance"; rank: number } | null;
  reaction: ReactionRead;
  sctx: StructureContext;
  micro: MicroRead;
}): ExecutionRead {
  const { cfg, price, atr15 } = o;
  const up = o.direction === "buy";
  const pad = cfg.execution.atZoneAtr * atr15;

  // The zone that FAVORS this direction (buy from support, sell from resistance).
  const favorable = o.levels
    .filter((l) => l.rank >= cfg.execution.minZoneRank && (up ? l.kind === "support" && l.low <= price + pad : l.kind === "resistance" && l.high >= price - pad))
    .sort((a, b) => (up ? b.high - a.high : a.low - b.low))[0] ?? null;

  const nodeFavors = !!o.node && (up ? o.node.kind === "support" : o.node.kind === "resistance");
  const nodeOpposes = !!o.node && !nodeFavors;
  const atFavorable =
    (nodeFavors && o.node != null && price >= o.node.low - pad && price <= o.node.high + pad) ||
    (favorable != null && (up ? price <= favorable.high + pad : price >= favorable.low - pad) && (up ? price >= favorable.low - pad : price <= favorable.high + pad));

  const zone = nodeFavors && o.node ? o.node : favorable;
  const distToZone = zone ? (up ? price - zone.high : zone.low - price) : null; // + = away from it
  const extendedFromZone = distToZone != null && distToZone > cfg.execution.extendedAtr * atr15;
  const microChase = o.micro.extended && o.micro.extendedSide === (up ? "up" : "down");

  // Fresh confirmation IN the call's direction (closed 15M or a 5M trigger).
  const confirmed =
    (o.reaction.confirmedByClose && o.reaction.brokeDirection !== (up ? "down" : "up") &&
      ((["REJECTING", "FAILED_BREAK"].includes(o.reaction.state) && nodeFavors) ||
        (["BREAK_RETEST", "ACCEPTED_BREAK", "MOMENTUM_CONTINUATION"].includes(o.reaction.state) && o.reaction.brokeDirection === (up ? "up" : "down")))) ||
    o.micro.trigger?.side === o.direction;

  /* ── BREAKOUT_ENTRY: the call points THROUGH the node price is pressing —
     compression / repeated attack into an opposing level. Enter on the give. */
  const pressingThrough =
    nodeOpposes && o.node != null &&
    (up ? price >= o.node.low - pad : price <= o.node.high + pad) &&
    (o.sctx.compression === (up ? "bullish" : "bearish") ||
      ["TESTING", "RESPECTING", "APPROACHING"].includes(o.reaction.state));
  if (pressingThrough && o.node && !confirmed) {
    const edge = up ? o.node.high : o.node.low;
    const trigger = r2(up ? edge + cfg.execution.breakoutPadAtr * atr15 : edge - cfg.execution.breakoutPadAtr * atr15);
    return {
      state: "BREAKOUT_ENTRY",
      entry: {
        type: "STOP", price: trigger,
        zoneLow: r2(Math.min(trigger, up ? edge : trigger - 0.3 * atr15)),
        zoneHigh: r2(Math.max(trigger, up ? trigger + 0.3 * atr15 : edge)),
        note: `The move runs THROUGH ${up ? "resistance" : "support"} at ${edge.toFixed(2)} — arm a ${up ? "buy" : "sell"} stop at ${trigger.toFixed(2)} so the level's own break pulls you in. No break, no trade.`,
      },
      entryQualityScore: 62,
    };
  }

  /* ── TAKE_NOW: at a valid zone (or freshly confirmed) and NOT a chase. */
  if ((atFavorable || confirmed) && !extendedFromZone && !microChase) {
    const q = 60
      + (atFavorable ? 15 : 0)
      + (confirmed ? 15 : 0)
      + (o.reaction.confirmedByClose ? 5 : 0)
      + (zone ? Math.min(5, zone.rank / 20) : 0);
    return {
      state: "TAKE_NOW",
      entry: {
        type: "MARKET", price: r2(price),
        zoneLow: r2(zone ? Math.min(zone.low, price) : price - 0.3 * atr15),
        zoneHigh: r2(zone ? Math.max(zone.high, price) : price + 0.3 * atr15),
        note: atFavorable
          ? `Price is AT the ${up ? "support" : "resistance"} that matters${confirmed ? " and the trigger already fired" : ""} — this is the price to act on.`
          : "The confirmation just printed and price hasn't run away — act at market.",
      },
      entryQualityScore: Math.min(95, Math.round(q)),
    };
  }

  /* ── WAIT_FOR_PRICE: right side, wrong price. Name the exact zone to wait for. */
  const waitZone = up
    ? o.levels.filter((l) => l.kind === "support" && l.rank >= cfg.execution.minZoneRank && l.high < price).sort((a, b) => b.high - a.high)[0] ?? null
    : o.levels.filter((l) => l.kind === "resistance" && l.rank >= cfg.execution.minZoneRank && l.low > price).sort((a, b) => a.low - b.low)[0] ?? null;
  let zLow: number, zHigh: number, limit: number, why: string;
  if (waitZone && Math.abs((up ? price - waitZone.high : waitZone.low - price)) <= 6 * atr15) {
    zLow = waitZone.low; zHigh = waitZone.high;
    limit = up ? waitZone.high : waitZone.low;
    why = `Direction is ${up ? "UP" : "DOWN"}, but this print is ${microChase || extendedFromZone ? "a chase" : "mid-air"} — the trade is at the ${up ? "support" : "resistance"} band ${zLow.toFixed(2)}–${zHigh.toFixed(2)}. Park the limit and let price come to you.`;
  } else {
    const pull = cfg.execution.limitFallbackPullbackAtr * atr15;
    const width = cfg.execution.limitFallbackWidthAtr * atr15;
    limit = r2(up ? price - pull : price + pull);
    zLow = up ? limit - width : limit;
    zHigh = up ? limit : limit + width;
    why = `Direction is ${up ? "UP" : "DOWN"} but there's no clean zone at this print — wait for the ordinary pullback to ${limit.toFixed(2)} instead of paying the worst price of the move.`;
  }
  return {
    state: "WAIT_FOR_PRICE",
    entry: { type: "LIMIT", price: r2(limit), zoneLow: r2(zLow), zoneHigh: r2(zHigh), note: why },
    entryQualityScore: microChase || extendedFromZone ? 30 : 45,
  };
}
