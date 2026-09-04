/**
 * MATTY PIPS — the liquidity engine. Obvious highs/lows are liquidity pools:
 * price often trades BEYOND them to collect stops before reversing. Detects
 * buy-side/sell-side pools (equal highs/lows, day/week extremes, swing
 * points), classifies sweeps, and grades FAKEOUT probability.
 */
import type { Candle, LiquidityContext, RankedLevel } from "./types";
import { findPivots } from "./structure";

const f = (n: number) => (n >= 100 ? n.toFixed(1) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));

export function liquidityContext(o: {
  m15: Candle[];
  levels: RankedLevel[];
  node: { low: number; high: number; kind: "support" | "resistance" } | null;
  price: number;
  atr15: number;
  atr1h: number;
}): LiquidityContext {
  const closed = o.m15.slice(0, -1);
  const piv = findPivots(closed, 2);
  const tol = 0.35 * o.atr15;

  // Pools: obvious swing highs/lows + equal highs/lows + time-based level edges.
  const buy: number[] = [];   // above price (buy-side liquidity = stops above highs)
  const sell: number[] = [];  // below price
  const highs = piv.filter((p) => p.kind === "high").map((p) => p.price);
  const lows = piv.filter((p) => p.kind === "low").map((p) => p.price);
  // equal highs/lows: two swing points within tolerance = a magnet.
  for (let i = 1; i < highs.length; i++) if (Math.abs(highs[i] - highs[i - 1]) <= tol) buy.push(Math.max(highs[i], highs[i - 1]));
  for (let i = 1; i < lows.length; i++) if (Math.abs(lows[i] - lows[i - 1]) <= tol) sell.push(Math.min(lows[i], lows[i - 1]));
  for (const l of o.levels) {
    const timeBased = l.sources.some((s) => /WEEK|DAY|STRUCT/.test(s));
    if (!timeBased) continue;
    if (l.high > o.price) buy.push(l.high);
    if (l.low < o.price) sell.push(l.low);
  }
  const dedupe = (xs: number[]) => [...new Set(xs.map((x) => +x.toFixed(2)))].sort((a, b) => a - b).slice(-6);
  const buyPools = dedupe(buy.filter((x) => x > o.price));
  const sellPools = dedupe(sell.filter((x) => x < o.price)).slice(0, 6);

  // Sweep detection at the active node: traded beyond, closed back.
  let sweep: LiquidityContext["sweep"] = null;
  let fakeout: LiquidityContext["fakeoutProbability"] = null;
  if (o.node) {
    const recent = closed.slice(-6);
    const k = closed[closed.length - 1];
    if (o.node.kind === "resistance") {
      const sw = recent.filter((x) => x.h > o.node!.high && x.c < o.node!.high).sort((a, b) => b.h - a.h)[0];
      if (sw) {
        const pen = sw.h - o.node.high;
        const hadPool = buyPools.some((p) => Math.abs(p - o.node!.high) <= 2 * tol || (p > o.node!.high && p <= sw.h + tol));
        const barsBeyond = recent.filter((x) => x.c > o.node!.high).length;
        const followThrough = k.c < k.o && k.c < o.node.high;
        let score = 0;
        score += pen <= 1.2 * o.atr15 ? 2 : pen <= 2 * o.atr15 ? 1 : 0;  // shallow penetration
        score += barsBeyond === 0 ? 2 : barsBeyond === 1 ? 1 : 0;         // no closes beyond
        score += followThrough ? 2 : 0;                                    // next candle follows
        score += hadPool ? 1 : 0;                                          // obvious liquidity sat there
        score += o.node.high === Math.max(...o.levels.filter((l) => l.kind === "resistance").map((l) => l.high), o.node.high) ? 1 : 0;
        fakeout = score >= 6 ? "FAKEOUT_HIGH" : score >= 4 ? "FAKEOUT_MODERATE" : "FAKEOUT_LOW";
        sweep = { side: "buy-side", extreme: sw.h, detail: `Traded ${f(sw.h)} (${f(pen)} beyond ${f(o.node.high)}) and closed back at ${f(sw.c)} — buy-side liquidity ${hadPool ? "that was sitting there " : ""}collected. Fakeout probability: ${fakeout.replace("FAKEOUT_", "").toLowerCase()}.` };
      }
    } else {
      const sw = recent.filter((x) => x.l < o.node!.low && x.c > o.node!.low).sort((a, b) => a.l - b.l)[0];
      if (sw) {
        const pen = o.node.low - sw.l;
        const hadPool = sellPools.some((p) => Math.abs(p - o.node!.low) <= 2 * tol || (p < o.node!.low && p >= sw.l - tol));
        const barsBeyond = recent.filter((x) => x.c < o.node!.low).length;
        const followThrough = k.c > k.o && k.c > o.node.low;
        let score = 0;
        score += pen <= 1.2 * o.atr15 ? 2 : pen <= 2 * o.atr15 ? 1 : 0;
        score += barsBeyond === 0 ? 2 : barsBeyond === 1 ? 1 : 0;
        score += followThrough ? 2 : 0;
        score += hadPool ? 1 : 0;
        score += o.node.low === Math.min(...o.levels.filter((l) => l.kind === "support").map((l) => l.low), o.node.low) ? 1 : 0;
        fakeout = score >= 6 ? "FAKEOUT_HIGH" : score >= 4 ? "FAKEOUT_MODERATE" : "FAKEOUT_LOW";
        sweep = { side: "sell-side", extreme: sw.l, detail: `Traded ${f(sw.l)} (${f(pen)} below ${f(o.node.low)}) and closed back at ${f(sw.c)} — sell-side liquidity ${hadPool ? "that was sitting there " : ""}collected. Fakeout probability: ${fakeout.replace("FAKEOUT_", "").toLowerCase()}.` };
      }
    }
  }

  const detail = sweep
    ? sweep.detail
    : `Liquidity map: ${buyPools.length} buy-side pool(s) above (${buyPools.map(f).join(", ") || "none"}), ${sellPools.length} sell-side below (${sellPools.map(f).join(", ") || "none"}). No sweep at the active level right now.`;

  return { buySidePools: buyPools, sellSidePools: sellPools, sweep, fakeoutProbability: fakeout, detail };
}
