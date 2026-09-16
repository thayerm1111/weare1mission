/** Rejection funnel for GENX 3.0.0 exactly as deployed: same analyze(), plus hypothetical outcomes. */
import { readFileSync, writeFileSync } from "node:fs";
import { analyze } from "../src/lib/genx3/engine";
import { CONFIG } from "../src/lib/genx3/config";
import { simulate, stats, type B } from "./sim";
const [, , file, out] = process.argv;
const all: B[] = (JSON.parse(readFileSync(file, "utf8")) as number[][]).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const idxAt = (t: number) => { let lo = 0, hi = all.length; while (lo < hi) { const m = (lo + hi) >> 1; if (all[m].t < t) lo = m + 1; else hi = m; } return lo; };
const cost = CONFIG.costs.spreadEstimateUsd + CONFIG.costs.slippageEstimateUsd;
const f = { cycles: 0, skippedClosed: 0, dataInvalid: 0, history: 0, regimeBlocked: 0, newsBlocked: 0, cands: 0, byType: {} as Record<string, number>, byStage: {} as Record<string, number>, byTypeStage: {} as Record<string, number>, triggered: 0, rejects: {} as Record<string, number>, published: 0, regimes: {} as Record<string, number> };
const rows: unknown[] = [];
const seen = new Set<string>();
const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
const start = Math.ceil((all[0].t + 6 * 86400000) / 300000) * 300000;
let lo = 0;
for (let asOf = start; asOf <= all.at(-1)!.t; asOf += 300000) {
  while (lo < all.length && all[lo].t < asOf - 6 * 86400000) lo++;
  const hi = idxAt(asOf);
  if (hi - lo < 1000 || asOf - (all[hi - 1].t + 60000) > 600000) { f.skippedClosed++; continue; }
  f.cycles++;
  const d = analyze({ raw1m: all.slice(lo, hi), asOf, liveTick: null, news: { state: "CLEAR" } });
  if (d.regime) inc(f.regimes, d.regime.regime);
  const blocking = d.noTradeReasons.filter((r) => /^(data_invalid|insufficient_history|regime_|news_|conflicting)/.test(r));
  if (d.noTradeReasons.some((r) => r.startsWith("data_invalid"))) f.dataInvalid++;
  if (d.noTradeReasons.some((r) => r.startsWith("insufficient"))) f.history++;
  if (d.noTradeReasons.some((r) => r.startsWith("regime_"))) f.regimeBlocked++;
  for (const c of d.candidates) {
    f.cands++; inc(f.byType, c.setupType); inc(f.byStage, c.stage); inc(f.byTypeStage, `${c.setupType}:${c.stage}`);
    if (c.stage !== "TRIGGERED") continue;
    f.triggered++;
    const key = `${c.setupKey}:${asOf}`; if (seen.has(key)) continue; seen.add(key);
    let gate = "PASSED";
    if (c.rejectReason) gate = "trade_limits: " + c.rejectReason.replace(/[\d.$]+/g, "#");
    else if (c.score && c.score.total < c.score.threshold) gate = "score_below_65";
    else if (blocking.length) gate = "blocked: " + blocking[0].replace(/_\d+.*$/, "").split(":")[0];
    else if (!d.signal || d.signal.setup_id === undefined) gate = "not_selected";
    inc(f.rejects, gate);
    const sim = simulate(all, { side: c.side, startIdx: hi, entry: c.entry, zoneLow: c.zoneLow, zoneHigh: c.zoneHigh, stop: c.stop, target: c.target, ttlMs: CONFIG.trade.setupTtlMin * 60000, maxHoldMs: 8 * 3600000, chaseUsd: 1, costUsd: cost });
    rows.push({ asOf, type: c.setupType, side: c.side, regime: d.regime?.regime, gate, score: c.score?.total ?? null, risk: +Math.abs(c.entry - c.stop).toFixed(2), reward: +Math.abs(c.target - c.entry).toFixed(2), hour: new Date(asOf).getUTCHours(), ...sim });
  }
  if (d.signal) f.published++;
}
writeFileSync(out, JSON.stringify(rows));
const R = rows as { gate: string; type: string; filled: boolean; pnl?: number; mfe?: number; mae?: number; result?: string }[];
const byGate: Record<string, unknown> = {};
for (const g of [...new Set(R.map((r) => r.gate))]) { const x = R.filter((r) => r.gate === g); const fl = x.filter((r) => r.filled); byGate[g] = { count: x.length, filled: fl.length, ...stats(fl.map((r) => r.pnl!)), avgMFE: +(fl.reduce((a, r) => a + r.mfe!, 0) / Math.max(1, fl.length)).toFixed(2), avgMAE: +(fl.reduce((a, r) => a + r.mae!, 0) / Math.max(1, fl.length)).toFixed(2) }; }
console.log(JSON.stringify({ funnel: f, hypotheticalByGate: byGate }, null, 1));
