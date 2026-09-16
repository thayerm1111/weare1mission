/**
 * GENX 3.2 setup engines. Each engine has an explicit market-structure rationale, returns
 * CANDIDATES (structure complete, trigger fired on a CLOSED bar) and WAITS (structure forming,
 * trigger not yet fired) so the funnel can show what GENX was watching.
 * All inputs are closed bars: 1m bars closed by asOf, 5m/15m/1H/4H bars whose period elapsed.
 */
import type { Bar } from "../candles";
import { type Series, hiLo, confirmedPivots, lastClosed } from "../v31/series";
import type { Ctx } from "../v31/context";
import { findBreak, type StateResult } from "./state";

export type Setup32 = "SESSION_BREAK" | "BOS_PULLBACK" | "MICRO_CONTINUATION" | "BREAKOUT_RETEST_V2" | "COMPRESSION_EXPANSION" | "SWEEP_RECLAIM_DISPLACEMENT" | "TREND_REENTRY" | "MOMENTUM_EXPANSION";
export type Side = "BUY" | "SELL";
export type Cand32 = {
  setup: Setup32; side: Side; anchor: string;
  entry: number; invalidation: number; stop: number; risk: number;
  targetR: number; target: number; roomR: number;          // roomR = structural room to the nearest opposing level, in R
  feats: Record<string, number>;                          // 0..1 evidence used by the setup's score
  evidence: string[]; hard: string[];                     // hard invalidations found by the engine itself
};
export type Wait32 = { setup: Setup32; side: Side; anchor: string; reason: string };
export type EngineOut = { cands: Cand32[]; waits: Wait32[] };

const dirOf = (s: Side) => (s === "BUY" ? 1 : -1);
const cloc = (b: Bar) => (b.h > b.l ? (b.c - b.l) / (b.h - b.l) : 0.5);
const clamp = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

/** Shared: structural stop, room to the nearest opposing liquidity, target capped by structure. */
export function finish(ctx: Ctx, p: { setup: Setup32; side: Side; anchor: string; entry: number; invalidation: number; targetR: number; feats: Record<string, number>; evidence: string[]; hard?: string[] }): Cand32 | null {
  const d = dirOf(p.side);
  const stop = +(p.invalidation - d * (0.1 * ctx.atr5 + 0.3)).toFixed(2);
  const risk = d * (p.entry - stop);
  if (!(risk > 0)) return null;
  const opp = ctx.levels.map((l) => l.px).filter((px) => d * (px - p.entry) > 0.25 * risk).sort((a, b) => d * (a - b));
  const roomR = opp.length ? d * (opp[0] - p.entry) / risk : 6;
  const target = +(p.entry + d * p.targetR * risk).toFixed(2);
  const htf1 = p.side === "BUY" ? ctx.bias1h : -ctx.bias1h, htf4 = p.side === "BUY" ? ctx.bias4h : -ctx.bias4h;
  return { ...p, stop, risk: +risk.toFixed(2), target, roomR: +roomR.toFixed(2), hard: p.hard ?? [],
    feats: { ...p.feats, htf1: (htf1 + 1) / 2, htf4: (htf4 + 1) / 2, room: clamp(roomR / (p.targetR + 1)), session: ctx.session === "LONDON" || ctx.session === "NY" ? 1 : ctx.session === "ASIA" ? 0.6 : 0.3, riskAtr15: risk / ctx.atr15 } };
}

