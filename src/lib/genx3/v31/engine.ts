/**
 * GENX 3.1 decision engine — the ONE function used by production and by every replay.
 * Stage 1 (generate / generateArmed / earlyTrigger) → Stage 2 (evaluate) → best candidate.
 * Stateful pieces (anchors already used, armed setups) live in `EngineState`, which production
 * keeps in memory (and mirrors to the DB) and replay keeps per run.
 */
import { buildSeries, lastClosed, goldMarketOpen, type Series } from "./series";
import { buildContext, type Ctx } from "./context";
import { generate, generateArmed, earlyTrigger, type Armed, type Cand } from "./playbooks";
import { evaluate, type Stage2Config, type Verdict } from "./stage2";
import type { Bar } from "../candles";

export const STRATEGY_VERSION_31 = "3.1.0";
export type EngineState = { seen: Set<string>; armed: Armed[]; lastCtx: Ctx | null };
export const newState = (): EngineState => ({ seen: new Set(), armed: [], lastCtx: null });

const fmtNY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" });
const nyCache = new Map<number, boolean>();
/** No new entries: Flow's daily reopen blackout (16:45–19:00 NY), the last hour before the Friday
 *  close (from 16:00 NY Friday), the first hour after the Sunday open (to 19:00 NY Sunday), weekend. */
export function entryBlackout(t: number): boolean {
  const k = Math.floor(t / 60000); const c = nyCache.get(k); if (c != null) return c;
  const p = fmtNY.formatToParts(new Date(t)); const g = (x: string) => p.find((q) => q.type === x)!.value;
  const mins = (Number(g("hour")) % 24) * 60 + Number(g("minute")); const wd = g("weekday");
  const v = (mins >= 16 * 60 + 45 && mins < 19 * 60) || (wd === "Fri" && mins >= 16 * 60) || wd === "Sat" || (wd === "Sun" && mins < 19 * 60);
  if (nyCache.size > 200000) nyCache.clear(); nyCache.set(k, v); return v;
}

export type Scored = { c: Cand; v: Verdict };
export type Step = { asOf: number; kind: "5m" | "1m"; ctx: Ctx | null; scored: Scored[]; best: Scored | null; reasons: string[] };

/** Evaluate one closed minute. At 5m closes: full context, confirmed candidates, re-arm. Other minutes: early triggers only. */
export function step(s: Series, asOf: number, cfg: Stage2Config, st: EngineState, opts: { early: boolean; newsBlocked?: boolean }): Step {
  const reasons: string[] = [];
  const i1 = lastClosed(s.m1, asOf);
  const isFive = asOf % 300000 === 0;
  if (i1 < 0 || asOf - (s.m1.bars[i1].t + 60000) > 5 * 60000 || !goldMarketOpen(asOf - 60000)) return { asOf, kind: isFive ? "5m" : "1m", ctx: null, scored: [], best: null, reasons: ["market_closed_or_stale"] };
  let ctx: Ctx | null; let cands: Cand[];
  if (isFive) {
    ctx = buildContext(s, asOf);
    if (!ctx) return { asOf, kind: "5m", ctx: null, scored: [], best: null, reasons: ["insufficient_history"] };
    st.lastCtx = ctx;
    cands = generate(s, ctx);
    st.armed = opts.early ? generateArmed(s, ctx).filter((a) => !st.seen.has(a.anchor)) : [];
  } else {
    if (!opts.early || !st.lastCtx || !st.armed.length) return { asOf, kind: "1m", ctx: null, scored: [], best: null, reasons: [] };
    ctx = { ...st.lastCtx, asOf, i1 };
    cands = st.armed.map((a) => earlyTrigger(s, ctx!, a, i1)).filter((c): c is Cand => !!c);
    st.armed = st.armed.filter((a) => !cands.some((c) => c.anchor === a.anchor) && asOf <= a.expiresAt);
  }
  cands = cands.filter((c) => { if (st.seen.has(c.anchor)) return false; st.seen.add(c.anchor); return true; });
  // Flow caps every gold stop at 100 pips ($10). When the structural stop is wider (but within
  // maxRiskUsd), GENX publishes the capped stop itself so targets are measured from the real risk.
  if (cfg.capRiskUsd != null) cands = cands.map((c) => {
    if (c.risk <= cfg.capRiskUsd! || c.risk > cfg.maxRiskUsd) return c;
    const d = c.side === "BUY" ? 1 : -1;
    return { ...c, stop: +(c.entry - d * cfg.capRiskUsd!).toFixed(2), risk: cfg.capRiskUsd!, evidence: [...c.evidence, `structural stop $${c.risk.toFixed(2)} capped to $${cfg.capRiskUsd} (Flow 100-pip cap)`], f: { ...c.f, capped: 1 } };
  });
  if (st.seen.size > 50000) st.seen = new Set([...st.seen].slice(-20000));
  const scored = cands.map((c) => ({ c, v: evaluate(c, ctx!, cfg) }));
  let best: Scored | null = null;
  for (const x of scored) if (x.v.ok && (!best || x.v.score > best.v.score)) best = x;
  if (!cands.length) reasons.push("no_candidate");
  else if (!best) reasons.push(...[...new Set(scored.map((x) => x.v.hardFail ?? `score_${x.v.score}_below_${x.v.threshold}`))]);
  if (best && entryBlackout(asOf)) { reasons.push("entry_blackout_window"); best = null; }
  if (best && opts.newsBlocked) { reasons.push("news_blackout"); best = null; }
  return { asOf, kind: isFive ? "5m" : "1m", ctx, scored, best, reasons };
}

export { buildSeries };
export type { Bar };
