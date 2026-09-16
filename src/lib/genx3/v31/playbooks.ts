/** GENX 3.1 Stage 1 — sensitive candidate generation. Every candidate carries a structural
 *  invalidation, an entry plan and the raw evidence features used by Stage 2. */
import type { Bar } from "../candles";
import { type Series, hiLo, confirmedPivots } from "./series";
import type { Ctx } from "./context";

export type Playbook = "TREND_PULLBACK" | "MOMENTUM_CONTINUATION" | "SWEEP_RECLAIM" | "RANGE_REJECTION" | "COMPRESSION_BREAKOUT" | "BREAKOUT_RETEST" | "FAILED_BREAKOUT" | "SESSION_BREAK" | "BOS_PULLBACK";
export type Side = "BUY" | "SELL";
export type Cand = {
  playbook: Playbook; side: Side; anchor: string;
  entryType: "MARKET" | "LIMIT"; entry: number; ttlMin: number;
  invalidation: number; stop: number; risk: number;
  structTarget: number | null;           // nearest significant opposing level
  f: Record<string, number>;             // Stage-2 evidence features (0..1 or signed)
  evidence: string[];
};

const dirOf = (s: Side) => (s === "BUY" ? 1 : -1);
const cloc = (b: Bar) => (b.h > b.l ? (b.c - b.l) / (b.h - b.l) : 0.5);

function make(ctx: Ctx, p: Omit<Cand, "stop" | "risk" | "structTarget" | "f"> & { f?: Record<string, number> }): Cand | null {
  const d = dirOf(p.side);
  const buffer = 0.1 * ctx.atr5 + 0.3;
  const stop = +(p.invalidation - d * buffer).toFixed(2);
  const risk = d * (p.entry - stop);
  if (!(risk > 0)) return null;
  const opp = ctx.levels.map((l) => l.px).filter((px) => d * (px - p.entry) > 0.5 * risk).sort((a, b) => d * (a - b));
  const structTarget = opp[0] ?? null;
  const b5 = 0; void b5;
  const htf = p.side === "BUY" ? ctx.bias1h : -ctx.bias1h;
  const h4 = p.side === "BUY" ? ctx.bias4h : -ctx.bias4h;
  const t15 = p.side === "BUY" ? ctx.trend15 : -ctx.trend15;
  return { ...p, stop, risk: +risk.toFixed(2), structTarget, f: { htf, h4, t15, m20: p.side === "BUY" ? ctx.mom20d : -ctx.mom20d, m5: p.side === "BUY" ? ctx.mom5d : -ctx.mom5d, m20atr: (p.side === "BUY" ? 1 : -1) * ctx.mom20dAtr, riskAtr15: risk / ctx.atr15, er15: ctx.er15, volRatio: ctx.volRatio, riskAtr5: risk / ctx.atr5, roomR: structTarget == null ? 5 : d * (structTarget - p.entry) / risk, ...(p.f ?? {}) } };
}

