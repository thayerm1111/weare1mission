/** Runs the portfolio simulator for a grid of Stage-2 configs; writes per-trade month results for walk-forward selection. */
import { readFileSync, writeFileSync } from "node:fs";
import { runPortfolio } from "./portfolio31";
import type { Stage2Config, Align } from "../src/lib/genx3/v31/stage2";
import type { Playbook } from "../src/lib/genx3/v31/playbooks";
const [, , file, out, shard, nshard] = process.argv;
const all = (JSON.parse(readFileSync(file, "utf8")) as number[][]).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const ALLPB: Playbook[] = ["TREND_PULLBACK", "MOMENTUM_CONTINUATION", "SWEEP_RECLAIM", "RANGE_REJECTION", "COMPRESSION_BREAKOUT", "BREAKOUT_RETEST", "FAILED_BREAKOUT", "SESSION_BREAK", "BOS_PULLBACK"];
const FAM: Record<string, Playbook[]> = {
  SB: ["SESSION_BREAK"], MC: ["MOMENTUM_CONTINUATION"], CB: ["COMPRESSION_BREAKOUT"], BR: ["BREAKOUT_RETEST"], TP: ["TREND_PULLBACK"], SR: ["SWEEP_RECLAIM"], RR: ["RANGE_REJECTION"], FB: ["FAILED_BREAKOUT"], BP: ["BOS_PULLBACK"],
  A: ["MOMENTUM_CONTINUATION", "SESSION_BREAK"], B: ["MOMENTUM_CONTINUATION", "SESSION_BREAK", "COMPRESSION_BREAKOUT", "BREAKOUT_RETEST"], SBCB: ["SESSION_BREAK", "COMPRESSION_BREAKOUT"],
};
const configs: { id: string; cfg: Stage2Config }[] = [];
for (const f of Object.keys(FAM)) for (const a of ["none", "htf", "2of3"] as Align[]) for (const e of [2, 3, 4]) {
  const rules = Object.fromEntries(ALLPB.map((pb) => [pb, { enabled: FAM[f].includes(pb), minScore: 0, exitR: e, vol: ["LOW", "NORMAL", "HIGH"], weights: { regimeFit: 1 } }])) as Stage2Config["rules"];
  configs.push({ id: `${f}|${a}|R${e}`, cfg: { version: "grid3", costUsd: 0.5, minRiskUsd: 1, maxRiskUsd: 10, minNetR: 0.5, minRiskAtr15: 0.5, align: a, rules } });
}
const from = all[0].t + 22 * 86400000, to = all.at(-1)!.t;
const res: Record<string, { m: string; r: number; pb: string }[]> = {};
configs.forEach((c, i) => {
  if (i % Number(nshard) !== Number(shard)) return;
  const { trades } = runPortfolio(all, c.cfg, from, to);
  res[c.id] = trades.map((t) => ({ m: new Date(t.t).toISOString().slice(0, 7), r: t.r, pb: t.pb, t: t.t } as never));
});
writeFileSync(out, JSON.stringify(res));
console.log("done", Object.keys(res).length);
