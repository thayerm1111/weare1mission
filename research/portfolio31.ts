/** Portfolio replay of GENX 3.1 with Flow's execution rules. Same Stage 1/Stage 2 code as production. */
import { readFileSync, writeFileSync } from "node:fs";
import { buildSeries, lastClosed } from "../src/lib/genx3/v31/series";
import { step, newState } from "../src/lib/genx3/v31/engine";
import type { Stage2Config } from "../src/lib/genx3/v31/stage2";
import { simulate, type B } from "./sim";

export type Trade = { t: number; pb: string; side: string; regime: string; vol: string; sess: string; score: number; risk: number; pnlUsd: number; r: number; result: string; mfeR: number; maeR: number; holdMin: number };
export function runPortfolio(all: B[], cfg: Stage2Config, from: number, to: number, opts: { latencyMin?: number; chaseUsd?: number; restingMin?: number; costUsd?: number; early?: boolean; maxHoldH?: number } = {}) {
  const s = buildSeries(all);
  const latency = opts.latencyMin ?? 1, chase = opts.chaseUsd ?? 1, resting = opts.restingMin ?? 3, cost = opts.costUsd ?? cfg.costUsd;
  const trades: Trade[] = [];
  const funnel: Record<string, number> = {};
  const inc = (k: string) => { funnel[k] = (funnel[k] ?? 0) + 1; };
  const seen = new Set<string>();
  let busyUntil = 0;
  const lastStops: Record<string, number[]> = { BUY: [], SELL: [] };
  const lastWin: Record<string, number> = { BUY: -1e15, SELL: -1e15 };
  const start = Math.ceil(from / 300000) * 300000;
  const st = newState();
  const step0 = opts.early ? 60000 : 300000;
  for (let asOf = start; asOf <= to; asOf += step0) {
    const r = step(s, asOf, cfg, st, { early: !!opts.early });
    if (r.kind === "5m" && r.ctx) inc("cycles");
    for (const x of r.scored) { inc(`cand:${x.c.playbook}`); if (!x.v.ok) inc(`reject:${x.v.hardFail ?? "score_below_threshold"}`); else inc(`pass:${x.c.playbook}`); }
    if (r.reasons.includes("entry_blackout_window")) inc("flow:reopen_or_weekend_blackout");
    if (!r.best) continue;
    const ctx = r.ctx!;
    const best = { c: r.best.c, score: r.best.v.score };
    const { c, score } = best;
    if (asOf < busyUntil) { inc("flow:one_entry"); continue; }
    const ls = lastStops[c.side].filter((x) => asOf - x < 2 * 3600000);
    if (ls.length >= 2) { inc("flow:two_strikes_pause"); continue; }
    if (asOf - lastWin[c.side] < 15 * 60000) { inc("flow:post_win_pause"); continue; }
    if (asOf - lastWin[c.side] < 90 * 60000 && score < 68) { inc("flow:post_win_premium_only"); continue; }
    inc("published");
    const dir = c.side === "BUY" ? 1 : -1;
    const rule = cfg.rules[c.playbook];
    const startIdx = lastClosed(s.m1, asOf + latency * 60000) + 1;
    // Flow: GTC limit at the signal zone edge ± chase, cancelled after `resting` minutes.
    const limitEdge = c.entryType === "LIMIT" ? c.entry - dir * chase : c.entry;
    const target = +(c.entry + dir * rule.exitR * c.risk).toFixed(2);
    const simIn = { side: c.side, startIdx, entry: c.entry, zoneLow: limitEdge, zoneHigh: limitEdge, stop: c.stop, target, ttlMs: resting * 60000, maxHoldMs: (opts.maxHoldH ?? 24) * 3600000, chaseUsd: chase, costUsd: cost };
    let sim = simulate(all, simIn);
    if (!sim.filled) { inc(`missed:${sim.missReason}`); continue; }
  if (sim.open) continue;
    let risk = Math.abs(sim.fill! - c.stop);
    if (risk > 10) { inc("flow:stop_capped_to_100_pips"); sim = simulate(all, { ...simIn, stop: +(sim.fill! - dir * 10).toFixed(2) }); if (!sim.filled) continue; risk = 10; }
    // Position size is fixed when the order is placed, from the signal entry to the stop (Flow sizing), so
    // results are measured in units of that planned risk, not the (sometimes smaller) fill-to-stop distance.
    const sizeRisk = Math.min(10, Math.max(c.risk, 0.01));
    busyUntil = sim.exitAt!;
    if (sim.result === "stop") lastStops[c.side].push(sim.exitAt!); else if (sim.pnl! > 0) { lastWin[c.side] = sim.exitAt!; lastStops[c.side] = []; }
    inc(`result:${sim.result}`); if (c.f.early) inc("early_entries");
    trades.push({ t: asOf, pb: c.playbook, side: c.side, regime: ctx.regime, vol: ctx.volState, sess: ctx.session, score, risk: +risk.toFixed(2), pnlUsd: sim.pnl!, r: +(sim.pnl! / sizeRisk).toFixed(3), result: sim.result!, mfeR: +(sim.mfe! / sizeRisk).toFixed(2), maeR: +(sim.mae! / sizeRisk).toFixed(2), holdMin: sim.holdMin! });
  }
  return { trades, funnel };
}

