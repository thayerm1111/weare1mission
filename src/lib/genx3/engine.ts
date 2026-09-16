import { type Bar, aggregate, checkHealth, normalize1m, TF_MS, type DataHealth } from "./candles";
import { CONFIG, STRATEGY_VERSION } from "./config";
import { sessionLevels } from "./levels";
import { classifyRegime, type RegimeResult } from "./regime";
import { evaluatePlaybooks, type Candidate } from "./playbooks";
import { scoreCandidate, type Score } from "./score";
import { buildSignal, validateSignal, type Genx3Signal, stableUuid } from "./signal";

export type NewsState = "CLEAR" | "BLOCKED" | "UNKNOWN";
export type EngineInput = { raw1m: Bar[]; asOf: number; liveTick?: number | null; news: { state: NewsState; detail?: string } };
export type ScoredCandidate = Candidate & { score: Score | null; setupKey: string };
export type Decision = {
  strategyVersion: string; snapshotId: string; asOf: number;
  decisionCandleClose: number | null;            // close time of the newest CLOSED 5m bar
  health: DataHealth; regime: RegimeResult | null;
  candidates: ScoredCandidate[];
  signal: Genx3Signal | null;
  noTradeReasons: string[];
};

/** Pure, deterministic analysis. Same inputs → same decision (ids included). */
export function analyze(input: EngineInput): Decision {
  const { asOf } = input;
  const n = normalize1m(input.raw1m, asOf);
  const health = checkHealth({ closed1m: n.closed, asOf, maxFeedAgeMs: CONFIG.data.maxFeedAgeMs, maxGapBars: CONFIG.data.maxGap1mBars, spikeAtrMultiple: CONFIG.data.spikeAtrMultiple, duplicates: n.duplicates, outOfOrder: n.outOfOrder, invalid: n.invalid, liveTick: input.liveTick, feedDisagreeUsd: CONFIG.data.feedDisagreeUsd });
  const m5 = aggregate(n.closed, "5m", asOf), m15 = aggregate(n.closed, "15m", asOf), h1 = aggregate(n.closed, "1h", asOf), h4 = aggregate(n.closed, "4h", asOf);
  const decisionCandleClose = m5.length ? m5.at(-1)!.t + TF_MS["5m"] : null;
  const snapshotId = stableUuid(`snap:${STRATEGY_VERSION}:${decisionCandleClose}:${n.closed.at(-1)?.t ?? 0}:${n.closed.length}`);
  const base = { strategyVersion: STRATEGY_VERSION, snapshotId, asOf, decisionCandleClose, health };
  const reasons: string[] = [];
  if (health.state === "INVALID") reasons.push(`data_invalid: ${health.issues.join(",")}`);
  if (m15.length < CONFIG.data.minHistory15m) reasons.push(`insufficient_history_15m_${m15.length}`);
  if (h1.length < CONFIG.data.minHistory1h) reasons.push(`insufficient_history_1h_${h1.length}`);
  if (reasons.length) return { ...base, regime: null, candidates: [], signal: null, noTradeReasons: reasons };

  const regime = classifyRegime(m15, h1, h4, m5);
  if (!regime) return { ...base, regime: null, candidates: [], signal: null, noTradeReasons: ["regime_unavailable"] };
  if (regime.regime === "DISORDERED_NO_TRADE") reasons.push("regime_disordered");
  if (regime.regime === "TRANSITION") reasons.push("regime_transition_unconfirmed");
  if (regime.confidence < CONFIG.regime.minConfidence) reasons.push(`regime_confidence_${regime.confidence}`);
  if (input.news.state === "BLOCKED") reasons.push(`news_blackout${input.news.detail ? `: ${input.news.detail}` : ""}`);
  if (input.news.state === "UNKNOWN" && CONFIG.trade.newsFailClosed) reasons.push("news_state_unknown");

  const levels = sessionLevels(n.closed, asOf);
  const hourUtc = new Date(asOf).getUTCHours();
  const raw = evaluatePlaybooks({ m5, m15, h1, regime, levels, asOf });
  const candidates: ScoredCandidate[] = raw.map((c) => ({ ...c, setupKey: c.anchorKey, score: c.stage === "TRIGGERED" && !c.rejectReason ? scoreCandidate(c, regime, health, hourUtc) : null }));
  const triggered = candidates.filter((c) => c.stage === "TRIGGERED");
  if (!triggered.length) reasons.push("no_triggered_setup");
  const passing = triggered.filter((c) => !c.rejectReason && c.score && c.score.total >= c.score.threshold)
    .sort((a, b) => b.score!.total - a.score!.total);
  for (const t of triggered) {
    if (t.rejectReason) reasons.push(`${t.setupType}_${t.side}: ${t.rejectReason}`);
    else if (t.score && t.score.total < t.score.threshold) reasons.push(`${t.setupType}_${t.side}: score ${t.score.total} < ${t.score.threshold}`);
  }
  // Conflicting directions on the same bar → no trade.
  if (passing.length && passing.some((p) => p.side !== passing[0].side)) reasons.push("conflicting_setups_both_sides");
  const blocking = reasons.filter((r) => !/^no_triggered_setup$|^(TREND_PULLBACK|SWEEP_RECLAIM|BREAKOUT_RETEST|RANGE_REJECTION)_/.test(r));
  let signal: Genx3Signal | null = null;
  if (passing.length && !blocking.length && decisionCandleClose != null) {
    const best = passing[0];
    const cost = CONFIG.costs.spreadEstimateUsd + CONFIG.costs.slippageEstimateUsd;
    const s = buildSignal({ c: best, rg: regime, score: best.score!, setupKey: best.setupKey, snapshotId, decisionClose: decisionCandleClose, asOf, ttlMs: CONFIG.trade.setupTtlMin * 60_000, dataQuality: health.state, newsState: input.news.state, feedLatencyMs: health.feedAgeMs, spreadEstimate: CONFIG.costs.spreadEstimateUsd, cost });
    const errs = validateSignal(s);
    if (errs.length) reasons.push(`signal_invalid: ${errs.join(",")}`); else signal = s;
  }
  return { ...base, regime, candidates, signal, noTradeReasons: signal ? [] : reasons };
}
