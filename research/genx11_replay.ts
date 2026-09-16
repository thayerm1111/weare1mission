/** Replay of GENX 1.1 (same execution model as research/genx1_replay.ts). */
import { readFileSync, writeFileSync } from "node:fs";
import { buildSeries } from "../src/lib/genx3/v31/series";
import { step11, newState11, type Setup11 } from "../src/lib/genx11/engine";
import { simulate, type B } from "../src/lib/genx3/v32/sim";
import { entryBlackout } from "../src/lib/genx3/v31/engine";

const [, , file, fromS, toS, out] = process.argv;
const all: B[] = (JSON.parse(readFileSync(file, "utf8")) as number[][]).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const s = buildSeries(all);
const from = Date.parse(fromS), to = Date.parse(toS);
const lower = (x: number) => { let lo = 0, hi = all.length; while (lo < hi) { const m = (lo + hi) >> 1; if (all[m].t < x) lo = m + 1; else hi = m; } return lo; };
const st = newState11();
type P = Setup11 & { t: number; state: string };
let pending: P[] = [];
const trades: Record<string, unknown>[] = []; const funnel: Record<string, number> = {}; const inc = (k: string) => { funnel[k] = (funnel[k] ?? 0) + 1; };
let busyUntil = 0; const lastStops: Record<string, number[]> = { BUY: [], SELL: [] }; const lastWin: Record<string, number> = { BUY: -1e15, SELL: -1e15 };
function take(p: P, asOf: number, market: boolean) {
  if (asOf < busyUntil) { inc("flow:one_entry"); return; }
  if (lastStops[p.side].filter((x) => asOf - x < 2 * 3600000).length >= 2) { inc("flow:two_strikes"); return; }
  if (asOf - lastWin[p.side] < 15 * 60000) { inc("flow:post_win_pause"); return; }
  if (entryBlackout(asOf)) { inc("flow:blackout"); return; }
  inc("signals");
  const startIdx = lower(asOf + 60000);
  const entry = market ? all[startIdx - 1]?.c ?? p.entry : (p.side === "BUY" ? p.zoneHigh : p.zoneLow);
  const planned = Math.abs(entry - p.stop);
  if (!(planned > 0) || planned > 60) return;
  const sim = simulate(all, { side: p.side, startIdx, entry, zoneLow: entry, zoneHigh: entry, stop: p.stop, target: p.target, ttlMs: 3 * 60000, maxHoldMs: 24 * 3600000, chaseUsd: 1, costUsd: 0.5 });
  if (!sim.filled || sim.open) { inc(`missed:${sim.missReason ?? "open"}`); return; }
  inc("fills"); inc(`fills:${p.engine}`); busyUntil = sim.exitAt!;
  if (sim.result === "stop") lastStops[p.side].push(sim.exitAt!); else if (sim.pnl! > 0) { lastWin[p.side] = sim.exitAt!; lastStops[p.side] = []; }
  trades.push({ t: asOf, engine: p.engine, strategy: p.strategy, state: p.state, side: p.side, score: p.score, risk: +planned.toFixed(2), rrTp: +(Math.abs(p.target - entry) / planned).toFixed(2), result: sim.result, r: +(sim.pnl! / planned).toFixed(3) });
}
const t0 = Date.now();
for (let asOf = Math.ceil(from / 60000) * 60000; asOf <= to; asOf += 60000) {
  const i1 = lower(asOf); if (i1 < 1 || asOf - (all[i1 - 1].t + 60000) > 5 * 60000) { pending = []; continue; }
  const bar = all[i1 - 1];
  for (const p of [...pending]) {
    const crossed = p.side === "BUY" ? bar.l <= p.stop : bar.h >= p.stop;
    if (crossed || asOf - p.t > 8 * 3600000) { pending = pending.filter((x) => x !== p); continue; }
    if (bar.l <= p.zoneHigh + 0.2 && bar.h >= p.zoneLow - 0.2) { pending = pending.filter((x) => x !== p); take(p, asOf, false); }
  }
  if (asOf % 300000 !== 0) continue;
  const r = step11(s, asOf, st);
  inc("scans"); inc(`state:${r.state}`);
  // a state flip cancels resting GENX 1.0 zones from the previous state
  pending = pending.filter((p) => p.state === r.state);
  for (const x of r.setups) { inc(`setup:${x.engine}:${x.kind}`); const p = { ...x, t: asOf, state: r.state }; if (x.kind === "READY") take(p, asOf, true); else pending.push(p); }
}
writeFileSync(out, JSON.stringify({ funnel, trades }));
console.log(JSON.stringify({ ms: Date.now() - t0, funnel }));