// ── MICRO STRUCTURE CONTINUATION ─────────────────────────────────────────────────────────────
// Rationale: inside an established directional move, controlled (slow, shallow) pullbacks show
// absent counter-pressure; the first 5m+1m turn back in trend direction resumes the move. This
// captures the 2nd/3rd entries inside moves that do not print a fresh 15m BOS.
export function microContinuation(s: Series, ctx: Ctx, st: StateResult): EngineOut {
  const out: EngineOut = { cands: [], waits: [] };
  const dir = st.trend15 !== 0 && (st.trend1h === st.trend15 || st.trend1h === 0) ? st.trend15 : 0;
  if (!dir || st.er15 < 0.2) return out;
  const side: Side = dir > 0 ? "BUY" : "SELL";
  const m5 = s.m5.bars, i = ctx.i5, a5 = ctx.atr5;
  // impulse: the strongest directional leg in the last 24 5m bars, ending 2–12 bars ago
  let best: { start: number; end: number; size: number } | null = null;
  for (let e = i - 2; e >= i - 12; e--) for (let st0 = e - 1; st0 >= e - 12 && st0 > 0; st0--) {
    const size = dir > 0 ? m5[e].h - m5[st0].l : m5[st0].h - m5[e].l;
    if (size > 0 && (!best || size > best.size)) best = { start: st0, end: e, size };
  }
  if (!best || best.size < 1.8 * ctx.atr15) return out;
  const legEnd = dir > 0 ? m5[best.end].h : m5[best.end].l, legStart = dir > 0 ? m5[best.start].l : m5[best.start].h;
  const since = hiLo(s.m5, best.end + 1, i);
  const extreme = dir > 0 ? since.l : since.h;
  const newExtreme = dir > 0 ? since.h > legEnd : since.l < legEnd;
  if (newExtreme) return out;                                  // the impulse is still extending — no pullback yet
  const depth = Math.abs(legEnd - extreme) / best.size;
  const anchor = `MC32:${side}:${m5[best.end].t}`;
  const impulseAvg = avgRange(m5, best.start, best.end), pullAvg = avgRange(m5, best.end + 1, i);
  const controlled = pullAvg <= 0.85 * impulseAvg && i - best.end >= 2;
  if (depth < 0.2) { out.waits.push({ setup: "MICRO_CONTINUATION", side, anchor, reason: `pullback only ${(depth * 100).toFixed(0)}% of impulse` }); return out; }
  if (depth > 0.55) return out;                                // too deep: no longer a continuation structure
  if (!controlled) { out.waits.push({ setup: "MICRO_CONTINUATION", side, anchor, reason: "pullback not controlled (fast/large candles)" }); return out; }
  const b = m5[i], pb = m5[i - 1], b1 = s.m1.bars[ctx.i1], b1p = s.m1.bars[ctx.i1 - 1];
  const turn5 = dir > 0 ? b.c > pb.h && cloc(b) >= 0.6 : b.c < pb.l && cloc(b) <= 0.4;
  const conf1 = dir > 0 ? b1.c > b1.o && b1.c >= b1p.h : b1.c < b1.o && b1.c <= b1p.l;
  if (!turn5 || !conf1) { out.waits.push({ setup: "MICRO_CONTINUATION", side, anchor, reason: !turn5 ? "waiting for 5m turn" : "waiting for 1m confirmation" }); return out; }
  const c = finish(ctx, { setup: "MICRO_CONTINUATION", side, anchor, entry: b1.c, invalidation: extreme, targetR: 2.5,
    feats: { impulse: clamp(best.size / (4 * ctx.atr15)), depth: clamp(1 - Math.abs(depth - 0.38) / 0.3), control: clamp(1 - pullAvg / impulseAvg), turn: dir > 0 ? cloc(b) : 1 - cloc(b), er: clamp(st.er15 / 0.5) },
    evidence: [`impulse $${best.size.toFixed(2)} (${(best.size / ctx.atr15).toFixed(1)}×ATR15)`, `controlled pullback ${(depth * 100).toFixed(0)}%`, "5m close through prior bar + 1m confirmation"] });
  if (c) { if (Math.abs(legEnd - c.entry) < 0.5 * c.risk && c.roomR > 1) c.hard.push("impulse extreme too close: continuation must first break it"); out.cands.push(c); }
  void legStart; void a5;
  return out;
}
function avgRange(b: Bar[], from: number, to: number): number { let s = 0, n = 0; for (let k = Math.max(0, from); k <= to; k++) { s += b[k].h - b[k].l; n++; } return n ? s / n : 0; }

