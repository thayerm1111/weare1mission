/** Stage-1 candidate census for GENX 3.1: every candidate, deduped by anchor, with hypothetical outcomes. */
import { readFileSync, writeFileSync } from "node:fs";
import { buildSeries, lastClosed } from "../src/lib/genx3/v31/series";
import { buildContext } from "../src/lib/genx3/v31/context";
import { generate } from "../src/lib/genx3/v31/playbooks";
import { simulate, type B } from "./sim";
const [, , file, out, costArg] = process.argv;
const cost = Number(costArg ?? 0.5);
const all: B[] = (JSON.parse(readFileSync(file, "utf8")) as number[][]).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const s = buildSeries(all);
const rows: Record<string, unknown>[] = [];
const seen = new Set<string>();
const t0 = Date.now();
let cycles = 0;
const start = Math.ceil((all[0].t + 22 * 86400000) / 300000) * 300000;
for (let asOf = start; asOf <= all.at(-1)!.t; asOf += 300000) {
  const i1 = lastClosed(s.m1, asOf);
  if (i1 < 0 || asOf - (all[i1].t + 60000) > 5 * 60000) continue;             // market closed / stale
  const ctx = buildContext(s, asOf); if (!ctx) continue;
  cycles++;
  for (const c of generate(s, ctx)) {
    if (seen.has(c.anchor)) continue; seen.add(c.anchor);
    const base = { t: asOf, pb: c.playbook, side: c.side, regime: ctx.regime, vol: ctx.volState, sess: ctx.session, hour: ctx.hourUtc, risk: c.risk, entryType: c.entryType, room: c.structTarget == null ? null : +(Math.abs(c.structTarget - c.entry) / c.risk).toFixed(2), ...Object.fromEntries(Object.entries(c.f).map(([k, v]) => [k, +(+v).toFixed(3)])) };
    const res: Record<string, unknown> = {};
    const d = c.side === "BUY" ? 1 : -1;
    const variants: [string, Partial<Parameters<typeof simulate>[1]>][] = [
      ["r1", { target: c.entry + d * 1 * c.risk }], ["r1.5", { target: c.entry + d * 1.5 * c.risk }], ["r2", { target: c.entry + d * 2 * c.risk }], ["r3", { target: c.entry + d * 3 * c.risk }],
      ["r5", { target: c.entry + d * 5 * c.risk, maxHoldMs: 8 * 3600000 }],
      ["p2", { target: c.entry + d * 2 * c.risk, maxHoldMs: 24 * 3600000 }], ["p3", { target: c.entry + d * 3 * c.risk, maxHoldMs: 24 * 3600000 }], ["p4", { target: c.entry + d * 4 * c.risk, maxHoldMs: 24 * 3600000 }],
      ["be1_r3", { target: c.entry + d * 3 * c.risk, beAtR: 1 }],
      ["trail", { target: c.entry + d * 20 * c.risk, trailUsd: 1.5 * ctx.atr15, trailAfterR: 1, maxHoldMs: 8 * 3600000 }],
      ["t60", { target: c.entry + d * 50 * c.risk, maxHoldMs: 3600000 }],
      ["t240", { target: c.entry + d * 50 * c.risk, maxHoldMs: 4 * 3600000 }],
    ];
    for (const [name, v] of variants) {
      const sim = simulate(all, { side: c.side, startIdx: i1 + 1, entry: c.entry, zoneLow: c.entry, zoneHigh: c.entry, stop: c.stop, ttlMs: c.ttlMin * 60000, maxHoldMs: 4 * 3600000, chaseUsd: 0, costUsd: cost, market: c.entryType === "MARKET", ...v, target: +(v.target as number).toFixed(2) } as Parameters<typeof simulate>[1]);
      res[name] = sim.filled ? sim.pnl : null;
      if (name === "r1.5") Object.assign(res, { filled: sim.filled, mfe: sim.mfe ?? null, mae: sim.mae ?? null, res15: sim.result ?? sim.missReason, fillRisk: sim.fill != null ? +Math.abs(sim.fill - c.stop).toFixed(2) : null });
    }
    rows.push({ ...base, ...res });
  }
}
writeFileSync(out, JSON.stringify(rows));
console.log(JSON.stringify({ cycles, candidates: rows.length, ms: Date.now() - t0 }));
