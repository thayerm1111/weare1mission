import { createHash } from "node:crypto";
import { STRATEGY, STRATEGY_VERSION } from "./config";
import { XAUUSD, distance } from "./instrument";
import type { Candidate } from "./playbooks";
import type { RegimeResult } from "./regime";
import type { Score } from "./score";

export type Genx3Signal = {
  signal_id: string; setup_id: string; strategy: typeof STRATEGY; strategy_version: string;
  symbol_canonical: "XAUUSD"; broker_symbol: string; side: "BUY" | "SELL";
  setup_type: Candidate["setupType"]; regime: RegimeResult["regime"];
  created_at_utc: string; expires_at_utc: string; market_snapshot_id: string; decision_candle_close_time: string;
  entry_type: "LIMIT"; entry_price: number; entry_zone_low: number; entry_zone_high: number;
  stop_price: number; target_price: number;
  target_price_distance: number; target_ticks: number; target_points: number; target_display_pips: number;
  risk_price_distance: number; gross_reward_risk: number; estimated_net_reward_risk: number;
  confidence: number; score_components: Score; evidence: string[]; contradictions: string[]; invalidation_conditions: string[];
  spread_at_decision: number | null; spread_is_estimate: boolean; feed_latency_ms: number | null;
  data_quality: "HEALTHY" | "DEGRADED" | "INVALID"; news_state: "CLEAR" | "BLOCKED" | "UNKNOWN";
  idempotency_key: string; correlation_id: string; instrument_spec_version: string;
};

export function idempotencyKey(p: { setupKey: string; decisionClose: number; side: string; entry: number; stop: number; target: number }): string {
  return createHash("sha256").update([STRATEGY_VERSION, p.setupKey, p.decisionClose, p.side, p.entry.toFixed(2), p.stop.toFixed(2), p.target.toFixed(2)].join("|")).digest("hex");
}

/** Deterministic UUID-shaped id from a string (so a retry rebuilds the same ids). */
export function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function buildSignal(o: {
  c: Candidate; rg: RegimeResult; score: Score; setupKey: string; snapshotId: string; decisionClose: number; asOf: number;
  ttlMs: number; dataQuality: Genx3Signal["data_quality"]; newsState: Genx3Signal["news_state"]; feedLatencyMs: number | null; spreadEstimate: number; cost: number;
}): Genx3Signal {
  const { c } = o;
  const dT = distance(c.entry, c.target), dR = distance(c.entry, c.stop);
  const key = idempotencyKey({ setupKey: o.setupKey, decisionClose: o.decisionClose, side: c.side, entry: c.entry, stop: c.stop, target: c.target });
  return {
    signal_id: stableUuid(`sig:${key}`), setup_id: stableUuid(`setup:${STRATEGY_VERSION}:${o.setupKey}`),
    strategy: STRATEGY, strategy_version: STRATEGY_VERSION, symbol_canonical: "XAUUSD", broker_symbol: XAUUSD.brokerSymbol,
    side: c.side, setup_type: c.setupType, regime: o.rg.regime,
    created_at_utc: new Date(o.asOf).toISOString(), expires_at_utc: new Date(o.asOf + o.ttlMs).toISOString(),
    market_snapshot_id: o.snapshotId, decision_candle_close_time: new Date(o.decisionClose).toISOString(),
    entry_type: "LIMIT", entry_price: c.entry, entry_zone_low: c.zoneLow, entry_zone_high: c.zoneHigh,
    stop_price: c.stop, target_price: c.target,
    target_price_distance: dT.priceUsd, target_ticks: dT.ticks, target_points: dT.points, target_display_pips: dT.displayPips,
    risk_price_distance: dR.priceUsd, gross_reward_risk: +(dT.priceUsd / dR.priceUsd).toFixed(3),
    estimated_net_reward_risk: +((dT.priceUsd - o.cost) / (dR.priceUsd + o.cost)).toFixed(3),
    confidence: o.score.total, score_components: o.score, evidence: c.evidence, contradictions: c.contradictions, invalidation_conditions: c.invalidationConditions,
    spread_at_decision: o.spreadEstimate, spread_is_estimate: true, feed_latency_ms: o.feedLatencyMs,
    data_quality: o.dataQuality, news_state: o.newsState,
    idempotency_key: key, correlation_id: stableUuid(`corr:${key}`), instrument_spec_version: XAUUSD.specVersion,
  };
}

/** Schema validation — every field present, typed, and internally consistent. */
export function validateSignal(s: Genx3Signal): string[] {
  const e: string[] = [];
  const num = (k: keyof Genx3Signal) => { const v = s[k]; if (typeof v !== "number" || !Number.isFinite(v)) e.push(`${String(k)} not a finite number`); };
  (["entry_price", "entry_zone_low", "entry_zone_high", "stop_price", "target_price", "risk_price_distance", "target_price_distance", "gross_reward_risk", "confidence"] as const).forEach(num);
  if (s.strategy !== STRATEGY || s.strategy_version !== STRATEGY_VERSION) e.push("strategy/version mismatch");
  if (s.side !== "BUY" && s.side !== "SELL") e.push("side invalid");
  if (!/^[0-9a-f]{64}$/.test(s.idempotency_key)) e.push("idempotency_key invalid");
  if (s.entry_zone_low > s.entry_zone_high) e.push("zone inverted");
  const up = s.side === "BUY";
  if (up ? !(s.stop_price < s.entry_price && s.target_price > s.entry_price) : !(s.stop_price > s.entry_price && s.target_price < s.entry_price)) e.push("stop/target on the wrong side of entry");
  if (s.data_quality !== "HEALTHY") e.push("data not healthy");
  if (s.news_state !== "CLEAR") e.push("news not clear");
  if (Date.parse(s.expires_at_utc) <= Date.parse(s.created_at_utc)) e.push("expiry not after creation");
  if (!s.evidence.length) e.push("no evidence");
  return e;
}