// ── BREAKOUT → RETEST ────────────────────────────────────────────────────────────────────────
// Rationale: a level broken with displacement and ACCEPTED (price travels away) tends to flip
// role; the first retest that is rejected on 5m+1m offers continuation with a tight invalidation.
export function breakoutRetest(s: Series, ctx: Ctx): EngineOut {
  const out: EngineOut = { cands: [], waits: [] };
  const br = findBreak(s, ctx, 36);
  if (!br || ctx.i5 - br.i5 < 3) return out;
  const side: Side = br.dir > 0 ? "BUY" : "SELL", d = br.dir, a5 = ctx.atr5, m5 = s.m5.bars, i = ctx.i5;
  const anchor = `BR32:${br.name}:${br.level.toFixed(2)}:${br.barT}`;
  const between = hiLo(s.m5, br.i5 + 1, i - 1);
  const accepted = d > 0 ? between.h >= br.level + 1.0 * ctx.atr15 : between.l <= br.level - 1.0 * ctx.atr15;
  const closedBack = (() => { for (let k = br.i5 + 1; k <= i; k++) if (d > 0 ? m5[k].c < br.level - 0.3 * a5 : m5[k].c > br.level + 0.3 * a5) return true; return false; })();
  if (closedBack) return out;
  if (!accepted) { out.waits.push({ setup: "BREAKOUT_RETEST_V2", side, anchor, reason: "break not yet accepted (price has not travelled 1×ATR15 away)" }); return out; }
  const priorTouch = d > 0 ? between.l <= br.level + 0.25 * a5 && m5.slice(br.i5 + 2, i).some((x) => x.l <= br.level + 0.25 * a5) : m5.slice(br.i5 + 2, i).some((x) => x.h >= br.level - 0.25 * a5);
  if (priorTouch) return out;                                   // only the FIRST meaningful retest
  const b = m5[i], b1 = s.m1.bars[ctx.i1];
  const touch = d > 0 ? b.l <= br.level + 0.25 * a5 : b.h >= br.level - 0.25 * a5;
  if (!touch) { out.waits.push({ setup: "BREAKOUT_RETEST_V2", side, anchor, reason: `waiting for retest of ${br.level.toFixed(2)}` }); return out; }
  const reject5 = d > 0 ? b.c > br.level && cloc(b) >= 0.6 : b.c < br.level && cloc(b) <= 0.4;
  const conf1 = d > 0 ? b1.c > b1.o : b1.c < b1.o;
  if (!reject5 || !conf1) { out.waits.push({ setup: "BREAKOUT_RETEST_V2", side, anchor, reason: "retest touched, waiting for 5m rejection + 1m confirmation" }); return out; }
  const inv = d > 0 ? Math.min(b.l, br.level - 0.5 * a5) : Math.max(b.h, br.level + 0.5 * a5);
  const c = finish(ctx, { setup: "BREAKOUT_RETEST_V2", side, anchor, entry: b1.c, invalidation: inv, targetR: 3,
    feats: { level: br.kind === "level" ? (/PD/.test(br.name) ? 1 : 0.8) : 0.6, acceptance: clamp(Math.abs((d > 0 ? between.h : between.l) - br.level) / (3 * ctx.atr15)), reject: d > 0 ? cloc(b) : 1 - cloc(b), fresh: clamp(1 - (i - br.i5) / 36) },
    evidence: [`${br.name} ${br.level.toFixed(2)} broken with displacement and accepted`, "first retest rejected on 5m, 1m confirms"] });
  if (c) out.cands.push(c);
  return out;
}

// ── COMPRESSION → EXPANSION ──────────────────────────────────────────────────────────────────
// Rationale: volatility clusters; after contraction (falling ATR + realized vol, boundary tests)
// a body-dominant close outside the box with range expansion signals a new directional phase.
export function compressionExpansion(s: Series, ctx: Ctx, st: StateResult, prevCompression: StateResult["compression"]): EngineOut {
  const out: EngineOut = { cands: [], waits: [] };
  const box = st.compression ?? prevCompression;
  if (!box) return out;
  const b = s.m5.bars[ctx.i5], a5 = s.m5.atr[ctx.i5 - 1] || ctx.atr5, body = Math.abs(b.c - b.o), rng = b.h - b.l;
  for (const side of ["BUY", "SELL"] as Side[]) {
    const d = dirOf(side), edge = d > 0 ? box.high : box.low;
    const anchor = `CE32:${side}:${box.low.toFixed(1)}:${box.high.toFixed(1)}`;
    const outside = d * (b.c - edge) >= 0.2 * a5;
    const wickOnly = d * ((d > 0 ? b.h : b.l) - edge) > 0 && !outside;
    if (wickOnly) { out.waits.push({ setup: "COMPRESSION_EXPANSION", side, anchor, reason: "wick outside compression without a close — not leaving" }); continue; }
    if (!outside) continue;
    const strong = body >= 1.0 * a5 && body >= 0.6 * rng && (d > 0 ? cloc(b) >= 0.7 : cloc(b) <= 0.3);
    const b1 = s.m1.bars[ctx.i1];
    const follow = d > 0 ? b1.c >= b.c - 0.1 * a5 : b1.c <= b.c + 0.1 * a5;
    if (!strong) { out.waits.push({ setup: "COMPRESSION_EXPANSION", side, anchor, reason: "close outside but no displacement (body/close location)" }); continue; }
    if (!follow) { out.waits.push({ setup: "COMPRESSION_EXPANSION", side, anchor, reason: "no immediate 1m follow-through" }); continue; }
    const mid = (box.high + box.low) / 2;
    const c = finish(ctx, { setup: "COMPRESSION_EXPANSION", side, anchor, entry: b1.c, invalidation: d > 0 ? Math.max(mid, b.l) : Math.min(mid, b.h),
      targetR: Math.max(2, Math.min(4, (1.5 * box.width) / Math.max(Math.abs(b1.c - mid), 1e-9))),
      feats: { tight: clamp(1 - box.width / (3 * ctx.atr15)), contraction: clamp(-box.atrSlope / 0.3), displacement: clamp(body / (2 * a5)), tests: clamp((box.touchesH + box.touchesL) / 8), expansion: clamp(rng / (2.5 * a5)) },
      evidence: [`compression ${box.low.toFixed(2)}–${box.high.toFixed(2)} (ATR ${(box.atrSlope * 100).toFixed(0)}%)`, `5m body ${(body / a5).toFixed(1)}×ATR5 closed ${d > 0 ? "above" : "below"}, 1m follow-through`] });
    if (c) out.cands.push(c);
  }
  return out;
}

