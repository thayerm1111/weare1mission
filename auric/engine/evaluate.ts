import type { Bar, Candidate, Decision, Features, Quote, RegimeState, Rejection } from "../core/types";
import type { AuricConfig } from "../config/defaults";
import { atr, atrSeries, confirmedPivots, detectRange, checkRangeValidity, efficiency, emaSlopeAtr, meanBodyRatio, meanOverlap, percentileRank, structureOf } from "./features";
import { classify, stepRegime } from "./regime";
import { compressionBreakout, rangeRejection, trendPullback, type SetupState, type SetupContext } from "./setups";

export type EngineState = { regime: RegimeState | null; range: Features["range"]; setups: SetupState; lastM5T: number };
export const emptyEngineState = (): EngineState => ({ regime: null, range: null, setups: { compression: null, rangeFailedBreaks: {}, lastRangeProbe: null, seen: [] }, lastM5T: 0 });

export type EvalInput = {
  cfg: AuricConfig; m1: Bar[]; m5: Bar[]; m15: Bar[]; h1: Bar[]; quote: Quote | null; tick: number; contractSize: number | null; now: number;
};
export type EvalOutput = { features: Features; regime: RegimeState; decision: Decision; state: EngineState; computeMs: number };

/** Build the feature set from CLOSED bars only. */
export function computeFeatures(inp: EvalInput, prevRange: Features["range"]): { f: Features; rangeNext: Features["range"] } {
  const { cfg, m5, m1, m15, h1, quote } = inp; const fc = cfg.features;
  const closes5 = m5.map((b) => b.c);
  const a5 = atr(m5, fc.atrPeriod), a1 = atr(m1, fc.atrPeriod);
  const series = atrSeries(m5, fc.atrPeriod).slice(-fc.atrPercentileWindow);
  const eff = efficiency(closes5, fc.efficiencyBars);
  const piv = confirmedPivots(m5, fc.pivotLeft, fc.pivotRight);
  const nowI = m5.length - 1;
  const highs = piv.highs.filter((p) => p.confirmedAtIndex <= nowI), lows = piv.lows.filter((p) => p.confirmedAtIndex <= nowI);
  const p15 = confirmedPivots(m15, fc.pivotLeft, fc.pivotRight);
  // Range: keep the frozen candidate while valid; only create a new one when none is live.
  let range = prevRange;
  if (range && !range.invalidated && m5.length) range = checkRangeValidity(range, m5[nowI], a5);
  if (!range || range.invalidated) {
    const fresh = Number.isFinite(a5) ? detectRange(m5, highs, lows, a5, cfg.regime, nowI) : null;
    if (fresh && (!range || fresh.id !== range.id)) range = fresh;
  }
  const h1Closes = h1.map((b) => b.c); const h1Atr = atr(h1, fc.atrPeriod);
  const h1Slope = emaSlopeAtr(h1Closes, fc.maSlopePeriod, fc.maSlopeLookback, h1Atr);
  const f: Features = {
    asOf: m5[nowI]?.t ?? 0, m1AsOf: m1[m1.length - 1]?.t ?? 0,
    atrM5: a5, atrM1: a1, atrPercentile: Number.isFinite(a5) ? percentileRank(a5, series) : NaN,
    efficiency: eff.value, efficiencyDefined: eff.defined,
    emaSlopeAtr: emaSlopeAtr(closes5, fc.maSlopePeriod, fc.maSlopeLookback, a5),
    bodyRatioMean: meanBodyRatio(m5, 10), overlapMean: meanOverlap(m5, 10),
    pivotsHigh: highs, pivotsLow: lows, structure: structureOf(highs, lows), range,
    spread: quote ? quote.ask - quote.bid : null, quoteAgeMs: quote ? inp.now - quote.receivedAt : null,
    h1Bias: !Number.isFinite(h1Slope) ? "unknown" : h1Slope > 0.2 ? "up" : h1Slope < -0.2 ? "down" : "flat",
    m15Structure: structureOf(p15.highs.filter((p) => p.confirmedAtIndex <= m15.length - 1), p15.lows.filter((p) => p.confirmedAtIndex <= m15.length - 1)),
  };
  return { f, rangeNext: range };
}

