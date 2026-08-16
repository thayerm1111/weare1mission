/**
 * Staking plan — deterministic bankroll allocation across the slate.
 *
 * You choose how much to deploy ($50–$350). This decides WHERE it goes: the
 * most money rides the strongest REAL value (edge × confidence), one bet per
 * game so you're diversified, each bet capped so nothing is over-weighted, and
 * a small, clearly-labeled slice reserved for high-variance "big pulls"
 * (plus-money parlays). Outlier/stale lines (LOW data quality) and PASS/NO BET
 * spots are excluded — real money never rides a flagged line.
 *
 * The numbers are pure math on the real odds/edges — no AI, no fabrication. If
 * nothing on the board qualifies, it returns NO PLAN and tells you to hold.
 * This is analysis for the admin's own decisions, not a promise of profit.
 */
import { americanToDecimal, parlayAmerican } from "./odds";
import type { Opportunity } from "./engine";

export type PlanStyle = "conservative" | "balanced" | "aggressive";

export type PlanPlay = {
  selection: string; league: string; matchup: string; betType: string;
  oddsAmerican: number; book: string; edgePts: number; confidence: number; dataQuality: string;
  stake: number; toWin: number; ret: number; why: string;
};
export type BigPull = {
  legs: { selection: string; league: string; matchup: string; oddsAmerican: number }[];
  combinedOdds: number | null; stake: number; toWin: number; note: string;
};
export type StakingPlan = {
  budget: number; style: PlanStyle; coreBudget: number; bigPullBudget: number;
  plays: PlanPlay[]; bigPulls: BigPull[];
  totalStaked: number; totalToWin: number; note: string | null;
};

const STYLE: Record<PlanStyle, { bigPull: number; maxPlays: number; capPct: number; minConf: number; minOdds: number; parlayLegs: number }> = {
  conservative: { bigPull: 0.08, maxPlays: 4, capPct: 0.38, minConf: 58, minOdds: 120, parlayLegs: 2 },
  balanced:     { bigPull: 0.15, maxPlays: 5, capPct: 0.34, minConf: 52, minOdds: 130, parlayLegs: 3 },
  aggressive:   { bigPull: 0.25, maxPlays: 6, capPct: 0.30, minConf: 48, minOdds: 150, parlayLegs: 3 },
};

function decOr1(a: number | null): number { return americanToDecimal(a) ?? 1; }
function r2(x: number): number { return Math.round(x * 100) / 100; }

export function buildStakingPlan(all: Opportunity[], budgetRaw: number, styleRaw: PlanStyle): StakingPlan {
  const style: PlanStyle = STYLE[styleRaw] ? styleRaw : "balanced";
  const s = STYLE[style];
  const budget = Math.max(50, Math.min(350, Math.round(budgetRaw || 0)));

  // Qualifying value: real positive edge, not a flagged/LOW line, decent confidence,
  // and an actual value classification (never PASS / NO BET).
  const qualified = all.filter((o) =>
    o.edgePts > 0 && o.dataQuality !== "LOW" && o.confidence >= s.minConf &&
    o.classification !== "PASS" && o.classification !== "NO BET",
  );

  // Core: one bet per game (highest edge×confidence), up to maxPlays.
  const seen = new Set<string>();
  const core: Opportunity[] = [];
  for (const o of [...qualified].sort((a, b) => b.edgePts * b.confidence - a.edgePts * a.confidence)) {
    if (seen.has(o.matchup)) continue;
    seen.add(o.matchup);
    core.push(o);
    if (core.length >= s.maxPlays) break;
  }

  if (!core.length) {
    return {
      budget, style, coreBudget: 0, bigPullBudget: 0, plays: [], bigPulls: [],
      totalStaked: 0, totalToWin: 0,
      note: "NO PLAN — no quality value on the board right now. The disciplined move is to keep your money and wait for a better slate.",
    };
  }

  const bigPullBudget = core.length ? Math.round(budget * s.bigPull) : 0;
  const coreBudget = budget - bigPullBudget;

  // Weight allocation by edge × confidence, then cap any single bet.
  const weights = core.map((o) => Math.max(0.1, o.edgePts) * Math.max(1, o.confidence));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  let stakes = weights.map((w) => (w / wsum) * coreBudget);
  const cap = coreBudget * s.capPct;
  for (let iter = 0; iter < 4; iter++) {
    let over = 0;
    const capped: boolean[] = stakes.map((x) => x >= cap - 1e-9);
    stakes = stakes.map((x) => { if (x > cap) { over += x - cap; return cap; } return x; });
    if (over <= 0.5) break;
    const freeIdx = stakes.map((_, i) => i).filter((i) => !capped[i]);
    const fw = freeIdx.reduce((a, i) => a + weights[i], 0);
    if (!fw) break;
    freeIdx.forEach((i) => { stakes[i] += over * (weights[i] / fw); });
  }
  // Whole-dollar stakes, min $1, and never exceed the core budget.
  stakes = stakes.map((x) => Math.max(1, Math.round(x)));
  let sum = stakes.reduce((a, b) => a + b, 0);
  while (sum > coreBudget) { // trim the largest
    const i = stakes.indexOf(Math.max(...stakes));
    if (stakes[i] <= 1) break;
    stakes[i] -= 1; sum -= 1;
  }

  const plays: PlanPlay[] = core.map((o, i) => {
    const stake = stakes[i];
    const dec = decOr1(o.oddsAmerican);
    const ret = stake * dec;
    return {
      selection: o.selection, league: o.league, matchup: o.matchup, betType: o.betType,
      oddsAmerican: o.oddsAmerican, book: o.book, edgePts: r2(o.edgePts), confidence: o.confidence, dataQuality: o.dataQuality,
      stake, toWin: r2(ret - stake), ret: r2(ret),
      why: `${o.edgePts.toFixed(1)}-pt value edge at ${o.book} · confidence ${o.confidence} · ${o.classification}`,
    };
  });

  // Big pulls: plus-money legs from DIFFERENT games → a parlay lottery ticket.
  const bigPulls: BigPull[] = [];
  if (bigPullBudget > 0) {
    const gseen = new Set<string>();
    const legs: Opportunity[] = [];
    for (const o of [...qualified].filter((o) => o.oddsAmerican >= s.minOdds).sort((a, b) => b.oddsAmerican - a.oddsAmerican)) {
      if (gseen.has(o.matchup)) continue;
      gseen.add(o.matchup);
      legs.push(o);
      if (legs.length >= s.parlayLegs) break;
    }
    if (legs.length >= 2) {
      const combined = parlayAmerican(legs.map((l) => l.oddsAmerican));
      const dec = decOr1(combined);
      const stake = bigPullBudget;
      bigPulls.push({
        legs: legs.map((l) => ({ selection: l.selection, league: l.league, matchup: l.matchup, oddsAmerican: l.oddsAmerican })),
        combinedOdds: combined, stake, toWin: r2(stake * dec - stake),
        note: "High-variance lottery ticket — every leg must hit, so the hit rate is low by design. Fun money only; be fine losing the whole stake.",
      });
    }
  }

  const totalStaked = plays.reduce((a, p) => a + p.stake, 0) + bigPulls.reduce((a, b) => a + b.stake, 0);
  const totalToWin = r2(plays.reduce((a, p) => a + p.toWin, 0) + bigPulls.reduce((a, b) => a + b.toWin, 0));

  return {
    budget, style, coreBudget, bigPullBudget: bigPulls.length ? bigPullBudget : 0,
    plays, bigPulls, totalStaked, totalToWin, note: null,
  };
}
