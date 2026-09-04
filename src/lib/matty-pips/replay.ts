/**
 * MATTY PIPS — REPLAY / BACKTEST HARNESS (no lookahead, by construction).
 * Walks history: at each decision point every timeframe array is TRUNCATED to
 * the bars that had closed by that moment, decideGold() runs on exactly what
 * it would have seen live, and the verdict is graded by evaluateCall() on the
 * bars that came AFTER. Same decision function, same evaluator as production —
 * a replay result IS the live engine's honest record on that history.
 */
import type { Candle } from "./types";
import { decideGold } from "./decide";
import { evaluateCall } from "./outcome";
import type { MattyCall } from "./verdict";
import type { MpConfig } from "./config";

/** Hard invariants every call must satisfy — used by replay and by tests. */
export function validateCall(call: MattyCall): string[] {
  const v: string[] = [];
  const up = call.direction === "buy";
  const fin = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (!fin(call.entry) || !fin(call.stopLoss) || !fin(call.tp1)) v.push("non-finite level");
  if (call.stopDollars < 3 - 1e-9 || call.stopDollars > 10 + 1e-9) v.push(`stop $${call.stopDollars} outside [3,10]`);
  if (call.tp1Dollars < 3 - 1e-9 || call.tp1Dollars > 7 + 1e-9) v.push(`tp1 $${call.tp1Dollars} outside [3,7]`);
  if (up ? call.stopLoss >= call.entry : call.stopLoss <= call.entry) v.push("stop on the wrong side of entry");
  if (up ? call.tp1 <= call.entry : call.tp1 >= call.entry) v.push("tp1 on the wrong side of entry");
  if (call.tp2 != null && (up ? call.tp2 <= call.tp1 : call.tp2 >= call.tp1)) v.push("tp2 not beyond tp1");
  if (call.tp3 != null && call.tp2 != null && (up ? call.tp3 <= call.tp2 : call.tp3 >= call.tp2)) v.push("tp3 not beyond tp2");
  if (call.rr1 <= 0) v.push("non-positive R:R");
  const conv = call.conviction ?? call.confidence;
  if (!fin(conv) || conv < 0 || conv > 100) v.push("conviction out of range");
  if (call.entryPlan) {
    if (call.entryPlan.zoneLow > call.entryPlan.zoneHigh + 1e-9) v.push("entry zone inverted");
    if (call.executionState === "WAIT_FOR_PRICE" && (up ? call.entry > call.entryPlan.zoneHigh + 1e-6 : call.entry < call.entryPlan.zoneLow - 1e-6)) v.push("limit outside its zone");
  }
  return v;
}

export type ReplayPoint = {
  t: number;
  price: number;
  call: MattyCall;
  outcome: ReturnType<typeof evaluateCall>;
  violations: string[];
};

export type ReplaySummary = {
  points: number;
  resolved: number;
  wins: number;
  losses: number;
  unfilled: number;
  pending: number;
  winRate: number | null;
  plus3First: number | null;          // % of decided calls where +$3 came before −$3
  avgMfe: number | null;
  avgMae: number | null;
  byState: Record<string, { n: number; wins: number; losses: number }>;
  byConvictionBand: Record<string, { n: number; wins: number; losses: number }>;
  violations: string[];               // deduped invariant breaches (should be empty)
};

const WIN = new Set(["win_tp1", "win_tp2", "win_tp3", "expired_win"]);
const LOSS = new Set(["loss", "expired_loss"]);

export function replayGold(o: {
  d: Candle[]; h4: Candle[]; h1: Candle[]; m15: Candle[]; m5: Candle[];
  stepBars?: number;                  // 15M bars between decision points (default 4 ≈ hourly)
  minHistoryBars?: number;            // m15 bars required before the first decision
  cfg?: MpConfig;
  keepPoints?: boolean;
}): { summary: ReplaySummary; points?: ReplayPoint[] } {
  const step = Math.max(1, o.stepBars ?? 4);
  const minHist = Math.max(60, o.minHistoryBars ?? 80);
  const pts: ReplayPoint[] = [];
  const vioSet = new Set<string>();
  const byState: ReplaySummary["byState"] = {};
  const byBand: ReplaySummary["byConvictionBand"] = {};
  let wins = 0, losses = 0, unfilled = 0, pending = 0, resolved = 0;
  let plus3Yes = 0, plus3Decided = 0, mfeSum = 0, maeSum = 0, graded = 0;

  for (let i = minHist; i < o.m15.length - 4; i += step) {
    const t = o.m15[i].t;
    const cut = (arr: Candle[]) => arr.filter((c) => c.t <= t);
    const m15 = o.m15.slice(0, i + 1);
    const m5 = cut(o.m5);
    const h1 = cut(o.h1), h4 = cut(o.h4), d = cut(o.d);
    if (d.length < 20 || h4.length < 30 || h1.length < 40) continue;
    const price = m15[m15.length - 1].c;

    let call: MattyCall;
    try {
      call = decideGold({ d, h4, h1, m15, m5, price }, { nowMs: t + 15 * 60000, cfg: o.cfg });
    } catch (e) {
      vioSet.add(`decide threw: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const v of validateCall(call)) vioSet.add(v);

    // Grade on the finest bars available AFTER the decision (no lookahead in
    // the decision itself — these bars are only ever seen by the evaluator).
    const after5 = o.m5.filter((c) => c.t > t);
    const after15 = o.m15.slice(i + 1);
    const use5 = after5.length >= 24;
    const bars = use5 ? after5 : after15;
    const barMs = use5 ? 5 * 60000 : 15 * 60000;
    const outcome = evaluateCall(call, bars, {
      unfilledBars: Math.round((8 * 3600_000) / barMs),
      expiryBars: Math.round((24 * 3600_000) / barMs),
    });

    if (WIN.has(outcome.status)) { wins++; resolved++; }
    else if (LOSS.has(outcome.status)) { losses++; resolved++; }
    else if (outcome.status === "unfilled") unfilled++;
    else pending++;
    if (outcome.plus3BeforeMinus3 != null) { plus3Decided++; if (outcome.plus3BeforeMinus3) plus3Yes++; }
    if (outcome.filled) { graded++; mfeSum += outcome.mfe; maeSum += outcome.mae; }

    const st = call.executionState ?? "TAKE_NOW";
    byState[st] = byState[st] ?? { n: 0, wins: 0, losses: 0 };
    byState[st].n++;
    if (WIN.has(outcome.status)) byState[st].wins++;
    if (LOSS.has(outcome.status)) byState[st].losses++;
    const conv = call.conviction ?? call.confidence;
    const band = conv >= 75 ? "75+" : conv >= 60 ? "60-74" : conv >= 45 ? "45-59" : "<45";
    byBand[band] = byBand[band] ?? { n: 0, wins: 0, losses: 0 };
    byBand[band].n++;
    if (WIN.has(outcome.status)) byBand[band].wins++;
    if (LOSS.has(outcome.status)) byBand[band].losses++;

    if (o.keepPoints) pts.push({ t, price, call, outcome, violations: validateCall(call) });
  }

  const summary: ReplaySummary = {
    points: wins + losses + unfilled + pending,
    resolved, wins, losses, unfilled, pending,
    winRate: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null,
    plus3First: plus3Decided ? Math.round((plus3Yes / plus3Decided) * 100) : null,
    avgMfe: graded ? +(mfeSum / graded).toFixed(2) : null,
    avgMae: graded ? +(maeSum / graded).toFixed(2) : null,
    byState, byConvictionBand: byBand,
    violations: [...vioSet],
  };
  return o.keepPoints ? { summary, points: pts } : { summary };
}