export function summary(tr: Trade[], weeks: number) {
  const r = tr.map((t) => t.r); const n = r.length;
  if (!n) return { n: 0 };
  const w = r.filter((x) => x > 0), l = r.filter((x) => x <= 0);
  const gw = w.reduce((a, b) => a + b, 0), gl = -l.reduce((a, b) => a + b, 0);
  let cum = 0, pk = 0, dd = 0, st = 0, ms = 0; for (const x of r) { cum += x; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); st = x <= 0 ? st + 1 : 0; ms = Math.max(ms, st); }
  const mean = cum / n, sd = Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const days: Record<string, number> = {}; for (const t of tr) { const k = new Date(t.t).toISOString().slice(0, 10); days[k] = (days[k] ?? 0) + t.r; }
  const bestDay = Math.max(...Object.values(days));
  return { n, perWeek: +(n / weeks).toFixed(1), winRate: +(w.length / n * 100).toFixed(1), avgWinR: +(gw / Math.max(1, w.length)).toFixed(2), avgLossR: +(-gl / Math.max(1, l.length)).toFixed(2), expR: +mean.toFixed(3), seR: +(sd / Math.sqrt(n)).toFixed(3), pf: +(gw / Math.max(gl, 1e-9)).toFixed(2), netR: +cum.toFixed(1), maxDDR: +dd.toFixed(1), maxConsecLoss: ms, bestDayShareOfNet: cum > 0 ? +(bestDay / cum).toFixed(2) : null, avgMfeR: +(tr.reduce((a, t) => a + t.mfeR, 0) / n).toFixed(2), avgMaeR: +(tr.reduce((a, t) => a + t.maeR, 0) / n).toFixed(2) };
}

if (process.argv[1]?.endsWith("portfolio31.ts")) {
  const [, , file, cfgFile, fromS, toS, outFile] = process.argv;
  const all: B[] = (JSON.parse(readFileSync(file, "utf8")) as number[][]).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const cfg = JSON.parse(readFileSync(cfgFile, "utf8")) as Stage2Config;
  const from = fromS ? Date.parse(fromS) : all[0].t + 22 * 86400000, to = toS ? Date.parse(toS) : all.at(-1)!.t;
  const r = runPortfolio(all, cfg, from, to, { early: process.env.EARLY === "1" });
  const weeks = (to - from) / (7 * 86400000);
  const by = (k: keyof Trade) => Object.fromEntries([...new Set(r.trades.map((t) => String(t[k])))].map((v) => [v, summary(r.trades.filter((t) => String(t[k]) === v), weeks)]));
  if (outFile) writeFileSync(outFile, JSON.stringify(r.trades));
  console.log(JSON.stringify({ range: [new Date(from).toISOString(), new Date(to).toISOString()], all: summary(r.trades, weeks), funnel: r.funnel, byPlaybook: by("pb"), byRegime: by("regime"), bySession: by("sess"), bySide: by("side"), byVol: by("vol") }, null, 1));
}