/**
 * One full evaluation: features → regime (with hysteresis) → three setup families → ranked decision.
 * Pure: no I/O. The caller supplies closed bars and the freshest executable quote.
 */
export function evaluate(inp: EvalInput, state: EngineState): EvalOutput {
  const t0 = performance.now();
  const { cfg } = inp;
  const { f, rangeNext } = computeFeatures(inp, state.range);
  const cls = classify(f, cfg.regime);
  const closedAt = f.asOf;
  const regime = closedAt !== state.lastM5T ? stepRegime(state.regime, cls, closedAt, cfg.regime) : (state.regime ?? stepRegime(null, cls, closedAt, cfg.regime));
  const rejections: Rejection[] = [];
  let setups = state.setups;
  const cands: Candidate[] = [];
  const stamp = (rs: Rejection[]) => rs.map((r) => ({ ...r, at: inp.now }));

  if (!inp.quote) {
    rejections.push({ at: inp.now, stage: "quote", code: "NO_BROKER_QUOTE", detail: "no executable broker quote — setups are not evaluated for entry" });
  } else if (inp.quote.bid <= 0 || inp.quote.ask <= inp.quote.bid) {
    rejections.push({ at: inp.now, stage: "quote", code: "BAD_QUOTE", detail: `bid ${inp.quote.bid} ask ${inp.quote.ask}` });
  } else {
    const ctx: SetupContext = { cfg, m1: inp.m1, m5: inp.m5, f, quote: inp.quote, tick: inp.tick, contractSize: inp.contractSize, now: inp.now, regime: regime.regime };
    // Higher-timeframe context is a WEIGHT, not a veto: only an H1 bias directly against the trade AND a
    // contrary M15 structure blocks a trend-pullback entry.
    const a = trendPullback(ctx);
    rejections.push(...stamp(a.rejections));
    if (a.candidate) {
      const against = (a.candidate.side === "buy" && f.h1Bias === "down" && f.m15Structure === "LH_LL") || (a.candidate.side === "sell" && f.h1Bias === "up" && f.m15Structure === "HH_HL");
      if (against) rejections.push({ at: inp.now, stage: "context", code: "HTF_AGAINST", detail: `H1 bias ${f.h1Bias} and M15 structure ${f.m15Structure} both oppose a ${a.candidate.side}`, family: "TREND_PULLBACK" });
      else cands.push(a.candidate);
    }
    const b = compressionBreakout(ctx, setups); setups = b.state; rejections.push(...stamp(b.rejections)); if (b.candidate) cands.push(b.candidate);
    const c = rangeRejection(ctx, setups); setups = c.state; rejections.push(...stamp(c.rejections)); if (c.candidate) cands.push(c.candidate);
  }

  // Ranking: highest net R:R; tie → family priority (pullback, breakout, range). Never stack.
  const prio = { TREND_PULLBACK: 0, COMPRESSION_BREAKOUT: 1, RANGE_REJECTION: 2 } as const;
  cands.sort((x, y) => (y.rewardRiskNet - x.rewardRiskNet) || (prio[x.family] - prio[y.family]));
  const fresh = cands.filter((c) => !setups.seen.includes(c.setupId));
  for (const c of cands.slice(1)) rejections.push({ at: inp.now, stage: "rank", code: "OUTRANKED", detail: `${c.family} outranked by ${cands[0].family} (net R:R ${c.rewardRiskNet.toFixed(2)} vs ${cands[0].rewardRiskNet.toFixed(2)})`, family: c.family });
  const chosen = fresh[0];
  if (chosen) setups = { ...setups, seen: [...setups.seen.slice(-50), chosen.setupId] };
  const decision: Decision = chosen ? { kind: "candidate", candidate: chosen, rejections } : { kind: "none", rejections };
  return { features: f, regime, decision, state: { regime, range: rangeNext, setups, lastM5T: closedAt }, computeMs: performance.now() - t0 };
}
