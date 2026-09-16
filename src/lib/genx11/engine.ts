/**
 * GENX 1.1 — GENX 1.0 (engine-v1, quick mode) + a trend/chop router + a support/resistance engine
 * for chop. Pure and deterministic: the same code runs in replay and in the live worker.
 * Parameters are pre-registered in docs/genx3/GENX-1.1.md (not fitted).
 */
import { runEngine, type Row } from "../omEngine";
import { MODES, GOLD } from "../genxCompute";
import { type Series, lastClosed, confirmedPivots } from "../genx3/v31/series";
import type { Bar } from "../genx3/candles";

export const STRATEGY_VERSION_11 = "1.1.0";
export type MarketState11 = "TREND_UP" | "TREND_DOWN" | "CHOP" | "UNCLEAR";
export type Setup11 = { key: string; engine: "GENX1_TREND" | "SR_CHOP"; kind: "READY" | "ZONE"; side: "BUY" | "SELL"; zoneLow: number; zoneHigh: number; entry: number; stop: number; target: number; strategy: string; score: number; evidence: string[] };
export type Read11 = { asOf: number; raw: MarketState11; state: MarketState11; adx: number; chop: number; er: number; atr15: number; setups: Setup11[]; rejected: { engine: string; reason: string }[]; genx1State: string | null };
export type State11 = { raw: MarketState11[]; active: MarketState11; seen: Map<string, number> };
export const newState11 = (): State11 => ({ raw: [], active: "UNCLEAR", seen: new Map() });

const iso = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");
/** Provider-like rows for GENX 1.0 from CLOSED 1m bars; the newest bucket is the (partial) forming bar the engine drops. */
function rows(s: Series, asOf: number, minutes: number, count: number): Row[] {
  const size = minutes * 60000, i1 = lastClosed(s.m1, asOf);
  const startT = Math.floor(asOf / size) * size - (count - 1) * size;
  let lo = 0, hi = i1 + 1; while (lo < hi) { const m = (lo + hi) >> 1; if (s.m1.t[m] < startT) lo = m + 1; else hi = m; }
  const out: Row[] = []; let cur: Bar | null = null;
  for (let i = lo; i <= i1; i++) {
    const b = s.m1.bars[i], k = Math.floor(b.t / size) * size;
    if (!cur || cur.t !== k) { if (cur) out.push({ datetime: iso(cur.t), open: String(cur.o), high: String(cur.h), low: String(cur.l), close: String(cur.c) }); cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
  }
  if (cur) out.push({ datetime: iso(cur.t), open: String(cur.o), high: String(cur.h), low: String(cur.l), close: String(cur.c) });
  return out.slice(-count);
}

function adx14(b: Bar[]): number {
  const p = 14; if (b.length < p * 2 + 1) return 0;
  const plus: number[] = [], minus: number[] = [], tr: number[] = [];
  for (let i = 1; i < b.length; i++) { const up = b[i].h - b[i - 1].h, dn = b[i - 1].l - b[i].l; plus.push(up > dn && up > 0 ? up : 0); minus.push(dn > up && dn > 0 ? dn : 0); tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c))); }
  const sm = (a: number[]) => { let s = a.slice(0, p).reduce((x, y) => x + y, 0); const o = [s]; for (let i = p; i < a.length; i++) { s = s - s / p + a[i]; o.push(s); } return o; };
  const t = sm(tr), pl = sm(plus), mi = sm(minus); const dx: number[] = [];
  for (let i = 0; i < t.length; i++) { const pd = t[i] ? 100 * pl[i] / t[i] : 0, md = t[i] ? 100 * mi[i] / t[i] : 0; dx.push(pd + md ? 100 * Math.abs(pd - md) / (pd + md) : 0); }
  const last = dx.slice(-p); return last.reduce((a, x) => a + x, 0) / last.length;
}
const sma = (v: number[], n: number) => v.slice(-n).reduce((a, x) => a + x, 0) / n;

