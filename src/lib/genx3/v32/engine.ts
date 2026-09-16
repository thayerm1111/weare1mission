/**
 * GENX 3.2 decision step — MARKET DATA → MARKET STATE → SETUP ENGINES → CANDIDATES → HARD
 * INVALIDATION → SETUP-SPECIFIC SCORE → ARBITRATION → (one) SIGNAL. Same code in live and replay.
 * The 3.1.0 baseline (SESSION_BREAK, BOS_PULLBACK) is produced by the untouched 3.1 generator and
 * 3.1 Stage 2 at 5m closes, exactly as in 3.1.0.
 */
import { lastClosed, goldMarketOpen, type Series } from "../v31/series";
import { buildContext, type Ctx } from "../v31/context";
import { generate } from "../v31/playbooks";
import { evaluate as evaluate31 } from "../v31/stage2";
import { CONFIG31 } from "../v31/config";
import { entryBlackout } from "../v31/engine";
import { classifyState, type StateResult } from "./state";
import { microContinuation, breakoutRetest, compressionExpansion, sweepReclaimDisplacement, trendReentry, momentumExpansion, type Cand32, type Wait32, type Setup32 } from "./engines";
import { CONFIG32 } from "./config";

export type Status32 = "PASSED" | "FAILED" | "WAITED" | "EXPIRED" | "INVALIDATED" | "LOST_ARBITRATION" | "NOT_ROUTED" | "SHADOW_ONLY" | "SELECTED";
export type Record32 = { setup: Setup32; side: "BUY" | "SELL"; anchor: string; status: Status32; reasons: string[]; score: number | null; threshold: number | null; components: Record<string, number>; cand: Cand32 | null };
export type State32 = { seen: Set<string>; prevCompression: StateResult["compression"]; prevCompressionAt: number };
export const newState32 = (): State32 => ({ seen: new Set(), prevCompression: null, prevCompressionAt: 0 });
export type Step32 = { asOf: number; ctx: Ctx | null; state: StateResult | null; records: Record32[]; selected: Record32 | null; reasons: string[] };

function score(c: Cand32): { score: number; components: Record<string, number> } {
  const w = CONFIG32.rules[c.setup].weights; const tot = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const components: Record<string, number> = {}; let s = 0;
  for (const [k, wt] of Object.entries(w)) { const pts = (100 * wt / tot) * Math.max(0, Math.min(1, c.feats[k] ?? 0)); components[k] = +pts.toFixed(1); s += pts; }
  return { score: Math.round(s), components };
}

function hardChecks(c: Cand32, ctx: Ctx): string[] {
  const r = CONFIG32.rules[c.setup], f: string[] = [...c.hard];
  if (ctx.volState === "EXTREME") f.push("volatility EXTREME — execution unreliable");
  if (c.risk > CONFIG32.maxRiskUsd) f.push(`stop $${c.risk.toFixed(2)} beyond the $${CONFIG32.maxRiskUsd} corrupt-data bound`);
  else if (c.risk > CONFIG32.maxRiskAtr15 * ctx.atr15) f.push(`stop $${c.risk.toFixed(2)} wider than ${CONFIG32.maxRiskAtr15}×ATR15 ($${(CONFIG32.maxRiskAtr15 * ctx.atr15).toFixed(2)}) — not a sane structure for current volatility`);
  if (c.risk < Math.max(CONFIG32.minRiskUsd, r.minRiskAtr15 * ctx.atr15)) f.push(`stop $${c.risk.toFixed(2)} inside noise (min ${Math.max(CONFIG32.minRiskUsd, r.minRiskAtr15 * ctx.atr15).toFixed(2)})`);
  const net = (c.targetR * c.risk - CONFIG32.costUsd) / (c.risk + CONFIG32.costUsd);
  if (net < CONFIG32.minNetRR) f.push(`net reward:risk ${net.toFixed(2)} after costs < ${CONFIG32.minNetRR}`);
  if (c.roomR < r.minRoomR) f.push(`only ${c.roomR.toFixed(2)}R of structural room (needs ${r.minRoomR}R)`);
  else if (c.roomR < c.targetR * 0.8) f.push(`target ${c.targetR}R is beyond structural room ${c.roomR.toFixed(2)}R`);
  return f;
}

