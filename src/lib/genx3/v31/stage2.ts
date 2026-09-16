/** GENX 3.1 Stage 2 — hard requirements, weighted confirmations and playbook-specific thresholds. */
import type { Cand, Playbook } from "./playbooks";
import type { Ctx, VolState } from "./context";

export type PlaybookRule = { enabled: boolean; minScore: number; exitR: number; vol: VolState[]; weights: Partial<Record<FeatureKey, number>> };
export type FeatureKey = "htf" | "h4" | "t15" | "conf" | "disp" | "wick" | "session" | "room" | "vol" | "regimeFit" | "cost";
export type Align = "none" | "htf" | "h4" | "m20" | "m20|h4" | "2of3";
export type Stage2Config = { version: string; costUsd: number; minRiskUsd: number; maxRiskUsd: number; minNetR: number; minRiskAtr15?: number; capRiskUsd?: number; align?: Align; sessions?: Ctx["session"][]; rules: Record<Playbook, PlaybookRule> };

const clamp = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const REGIME_FIT: Record<Playbook, Partial<Record<Ctx["regime"], number>>> = {
  TREND_PULLBACK: { TREND_UP: 1, TREND_DOWN: 1, TRANSITION: 0.5 },
  MOMENTUM_CONTINUATION: { TREND_UP: 1, TREND_DOWN: 1, TRANSITION: 0.6, COMPRESSION: 0.7 },
  BOS_PULLBACK: { TREND_UP: 1, TREND_DOWN: 1, TRANSITION: 0.7 },
  SWEEP_RECLAIM: { RANGE: 1, TRANSITION: 0.8, COMPRESSION: 0.6, TREND_UP: 0.5, TREND_DOWN: 0.5 },
  RANGE_REJECTION: { RANGE: 1, TRANSITION: 0.5 },
  FAILED_BREAKOUT: { RANGE: 1, TRANSITION: 0.8, COMPRESSION: 0.8 },
  COMPRESSION_BREAKOUT: { COMPRESSION: 1, TRANSITION: 0.7, RANGE: 0.6 },
  BREAKOUT_RETEST: { TREND_UP: 1, TREND_DOWN: 1, COMPRESSION: 0.8, TRANSITION: 0.7 },
  SESSION_BREAK: { COMPRESSION: 1, TRANSITION: 0.8, RANGE: 0.8, TREND_UP: 0.8, TREND_DOWN: 0.8 },
};

export function features(c: Cand, ctx: Ctx, costUsd: number): Record<FeatureKey, number> {
  const trendSide = c.side === "BUY" ? 1 : -1;
  const regimeFit = (REGIME_FIT[c.playbook][ctx.regime] ?? 0.2) * ((ctx.regime === "TREND_UP" && trendSide < 0) || (ctx.regime === "TREND_DOWN" && trendSide > 0) ? (/SWEEP|FAILED|RANGE/.test(c.playbook) ? 0.6 : 0.2) : 1);
  return {
    htf: (c.f.htf + 1) / 2, h4: (c.f.h4 + 1) / 2, t15: (c.f.t15 + 1) / 2,
    conf: clamp(c.f.conf ?? 0.5), disp: clamp(((c.f.disp ?? 1) - 0.5) / 1.5), wick: clamp(c.f.wick ?? 0.5),
    session: ctx.session === "LONDON" || ctx.session === "NY" ? 1 : ctx.session === "ASIA" ? 0.5 : 0.3,
    room: clamp((c.f.roomR ?? 3) / 3), vol: { NORMAL: 1, HIGH: 0.7, LOW: 0.6, EXTREME: 0 }[ctx.volState], regimeFit,
    cost: clamp(1 - (costUsd / c.risk) / 0.3),
  };
}

function aligned(c: Cand, a: Align): boolean {
  const htf = c.f.htf === 1, h4 = c.f.h4 === 1, m20 = c.f.m20 === 1;
  switch (a) { case "none": return true; case "htf": return htf; case "h4": return h4; case "m20": return m20; case "m20|h4": return m20 || h4; case "2of3": return +htf + +h4 + +m20 >= 2; }
}
export type Verdict = { ok: boolean; hardFail: string | null; score: number; threshold: number; components: Record<string, number> };
export function evaluate(c: Cand, ctx: Ctx, cfg: Stage2Config): Verdict {
  const rule = cfg.rules[c.playbook];
  const fx = features(c, ctx, cfg.costUsd);
  const w = rule.weights; const wsum = Object.values(w).reduce((a, b) => a + (b ?? 0), 0) || 1;
  const components: Record<string, number> = {};
  let raw = 0; for (const [k, v] of Object.entries(w)) { const pts = 100 * (v ?? 0) / wsum * fx[k as FeatureKey]; components[k] = +pts.toFixed(1); raw += pts; }
  const score = Math.round(raw);
  let hardFail: string | null = null;
  if (!rule.enabled) hardFail = "playbook_disabled";
  else if (ctx.volState === "EXTREME") hardFail = "volatility_extreme";
  else if (!rule.vol.includes(ctx.volState)) hardFail = `vol_state_${ctx.volState}_not_allowed`;
  else if (cfg.sessions && !cfg.sessions.includes(ctx.session)) hardFail = `session_${ctx.session}_not_allowed`;
  else if (!aligned(c, cfg.align ?? "none")) hardFail = `direction_not_aligned_${cfg.align}`;
  else if (cfg.minRiskAtr15 != null && c.risk < cfg.minRiskAtr15 * ctx.atr15) hardFail = "stop_inside_noise";
  else if (c.risk < cfg.minRiskUsd) hardFail = "stop_too_tight_for_cost";
  else if (c.risk > cfg.maxRiskUsd) hardFail = "stop_beyond_flow_cap";
  else if ((rule.exitR * c.risk - cfg.costUsd) / (c.risk + cfg.costUsd) < cfg.minNetR) hardFail = "net_opportunity_after_cost";
  return { ok: !hardFail && score >= rule.minScore, hardFail, score, threshold: rule.minScore, components };
}