/** Classify on closed 15m bars. */
export function classify11(s: Series, asOf: number): { raw: MarketState11; adx: number; chop: number; er: number; atr15: number } {
  const i15 = lastClosed(s.m15, asOf);
  const b = s.m15.bars.slice(Math.max(0, i15 - 79), i15 + 1);
  if (b.length < 60) return { raw: "UNCLEAR", adx: 0, chop: 50, er: 0, atr15: s.m15.atr[Math.max(0, i15)] ?? 0 };
  const adx = adx14(b);
  const w = b.slice(-15); let trSum = 0; for (let i = 1; i < w.length; i++) trSum += Math.max(w[i].h - w[i].l, Math.abs(w[i].h - w[i - 1].c), Math.abs(w[i].l - w[i - 1].c));
  const hi = Math.max(...w.slice(1).map((x) => x.h)), lo = Math.min(...w.slice(1).map((x) => x.l));
  const chop = hi > lo ? 100 * Math.log10(trSum / (hi - lo)) / Math.log10(14) : 50;
  let path = 0; for (let i = b.length - 16; i < b.length; i++) path += Math.abs(b[i].c - b[i - 1].c);
  const er = path > 0 ? Math.abs(b.at(-1)!.c - b[b.length - 17].c) / path : 0;
  const closes = b.map((x) => x.c), px = closes.at(-1)!, s20 = sma(closes, 20), s50 = sma(closes, 50);
  let raw: MarketState11 = "UNCLEAR";
  if (adx >= 22 && chop < 50 && px > s20 && s20 > s50) raw = "TREND_UP";
  else if (adx >= 22 && chop < 50 && px < s20 && s20 < s50) raw = "TREND_DOWN";
  else if (chop >= 58 && adx < 22 && er < 0.3) raw = "CHOP";
  return { raw, adx: +adx.toFixed(1), chop: +chop.toFixed(1), er: +er.toFixed(2), atr15: s.m15.atr[i15] };
}

/** Support/resistance levels from the last 3 days of closed 15m bars + prior-day and Asian highs/lows. */
export function srLevels(s: Series, asOf: number, atr15: number): { px: number; touches: number; name: string }[] {
  const i15 = lastClosed(s.m15, asOf);
  const piv = confirmedPivots(s.m15, i15, 2, 2, 288);
  const clusters: { px: number; ts: number[]; n: number }[] = [];
  for (const p of piv) {
    const c = clusters.find((x) => Math.abs(x.px - p.price) <= 0.35 * atr15);
    if (c) { c.px = (c.px * c.n + p.price) / (c.n + 1); c.n++; c.ts.push(p.t); } else clusters.push({ px: p.price, ts: [p.t], n: 1 });
  }
  const out = clusters.filter((c) => c.n >= 2 && Math.max(...c.ts) - Math.min(...c.ts) >= 2 * 3600000).map((c) => ({ px: +c.px.toFixed(2), touches: c.n, name: "SR" }));
  const DAY = 86400000, dayStart = Math.floor(asOf / DAY) * DAY;
  const i1h = lastClosed(s.h1, asOf);
  const prev = s.h1.bars.slice(0, i1h + 1).filter((b) => b.t >= dayStart - DAY && b.t < dayStart);
  if (prev.length) { out.push({ px: Math.max(...prev.map((b) => b.h)), touches: 1, name: "PDH" }, { px: Math.min(...prev.map((b) => b.l)), touches: 1, name: "PDL" }); }
  if (asOf >= dayStart + 7 * 3600000) { const asia = s.h1.bars.slice(0, i1h + 1).filter((b) => b.t >= dayStart && b.t < dayStart + 7 * 3600000); if (asia.length) out.push({ px: Math.max(...asia.map((b) => b.h)), touches: 1, name: "ASIA_H" }, { px: Math.min(...asia.map((b) => b.l)), touches: 1, name: "ASIA_L" }); }
  return out;
}