export function step32(s: Series, asOf: number, st: State32): Step32 {
  const i1 = lastClosed(s.m1, asOf);
  if (i1 < 0 || asOf - (s.m1.bars[i1].t + 60000) > 5 * 60000 || !goldMarketOpen(asOf - 60000)) return { asOf, ctx: null, state: null, records: [], selected: null, reasons: ["market_closed_or_stale"] };
  const ctx = buildContext(s, asOf);
  if (!ctx) return { asOf, ctx: null, state: null, records: [], selected: null, reasons: ["insufficient_history"] };
  const state = classifyState(s, ctx);
  if (state.compression) { st.prevCompression = state.compression; st.prevCompressionAt = asOf; }
  else if (asOf - st.prevCompressionAt > 45 * 60000) st.prevCompression = null;
  const records: Record32[] = [];
  const isFive = asOf % 300000 === 0;

  // 3.1 baseline — unchanged, 5m closes only
  if (isFive) for (const c of generate(s, ctx)) {
    if (c.playbook !== "SESSION_BREAK" && c.playbook !== "BOS_PULLBACK") continue;
    if (st.seen.has(c.anchor)) continue;
    st.seen.add(c.anchor);
    // 3.1 baseline rules unchanged except the stop ceiling, which follows the 3.2.1 strategy-stop policy
    const v = evaluate31(c, ctx, { ...CONFIG31, maxRiskUsd: Math.min(CONFIG32.maxRiskUsd, CONFIG32.maxRiskAtr15 * ctx.atr15) });
    const d = c.side === "BUY" ? 1 : -1, rule = CONFIG31.rules[c.playbook];
    const cand: Cand32 = { setup: c.playbook, side: c.side, anchor: c.anchor, entry: c.entry, invalidation: c.invalidation, stop: c.stop, risk: c.risk, targetR: rule.exitR, target: +(c.entry + d * rule.exitR * c.risk).toFixed(2), roomR: c.f.roomR ?? 5, feats: c.f, evidence: c.evidence, hard: [] };
    records.push({ setup: c.playbook, side: c.side, anchor: c.anchor, status: v.ok ? "PASSED" : "FAILED", reasons: v.ok ? [] : [v.hardFail ?? `score ${v.score} < ${v.threshold}`], score: v.score, threshold: v.threshold, components: v.components, cand });
  }

  // new engines — every closed minute, routed by market state
  const outs = [microContinuation(s, ctx, state), breakoutRetest(s, ctx), compressionExpansion(s, ctx, state, st.prevCompression), sweepReclaimDisplacement(s, ctx), trendReentry(s, ctx, state), momentumExpansion(s, ctx)];
  const waits: Wait32[] = outs.flatMap((o) => o.waits);
  for (const w of waits) if (!st.seen.has(w.anchor)) records.push({ setup: w.setup, side: w.side, anchor: w.anchor, status: "WAITED", reasons: [w.reason], score: null, threshold: null, components: {}, cand: null });
  for (const c of outs.flatMap((o) => o.cands)) {
    if (st.seen.has(c.anchor)) continue;
    st.seen.add(c.anchor);
    const rule = CONFIG32.rules[c.setup];
    const routed = rule.states === "ANY" || rule.states.includes(state.state);
    const hard = hardChecks(c, ctx);
    const sc = score(c);
    let status: Status32 = "PASSED"; const reasons: string[] = [];
    if (!routed) { status = "NOT_ROUTED"; reasons.push(`market state ${state.state} not routed to ${c.setup}`); }
    else if (hard.length) { status = "FAILED"; reasons.push(...hard); }
    else if (sc.score < rule.threshold) { status = "FAILED"; reasons.push(`score ${sc.score} < ${rule.threshold}`); }
    records.push({ setup: c.setup, side: c.side, anchor: c.anchor, status, reasons, score: sc.score, threshold: rule.threshold, components: sc.components, cand: c });
  }
  if (st.seen.size > 50000) st.seen = new Set([...st.seen].slice(-20000));

  // arbitration — deterministic: live setups only; margin over threshold, then priority, then room, then anchor
  const passed = records.filter((r) => r.status === "PASSED");
  for (const r of passed) if (CONFIG32.rules[r.setup].mode === "SHADOW") { r.status = "SHADOW_ONLY"; r.reasons.push("setup is in SHADOW mode"); }
  const live = passed.filter((r) => r.status === "PASSED");
  const margin = (r: Record32) => (r.score ?? 0) - (r.threshold ?? 0);
  live.sort((a, b) => (CONFIG32.priority.indexOf(a.setup) < 2 ? 0 : 1) - (CONFIG32.priority.indexOf(b.setup) < 2 ? 0 : 1)   // 3.1 baseline first (it is the proven-longest path)
    || margin(b) - margin(a) || CONFIG32.priority.indexOf(a.setup) - CONFIG32.priority.indexOf(b.setup) || (b.cand!.roomR - a.cand!.roomR) || a.anchor.localeCompare(b.anchor));
  const reasons: string[] = [];
  let selected: Record32 | null = live[0] ?? null;
  if (selected) {
    const opp = live.find((r) => r.side !== selected!.side);
    if (opp && Math.abs(margin(opp) - margin(selected)) <= CONFIG32.conflictMargin && CONFIG32.priority.indexOf(selected.setup) >= 2) {
      reasons.push(`conflict: ${selected.setup} ${selected.side} vs ${opp.setup} ${opp.side} — no trade`);
      for (const r of live) { r.status = "LOST_ARBITRATION"; r.reasons.push("opposite-side conflict"); }
      selected = null;
    } else for (const r of live.slice(1)) { r.status = "LOST_ARBITRATION"; r.reasons.push(`lost to ${selected.setup} (${selected.anchor})`); }
  }
  if (selected && entryBlackout(asOf)) { selected.status = "FAILED"; selected.reasons.push("entry blackout window (Flow reopen / Friday close / Sunday open)"); reasons.push("entry_blackout_window"); selected = null; }
  if (selected) selected.status = "SELECTED";
  if (!records.length) reasons.push("no_candidate");
  return { asOf, ctx, state, records, selected, reasons };
}