export function generate(s: Series, ctx: Ctx): Cand[] {
  const out: Cand[] = [];
  const m5 = s.m5.bars, i = ctx.i5, b = m5[i], pb = m5[i - 1];
  const a5 = ctx.atr5, a15 = ctx.atr15;
  const push = (c: Cand | null) => { if (c) out.push(c); };
  const body = Math.abs(b.c - b.o), range = b.h - b.l;
  const upperW = b.h - Math.max(b.o, b.c), lowerW = Math.min(b.o, b.c) - b.l;
  const loc = cloc(b);

  // 1 TREND PULLBACK — 15m trend, price returned to the 15m EMA20 area, 5m closes back with the trend.
  for (const side of ["BUY", "SELL"] as Side[]) {
    const d = dirOf(side);
    if (ctx.trend15 !== d) continue;
    const e20 = s.m15.ema20[ctx.i15], e50 = s.m15.ema50[ctx.i15];
    const w = hiLo(s.m5, i - 11, i);
    const extreme = d > 0 ? w.l : w.h;
    const touched = d > 0 ? extreme <= e20 + 0.25 * a15 : extreme >= e20 - 0.25 * a15;
    const held = d > 0 ? extreme > e50 - 0.5 * a15 : extreme < e50 + 0.5 * a15;
    const trig = d > 0 ? b.c > pb.h && loc >= 0.6 : b.c < pb.l && loc <= 0.4;
    if (touched && held && trig) {
      const k = m5.findIndex((x, j) => j >= i - 11 && (d > 0 ? x.l === extreme : x.h === extreme));
      push(make(ctx, { playbook: "TREND_PULLBACK", side, anchor: `TP:${side}:${m5[k]?.t}`, entryType: "MARKET", entry: b.c, ttlMin: 5, invalidation: extreme,
        f: { conf: d > 0 ? loc : 1 - loc, disp: body / a5, depth: Math.abs(e20 - extreme) / a15 }, evidence: [`15m trend ${d > 0 ? "up" : "down"}, pullback to EMA20 ${e20.toFixed(2)}`, `5m close beyond prior bar`] }));
    }
  }

  // 2 MOMENTUM CONTINUATION — 5m displacement breaking the 12-bar extreme; limit at 50% of the bar.
  {
    const w = hiLo(s.m5, i - 12, i - 1);
    for (const side of ["BUY", "SELL"] as Side[]) {
      const d = dirOf(side);
      const disp = body >= 1.3 * a5 && (d > 0 ? b.c > b.o && loc >= 0.75 && b.c > w.h : b.c < b.o && loc <= 0.25 && b.c < w.l);
      if (!disp) continue;
      const mid = +((b.o + b.c) / 2).toFixed(2);
      push(make(ctx, { playbook: "MOMENTUM_CONTINUATION", side, anchor: `MC:${side}:${b.t}`, entryType: "LIMIT", entry: mid, ttlMin: 15, invalidation: d > 0 ? b.l : b.h,
        f: { conf: d > 0 ? loc : 1 - loc, disp: body / a5 }, evidence: [`5m displacement ${(body / a5).toFixed(1)}×ATR5 through 12-bar ${d > 0 ? "high" : "low"}`] }));
    }
  }

  // 3 SWEEP & RECLAIM — wick through a liquidity level within 3 bars, 5m close back inside.
  for (const lv of ctx.levels) {
    for (const side of ["BUY", "SELL"] as Side[]) {
      const d = dirOf(side);
      if (side === "BUY" && !/_L$|PDL/.test(lv.name)) continue;
      if (side === "SELL" && !/_H$|PDH/.test(lv.name)) continue;
      const w = hiLo(s.m5, i - 2, i);
      const extreme = d > 0 ? w.l : w.h;
      const depth = d > 0 ? lv.px - extreme : extreme - lv.px;
      if (depth < Math.max(0.2, 0.1 * a5) || depth > 1.5 * a15) continue;
      const reclaimed = d > 0 ? b.c > lv.px && loc >= 0.55 : b.c < lv.px && loc <= 0.45;
      // the level must have been intact before the sweep window (fresh liquidity)
      const before = hiLo(s.m5, i - 24, i - 3);
      const fresh = d > 0 ? before.l > lv.px : before.h < lv.px;
      if (!reclaimed || !fresh) continue;
      push(make(ctx, { playbook: "SWEEP_RECLAIM", side, anchor: `SR:${lv.name}:${lv.px.toFixed(2)}`, entryType: "MARKET", entry: b.c, ttlMin: 5, invalidation: extreme,
        f: { conf: d > 0 ? loc : 1 - loc, wick: (d > 0 ? lowerW : upperW) / Math.max(range, 1e-9), depthAtr: depth / a5, levelRank: /PD/.test(lv.name) ? 1 : /ASIA|LDN/.test(lv.name) ? 0.7 : 0.4 }, evidence: [`swept ${lv.name} ${lv.px.toFixed(2)} by $${depth.toFixed(2)} and reclaimed`] }));
    }
  }

  // 4 RANGE REJECTION — 15m range, 5m rejection candle at an edge.
  if (ctx.range15 && ctx.er15 <= 0.25 && ctx.range15.width >= 3 * a15 && ctx.range15.width <= 10 * a15 && ctx.range15.touchesH >= 2 && ctx.range15.touchesL >= 2) {
    const r = ctx.range15, mid = (r.high + r.low) / 2;
    for (const side of ["BUY", "SELL"] as Side[]) {
      const d = dirOf(side);
      const atEdge = d > 0 ? b.l <= r.low + 0.12 * r.width : b.h >= r.high - 0.12 * r.width;
      const wick = (d > 0 ? lowerW : upperW) / Math.max(range, 1e-9);
      const rej = wick >= 0.4 && (d > 0 ? loc >= 0.6 && b.c < mid : loc <= 0.4 && b.c > mid);
      if (!atEdge || !rej) continue;
      push(make(ctx, { playbook: "RANGE_REJECTION", side, anchor: `RR:${side}:${r.low.toFixed(1)}:${r.high.toFixed(1)}:${Math.floor(b.t / 3_600_000)}`, entryType: "MARKET", entry: b.c, ttlMin: 5, invalidation: d > 0 ? Math.min(b.l, r.low) : Math.max(b.h, r.high),
        f: { conf: d > 0 ? loc : 1 - loc, wick, edgeDist: Math.abs(b.c - (d > 0 ? r.low : r.high)) / r.width }, evidence: [`range ${r.low.toFixed(2)}–${r.high.toFixed(2)} rejection at the ${d > 0 ? "low" : "high"}`] }));
    }
  }

  // 5/6 COMPRESSION BREAKOUT and BREAKOUT RETEST — 3h 5m box narrower than 2.5×ATR15.
  for (let lag = 0; lag <= 24; lag++) {
    const j = i - lag; if (j < 40) break;
    const bx = hiLo(s.m5, j - 36, j - 1);
    if (bx.h - bx.l > 2.5 * s.m15.atr[Math.max(0, ctx.i15 - Math.ceil(lag / 3))]) continue;
    const bb = m5[j], bbody = Math.abs(bb.c - bb.o), aj = s.m5.atr[j];
    for (const side of ["BUY", "SELL"] as Side[]) {
      const d = dirOf(side);
      const edge = d > 0 ? bx.h : bx.l;
      const broke = bbody >= 0.8 * aj && (d > 0 ? bb.c > edge + 0.1 * aj : bb.c < edge - 0.1 * aj);
      if (!broke) continue;
      const key = `${side}:${bx.l.toFixed(1)}:${bx.h.toFixed(1)}`;
      if (lag === 0) {
        push(make(ctx, { playbook: "COMPRESSION_BREAKOUT", side, anchor: `CB:${key}`, entryType: "MARKET", entry: b.c, ttlMin: 5, invalidation: d > 0 ? Math.max(b.l, (bx.h + bx.l) / 2) : Math.min(b.h, (bx.h + bx.l) / 2),
          f: { conf: d > 0 ? loc : 1 - loc, disp: body / a5, boxAtr: (bx.h - bx.l) / a15 }, evidence: [`3h compression ${bx.l.toFixed(2)}–${bx.h.toFixed(2)} broken ${d > 0 ? "up" : "down"}`] }));
      } else if (lag >= 2) {
        const since = hiLo(s.m5, j + 1, i);
        const retest = d > 0 ? b.l <= edge + 0.25 * a5 && b.c > edge && loc >= 0.55 : b.h >= edge - 0.25 * a5 && b.c < edge && loc <= 0.45;
        const intact = d > 0 ? since.l > edge - 0.6 * a5 : since.h < edge + 0.6 * a5;
        const wentAway = d > 0 ? since.h > edge + 1.0 * a5 : since.l < edge - 1.0 * a5;
        if (retest && intact && wentAway) push(make(ctx, { playbook: "BREAKOUT_RETEST", side, anchor: `BR:${key}`, entryType: "MARKET", entry: b.c, ttlMin: 5, invalidation: d > 0 ? Math.min(b.l, edge - 0.3 * a5) : Math.max(b.h, edge + 0.3 * a5),
          f: { conf: d > 0 ? loc : 1 - loc, lag }, evidence: [`retest of broken compression edge ${edge.toFixed(2)} held`] }));
      }
      // FAILED BREAKOUT — broke, then a 5m close back inside the box within 6 bars
      if (lag >= 1 && lag <= 6) {
        const backIn = d > 0 ? b.c < edge - 0.1 * a5 : b.c > edge + 0.1 * a5;
        const firstBack = (() => { for (let k = j + 1; k < i; k++) if (d > 0 ? m5[k].c < edge : m5[k].c > edge) return false; return true; })();
        if (backIn && firstBack) {
          const ex = hiLo(s.m5, j, i);
          push(make(ctx, { playbook: "FAILED_BREAKOUT", side: d > 0 ? "SELL" : "BUY", anchor: `FB:${key}`, entryType: "MARKET", entry: b.c, ttlMin: 5, invalidation: d > 0 ? ex.h : ex.l,
            f: { conf: d > 0 ? 1 - loc : loc, lag }, evidence: [`breakout of ${edge.toFixed(2)} failed, closed back inside`] }));
        }
      }
    }
  }

  // 8 SESSION BREAK — London open breaks the Asian range; NY open breaks the London range.
  {
    const mins = (ctx.asOf % 86_400_000) / 60000;
    const win = mins >= 7 * 60 && mins <= 9 * 60 + 30 ? ctx.asia : mins >= 12 * 60 + 30 && mins <= 15 * 60 ? ctx.london : null;
    if (win) {
      for (const side of ["BUY", "SELL"] as Side[]) {
        const d = dirOf(side); const edge = d > 0 ? win.high : win.low;
        const sessStart = Math.floor(ctx.asOf / 86_400_000) * 86_400_000 + (mins >= 720 ? 750 : 420) * 60000;
        const first = (() => { for (let k = i - 1; k >= 0 && m5[k].t >= sessStart; k--) if (d > 0 ? m5[k].c > edge : m5[k].c < edge) return false; return true; })();
        const brk = body >= 0.7 * a5 && (d > 0 ? b.c > edge && loc >= 0.65 : b.c < edge && loc <= 0.35);
        if (brk && first) push(make(ctx, { playbook: "SESSION_BREAK", side, anchor: `SB:${side}:${Math.floor(ctx.asOf / 86_400_000)}:${mins >= 720 ? "NY" : "LDN"}`, entryType: "MARKET", entry: b.c, ttlMin: 5, invalidation: d > 0 ? Math.max(b.l, edge - 0.5 * a15) : Math.min(b.h, edge + 0.5 * a15),
          f: { conf: d > 0 ? loc : 1 - loc, disp: body / a5, rangeAtr: (win.high - win.low) / a15 }, evidence: [`${mins >= 720 ? "NY" : "London"} open broke the ${mins >= 720 ? "London" : "Asian"} range at ${edge.toFixed(2)}`] }));
      }
    }
  }

  // 9 BOS + FIRST PULLBACK — 5m close through a confirmed 5m swing, first return to the broken level holds.
  {
    const piv = confirmedPivots(s.m5, i - 1, 3, 2, 60);
    for (const side of ["BUY", "SELL"] as Side[]) {
      const d = dirOf(side);
      const sw = piv.filter((p) => p.kind === (d > 0 ? "high" : "low")).at(-1);
      if (!sw) continue;
      let brokeAt = -1;
      for (let k = sw.i + 3; k < i; k++) if (d > 0 ? m5[k].c > sw.price : m5[k].c < sw.price) { brokeAt = k; break; }
      if (brokeAt < 0 || i - brokeAt > 12 || i - brokeAt < 2) continue;
      const since = hiLo(s.m5, brokeAt + 1, i - 1);
      const away = d > 0 ? since.h > sw.price + 0.8 * a5 : since.l < sw.price - 0.8 * a5;
      const touch = d > 0 ? b.l <= sw.price + 0.25 * a5 && b.c > sw.price && loc >= 0.55 : b.h >= sw.price - 0.25 * a5 && b.c < sw.price && loc <= 0.45;
      const firstTouch = d > 0 ? since.l > sw.price + 0.25 * a5 : since.h < sw.price - 0.25 * a5;
      if (away && touch && firstTouch) push(make(ctx, { playbook: "BOS_PULLBACK", side, anchor: `BP:${side}:${sw.t}`, entryType: "MARKET", entry: b.c, ttlMin: 5, invalidation: d > 0 ? Math.min(b.l, sw.price - 0.3 * a5) : Math.max(b.h, sw.price + 0.3 * a5),
        f: { conf: d > 0 ? loc : 1 - loc }, evidence: [`5m structure break of ${sw.price.toFixed(2)}, first pullback held`] }));
    }
  }
  return out;
}

