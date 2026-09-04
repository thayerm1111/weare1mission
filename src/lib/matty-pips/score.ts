/**
 * MATTY PIPS SCORE — 0–100 with a visible breakdown. Pure math.
 *   Structure 30 · Zone 20 · Location 20 · 15M confirmation 15 · R:R 10 · Momentum 5
 */
import type { ConfirmationFlag, LocationState, ScoreBreakdown, TfStructure, TradeIdea, Zone } from "./types";

export function scoreDecision(o: {
  direction: "buy" | "sell" | null;
  daily: TfStructure; h4: TfStructure; h1: TfStructure;
  zone: Zone | null;
  location: LocationState;
  confirmations: ConfirmationFlag[];
  trade: TradeIdea | null;
}): ScoreBreakdown {
  const dir = o.direction;
  const want = dir === "buy" ? "UPTREND" : dir === "sell" ? "DOWNTREND" : null;

  // STRUCTURE /30 — trend clarity + D/4H/1H agreement with the trade direction.
  let structure = 0;
  if (want) {
    const tfs = [o.daily, o.h4, o.h1];
    const agree = tfs.filter((t) => t.marketState === want).length;
    const notAgainst = tfs.filter((t) => t.marketState !== (want === "UPTREND" ? "DOWNTREND" : "UPTREND")).length;
    const strengthAvg = tfs.reduce((s, t) => s + t.trendStrength, 0) / 3;
    structure = Math.round(14 * (agree / 3) + 8 * (notAgainst / 3) + 8 * (strengthAvg / 100));
  } else {
    structure = Math.round(10 * (o.daily.trendStrength / 100));
  }

  // ZONE /20 — the traded zone's strength.
  const zone = o.zone ? Math.round(20 * (o.zone.strengthScore / 100)) : 0;

  // LOCATION /20 — how close price is to the ideal entry point.
  const locMap: Record<LocationState, number> = {
    AT_SUPPORT: 20, AT_RESISTANCE: 20,
    NEAR_SUPPORT: 14, NEAR_RESISTANCE: 14,
    BREAKING_RESISTANCE: 12, BREAKING_SUPPORT: 12,
    ABOVE_RESISTANCE: 10, BELOW_SUPPORT: 10,
    MIDDLE_OF_RANGE: 2,
  };
  const location = locMap[o.location] ?? 0;

  // CONFIRMATION /15 — count + quality of 15M predicates (cap at 3 strong ones).
  const strongKeys = new Set(["engulfing", "reclaim_close", "structure_shift", "failed_break"]);
  const strong = o.confirmations.filter((c) => strongKeys.has(c.key)).length;
  const confirmation = Math.min(15, o.confirmations.length * 3 + strong * 2);

  // R:R /10 — scaled 1:2 → 1:4.
  const rr = o.trade ? Math.max(0, Math.min(10, Math.round(((o.trade.riskReward - 2) / 2) * 10))) : 0;

  // MOMENTUM /5 — the expansion predicate.
  const momentum = o.confirmations.some((c) => c.key === "momentum_expansion") ? 5 : 0;

  const total = Math.max(0, Math.min(100, structure + zone + location + confirmation + rr + momentum));
  return { structure, zone, location, confirmation, riskReward: rr, momentum, total };
}
