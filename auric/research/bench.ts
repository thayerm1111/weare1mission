/** `npm run auric-bench` — synthetic-data smoke run + in-process evaluation latency benchmark. Not a strategy result. */
import { backtest } from "./backtest";
import type { Bar } from "../core/types";

function synthetic(n: number, seed = 7): Bar[] {
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const bars: Bar[] = []; let p = 2400; let drift = 0; let vol = 0.4;
  const t0 = Date.UTC(2026, 0, 5, 0, 0);
  for (let i = 0; i < n; i++) {
    if (i % 720 === 0) { drift = (rnd() - 0.5) * 0.06; vol = 0.25 + rnd() * 0.6; }
    const o = p; const moves = Array.from({ length: 4 }, () => (rnd() - 0.5) * vol * 2 + drift);
    let h = o, l = o, c = o; for (const m of moves) { c += m; h = Math.max(h, c); l = Math.min(l, c); }
    bars.push({ t: t0 + i * 60_000, o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +c.toFixed(2) }); p = c;
  }
  return bars;
}

const n = Number(process.env.BENCH_BARS ?? 30000);
const bars = synthetic(n);
const t0 = Date.now();
const r = backtest(bars, { spread: 0.3, slippageTicks: 15, commissionPerLot: 0, equity: 1000, riskFraction: 0.005, label: "synthetic" });
console.log(JSON.stringify({ wallMs: Date.now() - t0, bars: r.bars, trades: r.trades, candidatesSeen: r.candidatesSeen, evalP50Ms: r.evalP50Ms, evalP95Ms: r.evalP95Ms, evalP99Ms: r.evalP99Ms, byFamily: r.byFamily, topRejections: Object.entries(r.rejections).sort((a, b) => b[1] - a[1]).slice(0, 12) }, null, 1));