// ── LIQUIDITY SWEEP → RECLAIM → DISPLACEMENT → MICRO STRUCTURE CHANGE ──────────────────────────
// Rationale: stops resting beyond obvious liquidity are taken; if price immediately reclaims,
// displaces the other way and breaks 1m structure, the move was a liquidity grab, not acceptance.
// A wick alone is never enough — all four steps must be present in order.
export function sweepReclaimDisplacement(s: Series, ctx: Ctx): EngineOut {
  const out: EngineOut = { cands: [], waits: [] };
  const m5 = s.m5.bars, i = ctx.i5, a5 = ctx.atr5;
  const levels = [...ctx.levels];
  // equal highs / lows from confirmed 15m pivots (two within 0.15×ATR15)
  const piv = confirmedPivots(s.m15, ctx.i15, 3, 2, 96);
  for (const kind of ["high", "low"] as const) {
    const ps = piv.filter((p) => p.kind === kind);
    for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) if (Math.abs(ps[a].price - ps[b].price) <= 0.15 * ctx.atr15) levels.push({ name: kind === "high" ? "EQ_H" : "EQ_L", px: kind === "high" ? Math.max(ps[a].price, ps[b].price) : Math.min(ps[a].price, ps[b].price) });
  }
  for (const lv of levels) {
    const isLow = /_L$|PDL|SWING_L/.test(lv.name), side: Side = isLow ? "BUY" : "SELL", d = dirOf(side);
    // 1) sweep: a 5m bar in the last 6 traded beyond the level by 0.2×ATR5..1.5×ATR15
    let sw = -1;
    for (let k = i; k >= i - 5; k--) { const depth = d > 0 ? lv.px - m5[k].l : m5[k].h - lv.px; if (depth >= Math.max(0.2, 0.2 * a5) && depth <= 1.5 * ctx.atr15) { sw = k; break; } }
    if (sw < 0) continue;
    const before = hiLo(s.m5, sw - 24, sw - 1);
    if (d > 0 ? before.l <= lv.px : before.h >= lv.px) continue;          // level must be untouched liquidity
    const anchor = `SW32:${lv.name}:${lv.px.toFixed(2)}:${m5[sw].t}`;
    const sweepExt = d > 0 ? hiLo(s.m5, sw, i).l : hiLo(s.m5, sw, i).h;
    // 2) reclaim: a 5m close back inside
    let rc = -1; for (let k = sw; k <= i; k++) if (d > 0 ? m5[k].c > lv.px : m5[k].c < lv.px) { rc = k; break; }
    if (rc < 0) { out.waits.push({ setup: "SWEEP_RECLAIM_DISPLACEMENT", side, anchor, reason: "swept, no reclaim yet" }); continue; }
    // 3) displacement: a 5m bar at/after reclaim with body ≥1.2×ATR5 in the reversal direction
    let dp = -1; for (let k = rc; k <= i; k++) { const bb = m5[k]; if (d * (bb.c - bb.o) >= 1.2 * a5) { dp = k; break; } }
    if (dp < 0) { out.waits.push({ setup: "SWEEP_RECLAIM_DISPLACEMENT", side, anchor, reason: "reclaimed, waiting for displacement" }); continue; }
    // 4) micro structure change: latest closed 1m closes beyond the last confirmed 1m swing formed after the sweep
    const p1 = confirmedPivots(s.m1, ctx.i1 - 1, 2, 2, 40).filter((p) => p.kind === (d > 0 ? "high" : "low") && p.t >= m5[sw].t);
    const b1 = s.m1.bars[ctx.i1];
    const mss = p1.length > 0 && (d > 0 ? b1.c > p1.at(-1)!.price : b1.c < p1.at(-1)!.price);
    if (!mss) { out.waits.push({ setup: "SWEEP_RECLAIM_DISPLACEMENT", side, anchor, reason: "displacement seen, waiting for 1m structure change" }); continue; }
    if (i - dp > 3) continue;                                                  // sequence must be fresh
    const c = finish(ctx, { setup: "SWEEP_RECLAIM_DISPLACEMENT", side, anchor, entry: b1.c, invalidation: sweepExt, targetR: 3,
      feats: { level: /PD|EQ/.test(lv.name) ? 1 : /ASIA|LDN/.test(lv.name) ? 0.8 : 0.6, displacement: clamp(Math.abs(m5[dp].c - m5[dp].o) / (2.5 * a5)), speed: clamp(1 - (dp - sw) / 6), depth: clamp(1 - Math.abs((d > 0 ? lv.px - sweepExt : sweepExt - lv.px) / ctx.atr15 - 0.5)) },
      evidence: [`swept ${lv.name} ${lv.px.toFixed(2)} to ${sweepExt.toFixed(2)}`, "reclaimed on 5m close", `displacement ${(Math.abs(m5[dp].c - m5[dp].o) / a5).toFixed(1)}×ATR5`, "1m structure broke"] });
    if (c) out.cands.push(c);
  }
  return out;
}