/** ARMED setups: structure is in place at the 5m close, the trigger is a pre-defined level that a
 *  later CLOSED 1m bar must close through (EARLY STRUCTURAL ENTRY). Stop/invalidation fixed now. */
export type Armed = { playbook: Playbook; side: Side; anchor: string; trigger: number; invalidation: number; armedAt: number; expiresAt: number; f: Record<string, number>; evidence: string[] };

export function generateArmed(s: Series, ctx: Ctx): Armed[] {
  const out: Armed[] = [];
  const m5 = s.m5.bars, i = ctx.i5, b = m5[i];
  const a5 = ctx.atr5, a15 = ctx.atr15;
  const exp = ctx.asOf + 10 * 60000;
  for (const side of ["BUY", "SELL"] as Side[]) {
    const d = dirOf(side);
    // TREND PULLBACK armed: in the EMA20 zone, trend intact, last 5m did NOT yet break back.
    if (ctx.trend15 === d) {
      const e20 = s.m15.ema20[ctx.i15], e50 = s.m15.ema50[ctx.i15];
      const w = hiLo(s.m5, i - 11, i); const extreme = d > 0 ? w.l : w.h;
      const touched = d > 0 ? extreme <= e20 + 0.25 * a15 : extreme >= e20 - 0.25 * a15;
      const held = d > 0 ? extreme > e50 - 0.5 * a15 : extreme < e50 + 0.5 * a15;
      const notYet = d > 0 ? b.c <= m5[i - 1].h : b.c >= m5[i - 1].l;
      if (touched && held && notYet) {
        const k = m5.findIndex((x, j) => j >= i - 11 && (d > 0 ? x.l === extreme : x.h === extreme));
        out.push({ playbook: "TREND_PULLBACK", side, anchor: `TP:${side}:${m5[k]?.t}`, trigger: d > 0 ? b.h : b.l, invalidation: extreme, armedAt: ctx.asOf, expiresAt: exp, f: { depth: Math.abs(e20 - extreme) / a15 }, evidence: [`armed pullback in 15m ${d > 0 ? "up" : "down"}trend; trigger ${d > 0 ? "above" : "below"} ${(d > 0 ? b.h : b.l).toFixed(2)}`] });
      }
    }
    // SWEEP armed: wick through a fresh level in the last 2 bars, not reclaimed on a 5m close yet.
    for (const lv of ctx.levels) {
      if (side === "BUY" && !/_L$|PDL/.test(lv.name)) continue;
      if (side === "SELL" && !/_H$|PDH/.test(lv.name)) continue;
      const w = hiLo(s.m5, i - 1, i); const extreme = d > 0 ? w.l : w.h;
      const depth = d > 0 ? lv.px - extreme : extreme - lv.px;
      if (depth < Math.max(0.2, 0.1 * a5) || depth > 1.5 * a15) continue;
      const before = hiLo(s.m5, i - 24, i - 2); const fresh = d > 0 ? before.l > lv.px : before.h < lv.px;
      const notReclaimed = d > 0 ? b.c <= lv.px : b.c >= lv.px;
      if (fresh && notReclaimed) out.push({ playbook: "SWEEP_RECLAIM", side, anchor: `SR:${lv.name}:${lv.px.toFixed(2)}`, trigger: lv.px + d * 0.05, invalidation: extreme, armedAt: ctx.asOf, expiresAt: exp, f: { depthAtr: depth / a5, levelRank: /PD/.test(lv.name) ? 1 : /ASIA|LDN/.test(lv.name) ? 0.7 : 0.4 }, evidence: [`${lv.name} ${lv.px.toFixed(2)} swept by $${depth.toFixed(2)}; trigger on a 1m close back ${d > 0 ? "above" : "below"}`] });
    }
  }
  return out;
}

