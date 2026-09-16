/** One-shot diagnostic replay for GENX 3.2 (same step32 as production) with Flow execution rules.
 *  History is contaminated for model selection: this is regression/diagnostics only. */
import { readFileSync, writeFileSync } from "node:fs";
import { buildSeries, lastClosed } from "../src/lib/genx3/v31/series";
import { step32, newState32 } from "../src/lib/genx3/v32/engine";
import { CONFIG32 } from "../src/lib/genx3/v32/config";
import { simulate, type B } from "./sim";

const [, , file, fromS, toS, out] = process.argv;
const all: B[] = (JSON.parse(readFileSync(file, "utf8")) as number[][]).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const s = buildSeries(all);
const from = Date.parse(fromS), to = Date.parse(toS);
const st = newState32();
const funnel: Record<string, number> = {}; const inc = (k: string, n = 1) => { funnel[k] = (funnel[k] ?? 0) + n; };
const trades: Record<string, unknown>[] = []; const shadow: Record<string, unknown>[] = [];
let busyUntil = 0; const lastStops: Record<string, number[]> = { BUY: [], SELL: [] }; const lastWin: Record<string, number> = { BUY: -1e15, SELL: -1e15 };
const t0 = Date.now();
for (let asOf = Math.ceil(from / 60000) * 60000; asOf <= to; asOf += 60000) {
  const r = step32(s, asOf, st);
  if (!r.ctx) continue;
  inc("market_checks"); inc(`state:${r.state!.state}`);
  for (const x of r.records) {
    if (x.status === "WAITED") continue;
    inc(`cand:${x.setup}`); inc(`status:${x.status}`); inc(`${x.setup}:${x.status}`);
    if (x.cand && (x.status === "PASSED" || x.status === "SELECTED" || x.status === "LOST_ARBITRATION" || x.status === "SHADOW_ONLY" || x.status === "FAILED" || x.status === "NOT_ROUTED")) {
      // shadow outcome: what would have happened if taken (no Flow gates, market-style entry next minute)
      const c = x.cand; const i1 = lastClosed(s.m1, asOf + 60000) + 1;
      const sim = simulate(all, { side: c.side, startIdx: i1, entry: c.entry, zoneLow: c.entry, zoneHigh: c.entry, stop: c.stop, target: c.target, ttlMs: 3 * 60000, maxHoldMs: 24 * 3600000, chaseUsd: 1, costUsd: CONFIG32.costUsd });
      if (sim.filled) shadow.push({ t: asOf, setup: x.setup, status: x.status, side: c.side, state: r.state!.state, score: x.score, r: +(sim.pnl! / c.risk).toFixed(3) });
    }
  }
  const sel = r.selected; if (!sel || !sel.cand) continue;
  inc("arbitration_winners");
  const c = sel.cand;
  if (asOf < busyUntil) { inc("flow:one_entry"); continue; }
  if (lastStops[c.side].filter((x) => asOf - x < 2 * 3600000).length >= 2) { inc("flow:two_strikes"); continue; }
  if (asOf - lastWin[c.side] < 15 * 60000) { inc("flow:post_win_pause"); continue; }
  if (asOf - lastWin[c.side] < 90 * 60000 && (sel.score ?? 0) < 68 && sel.setup !== "SESSION_BREAK" && sel.setup !== "BOS_PULLBACK") { inc("flow:post_win_premium_only"); continue; }
  inc("signals");
  const startIdx = lastClosed(s.m1, asOf + 60000) + 1;
  const sim = simulate(all, { side: c.side, startIdx, entry: c.entry, zoneLow: c.entry, zoneHigh: c.entry, stop: c.stop, target: c.target, ttlMs: 3 * 60000, maxHoldMs: 24 * 3600000, chaseUsd: 1, costUsd: CONFIG32.costUsd });
  if (!sim.filled) { inc(`missed:${sim.missReason}`); continue; }
  if (sim.open) continue;
  inc("fills");
  busyUntil = sim.exitAt!;
  if (sim.result === "stop") lastStops[c.side].push(sim.exitAt!); else if (sim.pnl! > 0) { lastWin[c.side] = sim.exitAt!; lastStops[c.side] = []; }
  trades.push({ t: asOf, setup: sel.setup, side: c.side, state: r.state!.state, score: sel.score, risk: c.risk, targetR: c.targetR, r: +(sim.pnl! / Math.min(10, c.risk)).toFixed(3), result: sim.result });
}
writeFileSync(out, JSON.stringify({ funnel, trades, shadow }));
console.log(JSON.stringify({ ms: Date.now() - t0, funnel }));
