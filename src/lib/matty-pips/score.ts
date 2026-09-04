/**
 * MATTY PIPS ADVANCED SCORE — 0–100, owner-specified weights:
 * Level/Location 20 · Reaction 20 · Structure 15 · Liquidity 10 ·
 * 15M Confirmation 15 · Risk/Target 10 · Momentum 5 · DXY 3 · News 2.
 * Pure math; every part visible in the breakdown.
 */
import type {
  ApproachQuality, ConfirmationFlag, DxyVerdict, LiquidityContext, NewsRead,
  ReactionRead, ScoreBreakdown, StructureContext, TfStructure, TradeIdea,
} from "./types";

export function scoreDecision(o: {
  direction: "buy" | "sell" | null;
  nodeRank: number | null;            // rank of the active level/complex
  atLevel: boolean;                   // price interacting with it now
  reaction: ReactionRead;
  approach: ApproachQuality;
  structure: StructureContext;
  liquidity: LiquidityContext;
  confirmations: ConfirmationFlag[];
  trade: TradeIdea | null;
  asymmetryRatio: number | null;      // room / risk
  daily: TfStructure; h4: TfStructure; h1: TfStructure;
  dxyVerdict: DxyVerdict;
  news: NewsRead;
}): ScoreBreakdown {
  const dir = o.direction;

  // LEVEL / LOCATION /20 — how meaningful is the level, and are we AT it?
  const levelLocation = o.nodeRank == null ? 0
    : Math.round(Math.min(14, (o.nodeRank / 100) * 14) + (o.atLevel ? 6 : 2));

  // REACTION /20 — what price actually did there.
  const reactionMap: Record<string, number> = {
    NONE: 0, APPROACHING: 3, TESTING: 6, RESPECTING: 9,
    REJECTING: 15, FAILED_BREAK: 17, ACCEPTED_BREAK: 12,
    BREAK_RETEST: 17, MOMENTUM_CONTINUATION: 11, EXPANSION_BREAKOUT: 10,
  };
  let reaction = reactionMap[o.reaction.state] ?? 0;
  if (o.reaction.confirmedByClose && reaction > 0) reaction = Math.min(20, reaction + 3);
  // Approach evidence nudges the reaction read (never decides it).
  if (dir && o.approach.kind === "FAST_EXPANSION" && (o.reaction.state === "REJECTING" || o.reaction.state === "FAILED_BREAK")) reaction = Math.min(20, reaction + 1);
  if (dir && o.approach.kind === "GRIND_COMPRESSION" && (o.reaction.state === "REJECTING")) reaction = Math.max(0, reaction - 3);

  // STRUCTURE /15 — advanced context aligned with the trade direction.
  let structure = 5;
  if (dir) {
    const want = dir === "buy" ? "up" : "down";
    const wantTrend = dir === "buy" ? "UPTREND" : "DOWNTREND";
    if (o.structure.internalTrend === wantTrend) structure += 3;
    if (o.structure.structureBreakDirection === want) structure += 3;
    if (o.structure.changeOfCharacter && o.structure.internalTrend === wantTrend) structure += 2;
    if (o.structure.externalTrend === wantTrend) structure += 2;
    const against = dir === "buy" ? "DOWNTREND" : "UPTREND";
    if (o.structure.internalTrend === against) structure -= 4;
    if (o.structure.compression === (dir === "buy" ? "bearish" : "bullish")) structure -= 2;
  }
  structure = Math.max(0, Math.min(15, structure));

  // LIQUIDITY /10 — a confirmed sweep in our favor is gold-standard evidence.
  let liquidity = 3;
  if (dir && o.liquidity.sweep) {
    const sweepFavors = (o.liquidity.sweep.side === "buy-side" && dir === "sell") || (o.liquidity.sweep.side === "sell-side" && dir === "buy");
    if (sweepFavors) liquidity += o.liquidity.fakeoutProbability === "FAKEOUT_HIGH" ? 7 : o.liquidity.fakeoutProbability === "FAKEOUT_MODERATE" ? 5 : 3;
    else liquidity -= 2;
  }
  if (dir) {
    const target = dir === "buy" ? o.liquidity.buySidePools : o.liquidity.sellSidePools;
    if (target.length) liquidity += 1; // liquidity sitting toward our target = a magnet
  }
  liquidity = Math.max(0, Math.min(10, liquidity));

  // 15M CONFIRMATION /15 — closed-candle evidence count/quality.
  const strongKeys = new Set(["engulfing", "reclaim_close", "structure_shift", "failed_break", "rejection_wick"]);
  const strong = o.confirmations.filter((c) => strongKeys.has(c.key)).length;
  let confirmation = Math.min(12, o.confirmations.length * 3 + strong);
  if (o.reaction.confirmedByClose) confirmation = Math.min(15, confirmation + 3);

  // RISK / TARGET /10 — stop quality + asymmetry (never "small stop = good").
  let riskTarget = 0;
  if (o.trade) {
    riskTarget += 4; // structural stop exists where the idea is wrong
    const asym = o.asymmetryRatio ?? 2.5;
    riskTarget += asym >= 3 ? 6 : asym >= 2 ? 5 : asym >= 1.3 ? 3 : asym >= 1 ? 2 : 0;
  }
  riskTarget = Math.min(10, riskTarget);

  // MOMENTUM /5.
  let momentum = 0;
  if (o.confirmations.some((c) => c.key === "momentum_expansion")) momentum += 2;
  if (dir && o.structure.impulseStrength >= 50 && (o.structure.internalTrend === (dir === "buy" ? "UPTREND" : "DOWNTREND"))) momentum += 2;
  if (o.structure.exhaustion && dir && o.structure.internalTrend === (dir === "buy" ? "UPTREND" : "DOWNTREND")) momentum -= 2;
  momentum = Math.max(0, Math.min(5, momentum));

  // DXY /3 — supporting evidence only.
  const dxy = o.dxyVerdict === "DXY_SUPPORTS" ? 3 : o.dxyVerdict === "DXY_CONFLICTS" ? 0 : 2;

  // NEWS /2 — event context.
  const news = o.news.action === "NORMAL_SETUP" ? 2 : o.news.action === "REDUCED_CONFIDENCE" ? 1 : 0;

  const total = Math.max(0, Math.min(100, levelLocation + reaction + structure + liquidity + confirmation + riskTarget + momentum + dxy + news));
  return { levelLocation, reaction, structure, liquidity, confirmation, riskTarget, momentum, dxy, news, total };
}
