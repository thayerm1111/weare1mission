/**
 * Replay of GENX 1.0 (engine-v1, "quick" mode) on 1m history with the same execution model used for
 * GENX 3.x: 5-minute scans, TRADE_READY → market entry, DEVELOPING → resting zone that fills when a
 * 1m bar trades into it (expires 8h, cancelled if the stop is crossed), $1 chase, $0.50 cost, one
 * position at a time, 2-strike and post-win pauses, entry blackouts, TP1 / stop exits (24h cap).
 * Dedupe key identical to live: side + $0.1-rounded zone (live used r1 = 1 decimal).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { runEngine, type Row } from "../src/lib/omEngine";
import { MODES, GOLD } from "../src/lib/genxCompute";
import { simulate, type B } from "../src/lib/genx3/v32/sim";
import { entryBlackout } from "../src/lib/genx3/v31/engine";

const [, , file, fromS, toS, out] = process.argv;
const all: B[] = (JSON.parse(readFileSync(file, "utf8")) as number[][]).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const from = Date.parse(fromS), to = Date.parse(toS);
const lower = (x: number) => { let lo = 0, hi = all.length; while (lo < hi) { const m = (lo + hi) >> 1; if (all[m].t < x) lo = m + 1; else hi = m; } return lo; };
const iso = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");

// Provider-like series ending at asOf, INCLUDING the forming bucket (the engine drops it itself).
function series(asOf: number, minutes: number, count: number): Row[] {
  const size = minutes * 60000, end = lower(asOf); const startT = Math.floor(asOf / size) * size - (count - 1) * size;
  const out: Row[] = []; let cur: { t: number; o: number; h: number; l: number; c: number } | null = null;
  for (let i = lower(startT); i < end; i++) {
    const b = all[i], k = Math.floor(b.t / size) * size;
    if (!cur || cur.t !== k) { if (cur) out.push({ datetime: iso(cur.t), open: String(cur.o), high: String(cur.h), low: String(cur.l), close: String(cur.c) }); cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
  }
  if (cur) out.push({ datetime: iso(cur.t), open: String(cur.o), high: String(cur.h), low: String(cur.l), close: String(cur.c) });
  return out.slice(-count);
}
const cfg = { ...GOLD, ...MODES.quick.eng };
const tf = MODES.quick.tf;
const mins: Record<string, number> = { "1min": 1, "5min": 5, "15min": 15, "30min": 30, "1h": 60 };

type Pending = { key: string; side: "buy" | "sell"; lo: number; hi: number; stop: number; tp: number; t: number; strategy: string; regime: string; conf: number };
const seen = new Set<string>(); let pending: Pending[] = [];
const trades: Record<string, unknown>[] = []; const funnel: Record<string, number> = {}; const inc = (k: string) => { funnel[k] = (funnel[k] ?? 0) + 1; };
let busyUntil = 0; const lastStops: Record<string, number[]> = { buy: [], sell: [] }; const lastWin: Record<string, number> = { buy: -1e15, sell: -1e15 };
const r1 = (n: number) => Math.round(n * 10) / 10;

function take(p: Pending, asOf: number, market: boolean) {
  if (asOf < busyUntil) { inc("flow:one_entry"); return; }
  if (lastStops[p.side].filter((x) => asOf - x < 2 * 3600000).length >= 2) { inc("flow:two_strikes"); return; }
  if (asOf - lastWin[p.side] < 15 * 60000) { inc("flow:post_win_pause"); return; }
  if (entryBlackout(asOf)) { inc("flow:blackout"); return; }
  const risk = Math.abs((p.lo + p.hi) / 2 - p.stop); if (!(risk > 0)) return;
  inc("signals");
  const side = p.side === "buy" ? "BUY" : "SELL";
  const startIdx = lower(asOf + 60000);
  const entry = market ? all[startIdx - 1]?.c ?? p.hi : (p.side === "buy" ? p.hi : p.lo);
  const sim = simulate(all, { side, startIdx, entry, zoneLow: p.side === "buy" ? p.hi : p.lo, zoneHigh: p.side === "buy" ? p.hi : p.lo, stop: p.stop, target: p.tp, ttlMs: 3 * 60000, maxHoldMs: 24 * 3600000, chaseUsd: 1, costUsd: 0.5 });
  if (!sim.filled || sim.open) { inc(`missed:${sim.missReason ?? "open"}`); return; }
  inc("fills"); busyUntil = sim.exitAt!;
  const planned = Math.abs(entry - p.stop);
  if (sim.result === "stop") lastStops[p.side].push(sim.exitAt!); else if (sim.pnl! > 0) { lastWin[p.side] = sim.exitAt!; lastStops[p.side] = []; }
  trades.push({ t: asOf, strategy: p.strategy, regime: p.regime, side, conf: p.conf, risk: +planned.toFixed(2), rrTp: +(Math.abs(p.tp - entry) / planned).toFixed(2), result: sim.result, r: +(sim.pnl! / planned).toFixed(3), pips: +((sim.pnl! + 0.5) / 0.1).toFixed(0) });
}

const t0 = Date.now();
for (let asOf = Math.ceil(from / 60000) * 60000; asOf <= to; asOf += 60000) {
  const i1 = lower(asOf); if (i1 < 1 || asOf - (all[i1 - 1].t + 60000) > 5 * 60000) { pending = []; continue; }
  // resting zones (fast watch): fill when the last closed 1m bar traded into the zone; cancel on stop or 8h
  const bar = all[i1 - 1];
  for (const p of [...pending]) {
    const crossed = p.side === "buy" ? bar.l <= p.stop : bar.h >= p.stop;
    if (crossed || asOf - p.t > 8 * 3600000) { pending = pending.filter((x) => x !== p); inc(crossed ? "developing:invalidated" : "developing:expired"); continue; }
    const inZone = bar.l <= p.hi + 0.2 && bar.h >= p.lo - 0.2;
    if (inZone) { pending = pending.filter((x) => x !== p); inc("developing:zone_fill"); take(p, asOf, false); }
  }
  if (asOf % 300000 !== 0) continue;
  inc("scans");
  const input = { d1: series(asOf, mins[tf.d1], 90), h4: series(asOf, mins[tf.h4], 90), h1: series(asOf, mins[tf.h1], 120), m30: series(asOf, mins[tf.m30], 120), m15: series(asOf, mins[tf.m15], 150), m5: series(asOf, mins[tf.m5], 150), price: bar.c, nowMs: asOf, session: "London" };
  const read = runEngine(cfg, input) as Record<string, any>;
  inc(`state:${read.state}`);
  if (read.state !== "TRADE_READY" && read.state !== "DEVELOPING_SETUP") continue;
  const src = read.state === "TRADE_READY" ? read : read.provisional_trade;
  if (!src?.entry || !src?.stop_loss || !src?.take_profits?.length) continue;
  const side: "buy" | "sell" = read.direction === "sell" ? "sell" : "buy";
  const p: Pending = { key: `quick:${side}:${r1(src.entry.zone_low)}:${r1(src.entry.zone_high)}`, side, lo: +src.entry.zone_low, hi: +src.entry.zone_high, stop: +src.stop_loss.price, tp: +src.take_profits[0].price, t: asOf, strategy: String(read.strategy), regime: String(read.market_regime), conf: Number(read.scores?.overall ?? 0) };
  if (seen.has(p.key)) continue; seen.add(p.key);
  inc(`setup:${read.state}`);
  if (read.state === "TRADE_READY") take(p, asOf, true); else pending.push(p);
}
writeFileSync(out, JSON.stringify({ funnel, trades }));
console.log(JSON.stringify({ ms: Date.now() - t0, funnel }));
