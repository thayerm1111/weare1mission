/**
 * PREDICTION MODEL — the AI's OWN win probability from REAL data.
 *
 * The edge engine's baseline "model prob" is just the no-vig market consensus, so it can
 * only ever find line-shopping value (rare). This module builds an INDEPENDENT probability
 * from the real ESPN context the app already pulls — team records, home/road splits, MLB
 * starting-pitcher ERA, and injuries — then the engine compares THAT to the market to find
 * predictive edges (spots where the model disagrees with the price).
 *
 * HONESTY, same as everywhere else in this feature:
 *  - Every input is real data pulled at request time. If a game can't be matched or its
 *    records aren't posted, the model does NOT fire (applied:false) and we fall back to the
 *    market consensus — never a guessed number.
 *  - The raw model is always BLENDED toward the market fair line (weight scales with data
 *    quality, capped well under 50%). The market is the anchor; the model only nudges. This
 *    keeps edges believable and stops us from ever claiming to out-model the whole market.
 *  - Every number is explained in `factors` so the admin sees exactly why.
 *
 * v1 applies to the MONEYLINE only (win probability maps directly to it). Spreads/totals stay
 * on the market-consensus baseline until the model is extended to margins.
 */
import type { DataQuality } from "./odds";
import type { League } from "./provider";
import type { GameContext } from "./context";

export type GameModel = {
  applied: boolean;          // did we have enough real data to model this game?
  pHome: number;             // RAW model win prob for the home team (pre-blend)
  pAway: number;
  factors: string[];         // transparent explanation of every adjustment
  dataQuality: DataQuality;
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** "68-52" -> 0.567 win pct (null if not parseable). */
function winPct(rec: string | null | undefined): number | null {
  if (!rec) return null;
  const m = rec.match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return null;
  const w = +m[1], l = +m[2];
  return w + l > 0 ? w / (w + l) : null;
}

/** ERA out of "Zack Wheeler — 12-6, 2.85" (the number after the comma). */
function pitcherEra(p: string | null | undefined): number | null {
  if (!p) return null;
  const m = p.match(/,\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const e = +m[1];
  return Number.isFinite(e) && e >= 0 && e < 15 ? e : null;
}

/** log5: probability team A (rate a) beats team B (rate b) on a neutral field. */
function log5(a: number, b: number): number {
  const denom = a + b - 2 * a * b;
  if (denom <= 0) return 0.5;
  return clamp((a - a * b) / denom, 0.02, 0.98);
}

// Home-field win-probability edge by sport (empirical long-run home win rates ≈ these).
const HFA: Record<League, number> = { NFL: 0.03, NBA: 0.035, MLB: 0.025 };
// A player counts as "out" for the injury nudge at these statuses.
const OUT_RE = /\bout\b|injured reserve|\bir\b|doubtful|suspended/i;

/**
 * Build the raw (pre-blend) model win probability for the home team from real context.
 * Returns applied:false (and a market-only fallback prob) when the data isn't there.
 */
export function computeGameModel(league: League, ctx: GameContext, marketFairHome: number | null): GameModel {
  const fallback = (why: string): GameModel => ({
    applied: false,
    pHome: marketFairHome ?? 0.5,
    pAway: marketFairHome != null ? 1 - marketFairHome : 0.5,
    factors: [why],
    dataQuality: "LOW",
  });

  if (!ctx.matched || !ctx.home || !ctx.away) return fallback("No matched ESPN game/team data — market consensus only.");

  const hOverall = winPct(ctx.home.overall);
  const aOverall = winPct(ctx.away.overall);
  const hHome = winPct(ctx.home.home);   // home team's record AT HOME
  const aRoad = winPct(ctx.away.road);   // away team's record ON THE ROAD
  const hBase = hHome ?? hOverall;
  const aBase = aRoad ?? aOverall;
  if (hBase == null || aBase == null) return fallback("Team records not posted — market consensus only.");

  const factors: string[] = [];
  const usedSplits = hHome != null && aRoad != null;

  // 1) Base strength via log5 on win rates (situational splits when available).
  let pHome = log5(hBase, aBase);
  factors.push(
    `Records — home ${ctx.home.overall ?? "?"}${hHome != null ? ` (home ${ctx.home.home})` : ""}` +
    ` vs away ${ctx.away.overall ?? "?"}${aRoad != null ? ` (road ${ctx.away.road})` : ""} → base ${(pHome * 100).toFixed(0)}%`,
  );

  // 2) Home-field advantage (halved if home/road splits already encode some of it).
  const hfa = HFA[league] * (usedSplits ? 0.5 : 1);
  pHome = clamp(pHome + hfa, 0.02, 0.98);
  factors.push(`Home-field +${(hfa * 100).toFixed(1)}%`);

  let dq: DataQuality = usedSplits ? "HIGH" : "MEDIUM";

  // 3) MLB starting pitchers — ERA gap (~5% win prob per 1.00 ERA, capped ±10%).
  if (league === "MLB") {
    const hEra = pitcherEra(ctx.home.probablePitcher);
    const aEra = pitcherEra(ctx.away.probablePitcher);
    if (hEra != null && aEra != null) {
      const eraAdj = clamp((aEra - hEra) * 0.05, -0.10, 0.10);
      pHome = clamp(pHome + eraAdj, 0.02, 0.98);
      factors.push(`Starters — home ${hEra.toFixed(2)} ERA vs away ${aEra.toFixed(2)} → ${eraAdj >= 0 ? "+" : ""}${(eraAdj * 100).toFixed(1)}%`);
      dq = "HIGH";
    } else {
      factors.push("Probable pitchers not both posted — no pitcher adjustment.");
      if (dq === "HIGH") dq = "MEDIUM";
    }
  }

  // 4) Injuries — small, capped, transparent (count of players ruled out; NOT player-weighted).
  const outCount = (list: { status: string }[]) => list.filter((i) => OUT_RE.test(i.status)).length;
  const hOut = outCount(ctx.injuriesHome), aOut = outCount(ctx.injuriesAway);
  if (hOut || aOut) {
    const injAdj = clamp((aOut - hOut) * 0.008, -0.04, 0.04);
    pHome = clamp(pHome + injAdj, 0.02, 0.98);
    factors.push(`Injuries out — home ${hOut}, away ${aOut} → ${injAdj >= 0 ? "+" : ""}${(injAdj * 100).toFixed(1)}% (rough, not star-weighted)`);
  }

  return { applied: true, pHome, pAway: 1 - pHome, factors, dataQuality: dq };
}

// How much weight the RAW model gets vs the market fair line, by data quality. The market is
// always the majority anchor — the model only nudges the number.
const BLEND_W: Record<DataQuality, number> = { HIGH: 0.38, MEDIUM: 0.22, LOW: 0 };

/** Weight (0..1) the model side-probability should get given its data quality. */
export function modelBlendWeight(model: GameModel): number {
  return model.applied ? BLEND_W[model.dataQuality] : 0;
}

/**
 * Blend a raw model side-probability with that side's market fair probability.
 * `w` is modelBlendWeight(); returns the market fair unchanged when the model didn't apply.
 */
export function blendSide(rawModelSide: number, marketFairSide: number, w: number): number {
  if (w <= 0) return marketFairSide;
  return clamp(w * rawModelSide + (1 - w) * marketFairSide, 0.02, 0.98);
}