// ── TREND RE-ENTRY ───────────────────────────────────────────────────────────────────────────
// Rationale: strong 1H trends are re-joined after 15m retracements into dynamic value (15m EMA50 /
// 1H EMA20) once the 5m structure turns. 4H disagreement is allowed only when the 4H is not itself
// trending efficiently against the trade (otherwise it is a counter-trend trade: hard fail).
export function trendReentry(s: Series, ctx: Ctx, st: StateResult): EngineOut {
  const out: EngineOut = { cands: [], waits: [] };
  if (st.trend1h === 0 || st.er1h < 0.3) return out;
  const d = st.trend1h, side: Side = d > 0 ? "BUY" : "SELL";
  const i15 = ctx.i15, m15 = s.m15.bars;
  const valueA = s.m15.ema50[i15], valueB = s.h1.ema20[ctx.i1h], tol = 0.3 * ctx.atr15;
  let touched = -1;
  for (let k = i15; k >= i15 - 8; k--) { const x = m15[k]; if (d > 0 ? x.l <= Math.max(valueA, valueB) + tol : x.h >= Math.min(valueA, valueB) - tol) { touched = k; break; } }
  const anchor = `TR32:${side}:${touched >= 0 ? m15[touched].t : 0}`;
  if (touched < 0) return out;
  const pull = hiLo(s.m15, touched - 4, i15);
  const pullExt = d > 0 ? pull.l : pull.h;
  if (d > 0 ? s.m15.bars[i15].c < s.h1.ema50[ctx.i1h] : s.m15.bars[i15].c > s.h1.ema50[ctx.i1h]) return out;   // retracement broke the 1H trend value
  const piv5 = confirmedPivots(s.m5, ctx.i5 - 1, 3, 2, 24).filter((p) => p.kind === (d > 0 ? "high" : "low") && p.t >= m15[Math.max(0, touched - 4)].t);
  const b5 = s.m5.bars[ctx.i5], b1 = s.m1.bars[ctx.i1];
  const turn = piv5.length > 0 && (d > 0 ? b5.c > piv5.at(-1)!.price : b5.c < piv5.at(-1)!.price);
  if (!turn) { out.waits.push({ setup: "TREND_REENTRY", side, anchor, reason: "in 1H value zone, waiting for 5m structure to turn" }); return out; }
  const conf1 = d > 0 ? b1.c > b1.o && cloc(b1) >= 0.6 : b1.c < b1.o && cloc(b1) <= 0.4;
  if (!conf1) { out.waits.push({ setup: "TREND_REENTRY", side, anchor, reason: "5m turned, waiting for 1m confirmation" }); return out; }
  const hard: string[] = [];
  const h4Against = ctx.bias4h === -d;
  const er4 = (() => { const i4 = ctx.i4h; if (i4 < 13) return 0; let p = 0; for (let k = i4 - 11; k <= i4; k++) p += Math.abs(s.h4.bars[k].c - s.h4.bars[k - 1].c); return p > 0 ? Math.abs(s.h4.bars[i4].c - s.h4.bars[i4 - 12].c) / p : 0; })();
  if (h4Against && er4 >= 0.35) hard.push(`4H trending against the trade (efficiency ${er4.toFixed(2)}) — excessive risk`);
  const c = finish(ctx, { setup: "TREND_REENTRY", side, anchor, entry: b1.c, invalidation: pullExt, targetR: 3, hard,
    feats: { er1h: clamp(st.er1h / 0.6), value: clamp(1 - Math.abs((d > 0 ? pullExt - Math.max(valueA, valueB) : Math.min(valueA, valueB) - pullExt)) / ctx.atr15), turn: d > 0 ? cloc(b5) : 1 - cloc(b5), h4agree: h4Against ? 0 : ctx.bias4h === d ? 1 : 0.5 },
    evidence: [`1H trend (efficiency ${st.er1h.toFixed(2)}), 15m retraced into value`, "5m structure turned, 1m confirms", h4Against ? `4H disagrees but is not trending (efficiency ${er4.toFixed(2)})` : "4H not against"] });
  if (c) out.cands.push(c);
  return out;
}

