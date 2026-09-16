import type { Candidate } from "./playbooks";
import type { RegimeResult } from "./regime";
import type { DataHealth } from "./candles";
import { CONFIG } from "./config";

export type ScoreComponent = { key: string; points: number; max: number; evidence: string };
export type Score = { total: number; threshold: number; components: ScoreComponent[]; penalties: ScoreComponent[]; version: string };

const clamp01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

/** Transparent 0–100 quality score. Max points per component sum to 100 before penalties. */
export function scoreCandidate(c: Candidate, rg: RegimeResult, health: DataHealth, hourUtc: number): Score {
  const up = c.side === "BUY";
  const reward = Math.abs(c.target - c.entry), risk = Math.abs(c.entry - c.stop) || 1;
  const cost = CONFIG.costs.spreadEstimateUsd + CONFIG.costs.slippageEstimateUsd;
  const htfAgree = (up && rg.bias1h === "UP") || (!up && rg.bias1h === "DOWN");
  const htfOppose = (up && rg.bias1h === "DOWN") || (!up && rg.bias1h === "UP");
  const reversal = c.setupType === "SWEEP_RECLAIM" || c.setupType === "RANGE_REJECTION";
  const htf = htfAgree ? 1 : htfOppose ? (reversal ? 0.35 : 0) : 0.6;
  const volRatio = Number(rg.features.volRatio ?? 1);
  const volOk = volRatio >= 0.7 && volRatio <= 1.6 ? 1 : volRatio < 0.5 || volRatio > 2 ? 0.2 : 0.6;
  const session = hourUtc >= 7 && hourUtc < 17 ? 1 : hourUtc >= 0 && hourUtc < 7 ? 0.7 : 0.5; // London/NY best; Asia fair; late US weakest
  const comps: ScoreComponent[] = [
    { key: "htf_context", max: 12, points: 12 * htf, evidence: `1H ${rg.bias1h}, 4H ${rg.env4h}` },
    { key: "regime_certainty", max: 10, points: 10 * clamp01((rg.confidence - 40) / 50), evidence: `${rg.regime} ${rg.confidence}` },
    { key: "structure_quality", max: 12, points: 12 * (rg.contradicting.length ? 0.6 : 1), evidence: rg.supporting.join("; ") },
    { key: "location", max: 12, points: 12 * clamp01(c.location), evidence: c.evidence[0] ?? "" },
    { key: "candle_confirmation", max: 10, points: 10 * clamp01(c.confirmation), evidence: c.evidence.find((e) => /close/.test(e)) ?? "" },
    { key: "momentum", max: 8, points: 8 * clamp01(c.momentum), evidence: `vol ratio ${volRatio}` },
    { key: "target_space", max: 12, points: 12 * clamp01((reward / risk - 1) / 1.5), evidence: `R:R ${(reward / risk).toFixed(2)}, $${reward.toFixed(2)}` },
    { key: "volatility", max: 8, points: 8 * volOk, evidence: `ATR15 $${rg.atr15.toFixed(2)}` },
    { key: "transaction_cost", max: 6, points: 6 * clamp01(1 - cost / Math.max(reward, 0.01) * 3), evidence: `cost est $${cost.toFixed(2)}` },
    { key: "data_quality", max: 5, points: health.state === "HEALTHY" ? 5 : health.state === "DEGRADED" ? 2 : 0, evidence: health.state },
    { key: "session", max: 5, points: 5 * session, evidence: `${hourUtc}:00 UTC` },
  ];
  const penalties: ScoreComponent[] = [];
  if (c.contradictions.length) penalties.push({ key: "contradictions", max: 0, points: -Math.min(15, 5 * c.contradictions.length), evidence: c.contradictions.join("; ") });
  const raw = comps.reduce((a, x) => a + x.points, 0) + penalties.reduce((a, x) => a + x.points, 0);
  return { total: Math.max(0, Math.min(100, Math.round(raw))), threshold: CONFIG.trade.minScore, components: comps.map((x) => ({ ...x, points: +x.points.toFixed(1) })), penalties, version: CONFIG.version };
}