/** One 5-minute decision. */
export function step11(s: Series, asOf: number, st: State11): Read11 {
  const cl = classify11(s, asOf);
  st.raw.push(cl.raw); if (st.raw.length > 2) st.raw.shift();
  if (st.raw.length === 2 && st.raw[0] === st.raw[1]) st.active = st.raw[1];
  const read: Read11 = { asOf, raw: cl.raw, state: st.active, adx: cl.adx, chop: cl.chop, er: cl.er, atr15: cl.atr15, setups: [], rejected: [], genx1State: null };
  for (const [k, t] of st.seen) if (asOf - t > 4 * 3600000) st.seen.delete(k);
  if (st.active === "UNCLEAR") return read;

  if (st.active === "TREND_UP" || st.active === "TREND_DOWN") {
    const tf = MODES.quick.tf, m: Record<string, number> = { "1min": 1, "5min": 5, "15min": 15, "30min": 30, "1h": 60 };
    const i1 = lastClosed(s.m1, asOf);
    const r = runEngine({ ...GOLD, ...MODES.quick.eng }, { d1: rows(s, asOf, m[tf.d1], 90), h4: rows(s, asOf, m[tf.h4], 90), h1: rows(s, asOf, m[tf.h1], 120), m30: rows(s, asOf, m[tf.m30], 120), m15: rows(s, asOf, m[tf.m15], 150), m5: rows(s, asOf, m[tf.m5], 150), price: s.m1.bars[i1].c, nowMs: asOf, session: "London" }) as Record<string, any>;
    read.genx1State = String(r.state);
    if (r.state !== "TRADE_READY" && r.state !== "DEVELOPING_SETUP") return read;
    const src = r.state === "TRADE_READY" ? r : r.provisional_trade;
    const want = st.active === "TREND_UP" ? "buy" : "sell";
    if (!String(r.strategy).startsWith("Trend")) { read.rejected.push({ engine: "GENX1_TREND", reason: `GENX 1.0 offered "${r.strategy}" — only trend strategies trade in TREND state` }); return read; }
    if (r.direction !== want) { read.rejected.push({ engine: "GENX1_TREND", reason: `GENX 1.0 ${r.direction} against router ${st.active}` }); return read; }
    if (!src?.entry || !src?.stop_loss || !src?.take_profits?.length) return read;
    const side = want === "buy" ? "BUY" : "SELL";
    const key = `G1:${side}:${Math.round(src.entry.zone_low * 10) / 10}:${Math.round(src.entry.zone_high * 10) / 10}`;
    if (st.seen.has(key)) return read; st.seen.set(key, asOf);
    read.setups.push({ key, engine: "GENX1_TREND", kind: r.state === "TRADE_READY" ? "READY" : "ZONE", side, zoneLow: +src.entry.zone_low, zoneHigh: +src.entry.zone_high, entry: +src.entry.price, stop: +src.stop_loss.price, target: +src.take_profits[0].price, strategy: String(r.strategy), score: Number(r.scores?.overall ?? 0), evidence: [`${st.active} (ADX ${cl.adx}, chop ${cl.chop})`, `GENX 1.0 ${r.strategy} ${r.state} score ${r.scores?.overall}`, String(src.stop_loss.reason ?? "")] });
    return read;
  }

  // CHOP → support / resistance
  const lv = srLevels(s, asOf, cl.atr15);
  const i5 = lastClosed(s.m5, asOf), b = s.m5.bars[i5], a = cl.atr15, rng = b.h - b.l || 1e-9, loc = (b.c - b.l) / rng;
  const i15 = lastClosed(s.m15, asOf), last4 = s.m15.bars.slice(Math.max(0, i15 - 3), i15 + 1);
  for (const L of lv) {
    for (const side of ["BUY", "SELL"] as const) {
      const d = side === "BUY" ? 1 : -1;
      const tagged = side === "BUY" ? b.l >= L.px - 0.3 * a && b.l <= L.px + 0.25 * a : b.h <= L.px + 0.3 * a && b.h >= L.px - 0.25 * a;
      if (!tagged) continue;
      const wick = side === "BUY" ? (Math.min(b.o, b.c) - b.l) / rng : (b.h - Math.max(b.o, b.c)) / rng;
      const rejected = side === "BUY" ? b.c > L.px && loc >= 0.6 && wick >= 0.4 : b.c < L.px && loc <= 0.4 && wick >= 0.4;
      const holding = last4.every((x) => (side === "BUY" ? x.c >= L.px : x.c <= L.px));
      const key = `SR:${side}:${L.name}:${L.px.toFixed(1)}`;
      if (!rejected) { read.rejected.push({ engine: "SR_CHOP", reason: `${side} at ${L.name} ${L.px}: no 5m rejection (close loc ${loc.toFixed(2)}, wick ${wick.toFixed(2)})` }); continue; }
      if (!holding) { read.rejected.push({ engine: "SR_CHOP", reason: `${side} at ${L.name} ${L.px}: 15m closed through the level in the last hour` }); continue; }
      if (st.seen.has(key)) continue;
      const entry = b.c, stop = +(side === "BUY" ? Math.min(b.l, L.px) - 0.25 * a : Math.max(b.h, L.px) + 0.25 * a).toFixed(2);
      const risk = d * (entry - stop);
      const opp = lv.map((x) => x.px).filter((px) => d * (px - entry) > 0).sort((x, y) => d * (x - y));
      if (!opp.length) { read.rejected.push({ engine: "SR_CHOP", reason: `${side} at ${L.name}: no opposing level for a target` }); continue; }
      const target = +(opp[0] - d * 0.1 * a).toFixed(2), rr = d * (target - entry) / risk;
      if (!(risk > 0) || rr < 1.5) { read.rejected.push({ engine: "SR_CHOP", reason: `${side} at ${L.name} ${L.px}: target ${target} only ${rr.toFixed(2)}R (< 1.5R)` }); continue; }
      st.seen.set(key, asOf);
      read.setups.push({ key, engine: "SR_CHOP", kind: "READY", side, zoneLow: entry, zoneHigh: entry, entry, stop, target, strategy: `S/R ${side === "BUY" ? "support bounce" : "resistance rejection"} (${L.name})`, score: Math.round(50 + 10 * Math.min(3, L.touches) + 10 * Math.min(1, rr / 3)), evidence: [`CHOP (chop ${cl.chop}, ADX ${cl.adx}, ER ${cl.er})`, `${L.name} ${L.px} (${L.touches} touches)`, `5m rejection: close loc ${loc.toFixed(2)}, wick ${(wick * 100).toFixed(0)}%`, `target ${target} = ${rr.toFixed(2)}R`] });
    }
  }
  read.setups.sort((x, y) => y.score - x.score);
  if (read.setups.length > 1) read.setups = read.setups.slice(0, 1);
  return read;
}