/** Deterministic early trigger on the latest CLOSED 1m bar. Returns a candidate or null. */
export function earlyTrigger(s: Series, ctx: Ctx, a: Armed, i1: number): Cand | null {
  const bar = s.m1.bars[i1]; if (!bar || bar.t + 60000 > ctx.asOf || bar.t + 60000 <= a.armedAt || ctx.asOf > a.expiresAt) return null;
  const d = dirOf(a.side);
  if (d > 0 ? bar.l <= a.invalidation : bar.h >= a.invalidation) return null;               // invalidated
  const through = d > 0 ? bar.c > a.trigger && bar.c > bar.o : bar.c < a.trigger && bar.c < bar.o;
  const loc = cloc(bar);
  if (!through || (d > 0 ? loc < 0.6 : loc > 0.4)) return null;
  if (Math.abs(bar.c - a.trigger) > 0.5 * ctx.atr5) return null;                              // not chasing
  return make(ctx, { playbook: a.playbook, side: a.side, anchor: a.anchor, entryType: "MARKET", entry: bar.c, ttlMin: 3, invalidation: a.invalidation, f: { ...a.f, conf: d > 0 ? loc : 1 - loc, early: 1 }, evidence: [...a.evidence, `1m close ${bar.c.toFixed(2)} through trigger (early structural entry)`] });
}
