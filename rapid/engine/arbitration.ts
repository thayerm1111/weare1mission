import type { Regime, Setup, Side, Timeframe } from "../core/types";

/**
 * Signal arbitration.
 *
 * The 5m and 15m views are ALTERNATIVES. Nothing requires them to agree, and nothing requires both
 * to fire before a trade is valid. What matters is that the same economic opportunity — the same
 * parent level, the same direction — becomes ONE setup and ONE visit, so two timeframes cannot each
 * put an order on the account.
 *
 * Ranking, in order:
 *   1. A confirmed break/retest or trend pullback beats a range fade pointing the other way.
 *   2. Structure quality: the higher source timeframe wins.
 *   3. Daily alignment, as a tie-break only — the daily bias ranks candidates, it never creates or
 *      vetoes one.
 *   4. Net reward/risk.
 *   5. Stable id, so the result is deterministic rather than dependent on map ordering.
 */

const FAMILY_RANK: Record<Setup["family"], number> = {
  break_retest: 3,
  trend_pullback: 3,
  momentum: 2,
  range_reaction: 1,
};

const TF_RANK: Record<Timeframe, number> = { M5: 1, M15: 2, H1: 3, H4: 4, D1: 5, W1: 6 };

export type ArbitrationResult = {
  selected: Setup[];
  dropped: Array<{ setup: Setup; reason: string }>;
};

export function arbitrate(setups: Setup[], dailyRegime: Regime): ArbitrationResult {
  const dropped: Array<{ setup: Setup; reason: string }> = [];

  // 1. Collapse duplicates of the same economic opportunity (parent level + direction).
  const byOpportunity = new Map<string, Setup>();
  for (const s of setups) {
    const key = `${s.parentId}|${s.side}`;
    const incumbent = byOpportunity.get(key);
    if (!incumbent) {
      byOpportunity.set(key, s);
      continue;
    }
    const winner = better(incumbent, s, dailyRegime);
    const loser = winner === incumbent ? s : incumbent;
    byOpportunity.set(key, winner);
    dropped.push({ setup: loser, reason: `merged into ${winner.setupId}: same level ${s.parentId}, same direction` });
  }

  // 2. Never hold simultaneous buy and sell intents for one instrument. The stronger side survives.
  const remaining = [...byOpportunity.values()];
  const buys = remaining.filter((s) => s.side === "buy");
  const sells = remaining.filter((s) => s.side === "sell");
  let selected = remaining;
  if (buys.length && sells.length) {
    const bestBuy = buys.reduce((a, b) => better(a, b, dailyRegime));
    const bestSell = sells.reduce((a, b) => better(a, b, dailyRegime));
    const winner = better(bestBuy, bestSell, dailyRegime);
    const losingSide: Side = winner.side === "buy" ? "sell" : "buy";
    for (const s of remaining) {
      if (s.side === losingSide) dropped.push({ setup: s, reason: `opposing ${winner.family} ${winner.side} ranked higher; one instrument cannot hold both sides` });
    }
    selected = remaining.filter((s) => s.side === winner.side);
  }

  selected.sort((a, b) => (better(a, b, dailyRegime) === a ? -1 : 1));
  return { selected, dropped };
}

function better(a: Setup, b: Setup, daily: Regime): Setup {
  const fam = FAMILY_RANK[a.family] - FAMILY_RANK[b.family];
  if (fam !== 0) return fam > 0 ? a : b;

  const tf = TF_RANK[a.timeframe] - TF_RANK[b.timeframe];
  if (tf !== 0) return tf > 0 ? a : b;

  const aligned = (s: Setup) => (daily === "up" && s.side === "buy") || (daily === "down" && s.side === "sell");
  if (aligned(a) !== aligned(b)) return aligned(a) ? a : b;

  const rrA = a.stopUsd > 0 ? a.targetUsd / a.stopUsd : 0;
  const rrB = b.stopUsd > 0 ? b.targetUsd / b.stopUsd : 0;
  if (Math.abs(rrA - rrB) > 1e-9) return rrA > rrB ? a : b;

  return a.setupId <= b.setupId ? a : b;
}