// ── MOMENTUM EXPANSION ───────────────────────────────────────────────────────────────────────
// Rationale: abnormal ATR-normalised acceleration through meaningful structure (news/flow
// driven) often continues without a retest. Entry only while the move is young: distance
// travelled and chase are hard-limited, and the stop sits at the expansion bar midpoint.
export function momentumExpansion(s: Series, ctx: Ctx): EngineOut {
  const out: EngineOut = { cands: [], waits: [] };
  const i = ctx.i5, b = s.m5.bars[i], a5 = s.m5.atr[i - 1] || ctx.atr5, rng = b.h - b.l, body = Math.abs(b.c - b.o);
  if (rng < 2.2 * a5 || body < 0.7 * rng) return out;
  const d: 1 | -1 = b.c > b.o ? 1 : -1, side: Side = d > 0 ? "BUY" : "SELL";
  const br = findBreak(s, ctx, 1);
  const anchor = `ME32:${side}:${b.t}`;
  if (!br || br.i5 !== i || br.dir !== d) { out.waits.push({ setup: "MOMENTUM_EXPANSION", side, anchor, reason: "fast bar but no meaningful structure broken" }); return out; }
  // velocity on 1m: the last 5 closed 1m bars moved ≥1.5×ATR5 in direction
  const i1 = ctx.i1, v1 = d * (s.m1.bars[i1].c - s.m1.bars[i1 - 5].c);
  const b1 = s.m1.bars[i1];
  if (v1 < 1.5 * a5) { out.waits.push({ setup: "MOMENTUM_EXPANSION", side, anchor, reason: "1m velocity faded" }); return out; }
  const travelled = d * (b1.c - br.level);
  const hard: string[] = [];
  if (travelled > 1.5 * ctx.atr15) hard.push(`already ${(travelled / ctx.atr15).toFixed(1)}×ATR15 beyond the break — extended`);
  if (d > 0 ? cloc(b1) < 0.6 : cloc(b1) > 0.4) hard.push("last 1m bar not following through");
  const c = finish(ctx, { setup: "MOMENTUM_EXPANSION", side, anchor, entry: b1.c, invalidation: (b.h + b.l) / 2, targetR: 2, hard,
    feats: { expansion: clamp(rng / (4 * a5)), body: clamp(body / rng), velocity: clamp(v1 / (3 * a5)), young: clamp(1 - travelled / (1.5 * ctx.atr15)) },
    evidence: [`5m expansion ${(rng / a5).toFixed(1)}×ATR5 through ${br.name} ${br.level.toFixed(2)}`, `1m velocity ${(v1 / a5).toFixed(1)}×ATR5`] });
  if (c) out.cands.push(c);
  void lastClosed;
  return out;
}
