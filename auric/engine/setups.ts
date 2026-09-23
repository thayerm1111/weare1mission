import type { Bar, Candidate, Features, Pivot, Quote, Regime, Rejection, Side, SetupFamily, RangeCandidate } from "../core/types";
import type { AuricConfig } from "../config/defaults";
import { bodyRatio, wickRejection } from "./features";
import { estimateCosts, netRewardRisk } from "./costs";
import { selectTarget, stopBuffer, stopFromInvalidation } from "./protection";

export type SetupContext = {
  cfg: AuricConfig;
  m1: Bar[];            // CLOSED M1 bars, oldest → newest
  m5: Bar[];            // CLOSED M5 bars
  f: Features;
  quote: Quote;         // executable broker quote
  tick: number;
  contractSize: number | null;
  now: number;
  regime: Regime;
};

/** Persistent state between evaluations (in memory; snapshotted to auric_engine_state for restarts). */
export type SetupState = {
  compression: CompressionCandidate | null;
  rangeFailedBreaks: Record<string, number>;   // range id → consecutive failed breaks
  lastRangeProbe: { rangeId: string; side: Side; barT: number } | null;
  seen: string[];                                // setupIds already emitted (bounded)
};
export const emptySetupState = (): SetupState => ({ compression: null, rangeFailedBreaks: {}, lastRangeProbe: null, seen: [] });

export type CompressionCandidate = {
  id: string; hi: number; lo: number; createdAt: number; createdIndexT: number;
  breakout: { side: Side; barT: number; barIndex: number; close: number } | null;
  retest: { barT: number; low: number; high: number } | null;
  expiresAfterBarT: number | null;
  invalidated: boolean; reason?: string;
};

const rej = (stage: string, code: string, detail: string, family?: SetupFamily): Rejection => ({ at: 0, stage, code, detail, family });

function nearestOpposing(side: Side, entry: number, highs: Pivot[], lows: Pivot[], nowIndex: number): number | null {
  const ps = (side === "buy" ? highs : lows).filter((p) => p.confirmedAtIndex <= nowIndex);
  const c = ps.map((p) => p.price).filter((p) => (side === "buy" ? p > entry : p < entry));
  if (!c.length) return null;
  return side === "buy" ? Math.min(...c) : Math.max(...c);
}

function finalize(
  ctx: SetupContext, family: SetupFamily, variant: string, side: Side, invalidation: number, opposing: number | null,
  trigger: string, entryCondition: string, expiresAt: number, reasons: string[], frozen: Record<string, number>, setupKey: string,
): { candidate?: Candidate; rejections: Rejection[] } {
  const { cfg, quote, tick, f } = ctx;
  const rejections: Rejection[] = [];
  const costs = estimateCosts(side, quote, { tickSize: tick, contractSize: ctx.contractSize }, cfg.sizing);
  const buffer = stopBuffer(costs.spread, f.atrM5, tick, cfg.protection);
  const stop = stopFromInvalidation(side, invalidation, buffer, tick);
  const entry = costs.entryPrice;
  if (side === "buy" ? stop >= entry : stop <= entry) { rejections.push(rej("protection", "STOP_ON_WRONG_SIDE", `stop ${stop} not beyond entry ${entry}`, family)); return { rejections }; }
  const tgt = selectTarget(side, entry, opposing, f.atrM5, tick, cfg.setups, buffer);
  if (!tgt) { rejections.push(rej("target", "INSUFFICIENT_ROOM", `opposing structure ${opposing?.toFixed(2) ?? "n/a"} leaves less than $${cfg.setups.targetMinUsd} of room from ${entry.toFixed(2)}`, family)); return { rejections }; }
  const rr = netRewardRisk(side, entry, stop, tgt.target, costs.totalExtraPrice);
  if (rr < cfg.setups.minRewardRisk) { rejections.push(rej("rr", "RR_TOO_LOW", `net R:R ${rr.toFixed(2)} < ${cfg.setups.minRewardRisk} (risk ${Math.abs(entry - stop).toFixed(2)}, reward ${tgt.usd.toFixed(2)}, extra costs ${costs.totalExtraPrice.toFixed(2)})`, family)); return { rejections }; }
  const riskDist = Math.abs(entry - stop);
  if (costs.spread / riskDist > cfg.breakers.maxSpreadToStopRatio) { rejections.push(rej("spread", "SPREAD_VS_STOP", `spread ${costs.spread.toFixed(2)} is ${(100 * costs.spread / riskDist).toFixed(0)}% of stop distance`, family)); return { rejections }; }
  if (costs.spread / tgt.usd > cfg.breakers.maxSpreadToTargetRatio) { rejections.push(rej("spread", "SPREAD_VS_TARGET", `spread ${costs.spread.toFixed(2)} is ${(100 * costs.spread / tgt.usd).toFixed(0)}% of target`, family)); return { rejections }; }
  const candidate: Candidate = {
    setupId: `${family}:${variant}:${setupKey}`, family, variant, strategyVersion: cfg.version, side, regime: ctx.regime,
    createdAt: ctx.now,
    sourceTimestamps: { m1Close: ctx.m1[ctx.m1.length - 1].t, m5Close: ctx.m5[ctx.m5.length - 1].t, quoteReceivedAt: quote.receivedAt },
    trigger, entryCondition, expiresAt, invalidation, plannedStop: stop, plannedTarget: tgt.target, targetUsd: tgt.usd,
    estCostUsdPerUnit: costs.totalExtraPrice, rewardRiskNet: rr,
    reasons: [...reasons, `target: ${tgt.reason}`, `stop buffer ${buffer.toFixed(2)} = max(${cfg.protection.bufferSpreadMult}×spread ${costs.spread.toFixed(2)}, ${cfg.protection.bufferAtrMult}×ATR ${f.atrM5.toFixed(2)}, tick)`],
    frozen: { ...frozen, invalidation, stop, target: tgt.target, entryRef: entry },
  };
  return { candidate, rejections };
}

/* ------------------------------------------------------------------ A. TREND PULLBACK CONTINUATION */
export function trendPullback(ctx: SetupContext): { candidate?: Candidate; rejections: Rejection[] } {
  const { cfg, m1, m5, f } = ctx; const fam: SetupFamily = "TREND_PULLBACK";
  const R: Rejection[] = [];
  const side: Side | null = ctx.regime === "UPTREND" ? "buy" : ctx.regime === "DOWNTREND" ? "sell" : null;
  if (!side) { R.push(rej("regime", "NO_TREND", `regime ${ctx.regime} is not a qualifying trend`, fam)); return { rejections: R }; }
  const nowI = m5.length - 1;
  const highs = f.pivotsHigh.filter((p) => p.confirmedAtIndex <= nowI), lows = f.pivotsLow.filter((p) => p.confirmedAtIndex <= nowI);
  if (highs.length < 2 || lows.length < 2) { R.push(rej("structure", "INSUFFICIENT_PIVOTS", "fewer than two confirmed pivots per side", fam)); return { rejections: R }; }
  // Structural area = the prior confirmed pivot that price broke through (old resistance for longs).
  const lastLow = lows[lows.length - 1], lastHigh = highs[highs.length - 1];
  const priorLevelPivot = side === "buy" ? highs.slice(0, -1).reverse().find((p) => p.price < lastHigh.price) : lows.slice(0, -1).reverse().find((p) => p.price > lastLow.price);
  const level = priorLevelPivot?.price ?? (side === "buy" ? lastLow.price : lastHigh.price);
  const recentM5 = m5.slice(-6);
  const swingExtreme = side === "buy" ? Math.max(...m5.slice(-30).map((b) => b.h)) : Math.min(...m5.slice(-30).map((b) => b.l));
  const pullbackExtreme = side === "buy" ? Math.min(...recentM5.map((b) => b.l)) : Math.max(...recentM5.map((b) => b.h));
  const depth = Math.abs(swingExtreme - pullbackExtreme);
  if (depth < cfg.setups.pullback.minPullbackDepthAtr * f.atrM5) { R.push(rej("pullback", "NO_PULLBACK", `pullback depth ${depth.toFixed(2)} < ${cfg.setups.pullback.minPullbackDepthAtr} ATR — nothing to continue from`, fam)); return { rejections: R }; }
  if (depth > cfg.setups.pullback.maxPullbackDepthAtr * f.atrM5) { R.push(rej("pullback", "PULLBACK_TOO_DEEP", `pullback depth ${depth.toFixed(2)} > ${cfg.setups.pullback.maxPullbackDepthAtr} ATR — structure at risk`, fam)); return { rejections: R }; }
  const tol = 0.5 * f.atrM5;
  if (Math.abs(pullbackExtreme - level) > tol) { R.push(rej("pullback", "NOT_AT_STRUCTURE", `pullback low/high ${pullbackExtreme.toFixed(2)} is not within ${tol.toFixed(2)} of structural level ${level.toFixed(2)}`, fam)); return { rejections: R }; }
  // Higher-low (or lower-high) must remain valid.
  const hlValid = side === "buy" ? pullbackExtreme > lastLow.price - 0.1 * f.atrM5 : pullbackExtreme < lastHigh.price + 0.1 * f.atrM5;
  if (!hlValid) { R.push(rej("structure", "HL_BROKEN", `pullback ${pullbackExtreme.toFixed(2)} broke the last confirmed ${side === "buy" ? "higher low" : "lower high"} ${(side === "buy" ? lastLow : lastHigh).price.toFixed(2)}`, fam)); return { rejections: R }; }
  // M1 confirmation: closed rejection/reclaim + break of local trigger.
  const b = m1[m1.length - 1], prev = m1[m1.length - 2];
  if (!b || !prev) { R.push(rej("m1", "NO_M1", "no closed M1 bars", fam)); return { rejections: R }; }
  const reclaim = side === "buy" ? b.c > level && (wickRejection(b, "low") >= 0.3 || (b.c > b.o && bodyRatio(b) >= 0.5)) : b.c < level && (wickRejection(b, "high") >= 0.3 || (b.c < b.o && bodyRatio(b) >= 0.5));
  if (!reclaim) { R.push(rej("m1", "NO_M1_RECLAIM", `last M1 (${b.c.toFixed(2)}) has not reclaimed ${level.toFixed(2)} with rejection or conviction`, fam)); return { rejections: R }; }
  const localTrigger = side === "buy" ? prev.h : prev.l;
  const broke = side === "buy" ? b.c > localTrigger : b.c < localTrigger;
  if (!broke) { R.push(rej("m1", "NO_TRIGGER_BREAK", `M1 close ${b.c.toFixed(2)} did not break local trigger ${localTrigger.toFixed(2)}`, fam)); return { rejections: R }; }
  // Not chasing.
  const entryRef = side === "buy" ? ctx.quote.ask : ctx.quote.bid;
  const moved = Math.abs(entryRef - pullbackExtreme);
  const opposing = nearestOpposing(side, entryRef, f.pivotsHigh, f.pivotsLow, nowI) ?? (side === "buy" ? swingExtreme : swingExtreme);
  const desired = Math.min(cfg.setups.targetMaxUsd, Math.max(cfg.setups.targetMinUsd, 1.2 * f.atrM5));
  if (moved > cfg.setups.pullback.maxMoveAlreadyDoneRatio * desired + cfg.setups.pullback.maxMoveAlreadyDoneRatio * depth) { R.push(rej("chase", "MOVE_ALREADY_DONE", `price has already moved ${moved.toFixed(2)} from the pullback extreme`, fam)); return { rejections: R }; }
  const reasons = [
    `${ctx.regime}: pullback of ${depth.toFixed(2)} (${(depth / f.atrM5).toFixed(2)} ATR) into structural level ${level.toFixed(2)}`,
    `${side === "buy" ? "higher low" : "lower high"} ${(side === "buy" ? lastLow : lastHigh).price.toFixed(2)} intact`,
    `M1 ${side === "buy" ? "reclaim" : "rejection"} closed at ${b.c.toFixed(2)} and broke local trigger ${localTrigger.toFixed(2)}`,
  ];
  return finalize(ctx, fam, "v1", side, pullbackExtreme, opposing, `M1 close ${side === "buy" ? ">" : "<"} ${localTrigger.toFixed(2)} after reclaim of ${level.toFixed(2)}`,
    `market at ${side === "buy" ? "ask" : "bid"} within 2 M1 bars of trigger`, b.t + 2 * 60_000, reasons,
    { level, pullbackExtreme, swingExtreme, localTrigger }, `${b.t}`);
}

/* ------------------------------------------------------------------ B. COMPRESSION → EXPANSION BREAKOUT */
export function compressionBreakout(ctx: SetupContext, st: SetupState): { candidate?: Candidate; rejections: Rejection[]; state: SetupState } {
  const { cfg, m1, f } = ctx; const fam: SetupFamily = "COMPRESSION_BREAKOUT"; const c = cfg.setups.breakout;
  const R: Rejection[] = [];
  let comp = st.compression;
  const last = m1[m1.length - 1];
  if (!last) return { rejections: [rej("m1", "NO_M1", "no closed M1 bars", fam)], state: st };
  const nowI5 = ctx.m5.length - 1;

  // Expire / invalidate an existing candidate.
  if (comp && !comp.invalidated) {
    if (comp.expiresAfterBarT != null && last.t > comp.expiresAfterBarT) comp = { ...comp, invalidated: true, reason: `no retest+trigger within ${c.candidateExpiryBars} closed M1 bars` };
    else if (comp.breakout && (comp.breakout.side === "buy" ? last.c < comp.hi : last.c > comp.lo)) comp = { ...comp, invalidated: true, reason: "M1 closed back inside the frozen range after the breakout" };
  }
  if (comp && comp.invalidated) { R.push(rej("compression", "CANDIDATE_INVALIDATED", comp.reason ?? "invalidated", fam)); comp = null; }

  // Detect a fresh compression when there is no live candidate.
  if (!comp) {
    const n = c.compressionBars;
    if (m1.length < n * (c.compressionWindows + 1)) { R.push(rej("compression", "INSUFFICIENT_M1", "not enough M1 history to rank compression", fam)); return { rejections: R, state: { ...st, compression: null } }; }
    const win = m1.slice(-n); const hi = Math.max(...win.map((b) => b.h)), lo = Math.min(...win.map((b) => b.l)); const width = hi - lo;
    const widths: number[] = [];
    for (let k = 1; k <= c.compressionWindows; k++) { const w = m1.slice(-n * (k + 1), -n * k); widths.push(Math.max(...w.map((b) => b.h)) - Math.min(...w.map((b) => b.l))); }
    const pct = widths.filter((w) => w < width).length / widths.length;
    if (pct > c.compressionPercentileMax) { R.push(rej("compression", "NOT_COMPRESSED", `last ${n} M1 bars width ${width.toFixed(2)} is at percentile ${(pct * 100).toFixed(0)} of comparable windows (need ≤ ${(c.compressionPercentileMax * 100).toFixed(0)})`, fam)); return { rejections: R, state: { ...st, compression: null } }; }
    comp = { id: `cmp-${last.t}`, hi, lo, createdAt: last.t, createdIndexT: last.t, breakout: null, retest: null, expiresAfterBarT: null, invalidated: false };
    return { rejections: [rej("compression", "COMPRESSION_FORMING", `compression ${lo.toFixed(2)}–${hi.toFixed(2)} frozen (percentile ${(pct * 100).toFixed(0)}); waiting for a closed breakout bar`, fam)], state: { ...st, compression: comp } };
  }

  // Breakout bar?
  if (!comp.breakout) {
    if (last.t <= comp.createdAt) return { rejections: [rej("compression", "WAITING_BREAKOUT", "no new closed bar since compression froze", fam)], state: { ...st, compression: comp } };
    const buf = c.bufferAtrMult * f.atrM5; const rng = last.h - last.l;
    const up = last.c > comp.hi + buf, dn = last.c < comp.lo - buf;
    if (!up && !dn) {
      // extend the candidate as long as price stays inside; a wick outside is not a breakout.
      if (last.h > comp.hi + buf || last.l < comp.lo - buf) R.push(rej("compression", "WICK_ONLY", `wick beyond boundary but close ${last.c.toFixed(2)} inside ${comp.lo.toFixed(2)}–${comp.hi.toFixed(2)}`, fam));
      else R.push(rej("compression", "NO_BREAKOUT_CLOSE", `breakout has not closed outside ${comp.lo.toFixed(2)}–${comp.hi.toFixed(2)} (+${buf.toFixed(2)} buffer)`, fam));
      if (last.c > comp.hi || last.c < comp.lo) comp = { ...comp, invalidated: true, reason: "closed outside the frozen boundary without meeting the breakout buffer" };
      return { rejections: R, state: { ...st, compression: comp } };
    }
    const side: Side = up ? "buy" : "sell";
    if (bodyRatio(last) < c.minBodyRatio) { R.push(rej("compression", "WEAK_BODY", `breakout bar body ${(100 * bodyRatio(last)).toFixed(0)}% < ${c.minBodyRatio * 100}%`, fam)); comp = { ...comp, invalidated: true, reason: "weak breakout bar" }; return { rejections: R, state: { ...st, compression: comp } }; }
    const inQuarter = rng > 0 && (side === "buy" ? (last.c - last.l) / rng >= 0.75 : (last.h - last.c) / rng >= 0.75);
    if (c.closeOuterQuarter && !inQuarter) { R.push(rej("compression", "NOT_OUTER_QUARTER", "breakout bar did not close in the directional outer quarter", fam)); comp = { ...comp, invalidated: true, reason: "breakout close not in outer quarter" }; return { rejections: R, state: { ...st, compression: comp } }; }
    comp = { ...comp, breakout: { side, barT: last.t, barIndex: m1.length - 1, close: last.c }, expiresAfterBarT: last.t + c.candidateExpiryBars * 60_000 };
    if (c.noRetestVariant) {
      // Stricter, separately versioned continuation: requires body ≥ 0.75 and no prior failed break of the same boundary.
      if (bodyRatio(last) >= 0.75) {
        const opposing = nearestOpposing(side, side === "buy" ? ctx.quote.ask : ctx.quote.bid, f.pivotsHigh, f.pivotsLow, nowI5);
        const r = finalize(ctx, fam, "no-retest-v1", side, side === "buy" ? comp.lo : comp.hi, opposing, `closed breakout ${last.c.toFixed(2)} beyond ${(side === "buy" ? comp.hi : comp.lo).toFixed(2)} (no-retest variant)`, "market at next quote", last.t + 60_000, [`compression ${comp.lo.toFixed(2)}–${comp.hi.toFixed(2)} broke with ${(100 * bodyRatio(last)).toFixed(0)}% body`], { hi: comp.hi, lo: comp.lo }, `${last.t}`);
        return { ...r, state: { ...st, compression: { ...comp, invalidated: true, reason: "consumed" } } };
      }
    }
    return { rejections: [rej("compression", "AWAITING_RETEST", `breakout closed at ${last.c.toFixed(2)}; waiting for a retest that holds ${(side === "buy" ? comp.hi : comp.lo).toFixed(2)}`, fam)], state: { ...st, compression: comp } };
  }

  // Retest + trigger.
  const side = comp.breakout.side; const boundary = side === "buy" ? comp.hi : comp.lo; const tol = 0.15 * f.atrM5;
  if (!comp.retest) {
    if (last.t <= comp.breakout.barT) return { rejections: [rej("compression", "AWAITING_RETEST", "no new closed bar since breakout", fam)], state: { ...st, compression: comp } };
    const touched = side === "buy" ? last.l <= boundary + tol && last.c >= boundary : last.h >= boundary - tol && last.c <= boundary;
    if (!touched) return { rejections: [rej("compression", "AWAITING_RETEST", `retest of ${boundary.toFixed(2)} has not occurred (last low/high ${side === "buy" ? last.l.toFixed(2) : last.h.toFixed(2)})`, fam)], state: { ...st, compression: comp } };
    comp = { ...comp, retest: { barT: last.t, low: last.l, high: last.h } };
    return { rejections: [rej("compression", "RETEST_HELD", `retest held ${boundary.toFixed(2)}; waiting for a fresh directional trigger beyond ${(side === "buy" ? last.h : last.l).toFixed(2)}`, fam)], state: { ...st, compression: comp } };
  }
  if (last.t <= comp.retest.barT) return { rejections: [rej("compression", "AWAITING_TRIGGER", "no new closed bar since retest", fam)], state: { ...st, compression: comp } };
  const trig = side === "buy" ? last.c > comp.retest.high : last.c < comp.retest.low;
  if (!trig) return { rejections: [rej("compression", "AWAITING_TRIGGER", `M1 close ${last.c.toFixed(2)} has not broken the retest bar ${side === "buy" ? "high" : "low"} ${(side === "buy" ? comp.retest.high : comp.retest.low).toFixed(2)}`, fam)], state: { ...st, compression: comp } };
  const invalidation = side === "buy" ? Math.min(comp.retest.low, comp.hi) : Math.max(comp.retest.high, comp.lo);
  const opposing = nearestOpposing(side, side === "buy" ? ctx.quote.ask : ctx.quote.bid, f.pivotsHigh, f.pivotsLow, nowI5);
  const r = finalize(ctx, fam, "retest-v1", side, invalidation, opposing,
    `M1 close ${side === "buy" ? ">" : "<"} retest bar ${side === "buy" ? "high" : "low"} ${(side === "buy" ? comp.retest.high : comp.retest.low).toFixed(2)}`,
    "market at next quote within 2 M1 bars", last.t + 2 * 60_000,
    [`compression ${comp.lo.toFixed(2)}–${comp.hi.toFixed(2)} (frozen ${new Date(comp.createdAt).toISOString()})`, `breakout closed ${comp.breakout.close.toFixed(2)}; retest held ${boundary.toFixed(2)}`],
    { hi: comp.hi, lo: comp.lo, retestLow: comp.retest.low, retestHigh: comp.retest.high }, `${last.t}`);
  return { ...r, state: { ...st, compression: { ...comp, invalidated: true, reason: "consumed" } } };
}

/* ------------------------------------------------------------------ C. ORDERLY-RANGE REJECTION / FAILED BREAK */
export function rangeRejection(ctx: SetupContext, st: SetupState): { candidate?: Candidate; rejections: Rejection[]; state: SetupState } {
  const { cfg, m1, f } = ctx; const fam: SetupFamily = "RANGE_REJECTION"; const c = cfg.setups.range;
  const R: Rejection[] = [];
  if (ctx.regime !== "ORDERLY_RANGE") { R.push(rej("regime", "NOT_RANGE", `regime ${ctx.regime}: only clearly bounded ranges are faded`, fam)); return { rejections: R, state: st }; }
  const r: RangeCandidate | null = f.range;
  if (!r || r.invalidated) { R.push(rej("range", "NO_RELIABLE_BOUNDARIES", r?.invalidReason ?? "range boundaries are unreliable", fam)); return { rejections: R, state: st }; }
  const failed = st.rangeFailedBreaks[r.id] ?? 0;
  if (failed >= c.maxFailedBreaks) { R.push(rej("range", "TOO_MANY_FAILED_BREAKS", `${failed} consecutive boundary failures on this range`, fam)); return { rejections: R, state: st }; }
  const width = r.resistance - r.support;
  const last = m1[m1.length - 1], prev = m1[m1.length - 2];
  if (!last || !prev) return { rejections: [rej("m1", "NO_M1", "no closed M1 bars", fam)], state: st };
  const recent = m1.slice(-6, -1);
  const probeLow = Math.min(...recent.map((b) => b.l)), probeHigh = Math.max(...recent.map((b) => b.h));
  const longProbe = probeLow <= r.support && r.support - probeLow <= c.excursionMaxAtr * f.atrM5;
  const shortProbe = probeHigh >= r.resistance && probeHigh - r.resistance <= c.excursionMaxAtr * f.atrM5;
  const deepBreak = (probeLow < r.support - c.excursionMaxAtr * f.atrM5) || (probeHigh > r.resistance + c.excursionMaxAtr * f.atrM5);
  if (deepBreak) { R.push(rej("range", "EXCURSION_TOO_DEEP", "boundary excursion exceeded the allowed probe depth — not a brief failed break", fam)); return { rejections: R, state: st }; }
  if (!longProbe && !shortProbe) { R.push(rej("range", "NO_BOUNDARY_TEST", `price ${last.c.toFixed(2)} has not tested support ${r.support.toFixed(2)} or resistance ${r.resistance.toFixed(2)}`, fam)); return { rejections: R, state: st }; }
  const side: Side = longProbe ? "buy" : "sell";
  const boundary = side === "buy" ? r.support : r.resistance;
  const reclaimed = side === "buy" ? prev.c > r.support : prev.c < r.resistance;
  if (!reclaimed) { R.push(rej("range", "NO_RECLAIM", `no closed M1 reclaim of ${boundary.toFixed(2)} yet`, fam)); return { rejections: R, state: st }; }
  const trig = side === "buy" ? last.c > prev.h && last.c > r.support : last.c < prev.l && last.c < r.resistance;
  if (!trig) { R.push(rej("range", "NO_TRIGGER", `M1 close ${last.c.toFixed(2)} has not confirmed movement back into the range beyond the reclaim bar`, fam)); return { rejections: R, state: st }; }
  const entry = side === "buy" ? ctx.quote.ask : ctx.quote.bid;
  const mid = r.support + width / 2, half = (c.middleExclusionPct / 2) * width;
  if (entry > mid - half && entry < mid + half) { R.push(rej("range", "MIDDLE_OF_RANGE", `entry ${entry.toFixed(2)} is in the middle ${(c.middleExclusionPct * 100).toFixed(0)}% of the range`, fam)); return { rejections: R, state: st }; }
  const invalidation = side === "buy" ? probeLow : probeHigh;
  const opposing = side === "buy" ? r.resistance : r.support;
  const res = finalize(ctx, fam, "v1", side, invalidation, opposing,
    `failed break of ${boundary.toFixed(2)}: probe to ${invalidation.toFixed(2)}, reclaim close ${prev.c.toFixed(2)}, trigger close ${last.c.toFixed(2)}`,
    "market at next quote within 2 M1 bars", last.t + 2 * 60_000,
    [`frozen range ${r.support.toFixed(2)}–${r.resistance.toFixed(2)} (${r.touchesLow.length}/${r.touchesHigh.length} reactions)`, `brief excursion ${Math.abs(invalidation - boundary).toFixed(2)} beyond boundary`],
    { support: r.support, resistance: r.resistance, probe: invalidation }, `${last.t}`);
  return { ...res, state: { ...st, lastRangeProbe: { rangeId: r.id, side, barT: last.t } } };
}

/** Called by the position manager when a range trade stops out, so successive failures are counted. */
export function noteRangeFailure(st: SetupState, rangeId: string): SetupState {
  return { ...st, rangeFailedBreaks: { ...st.rangeFailedBreaks, [rangeId]: (st.rangeFailedBreaks[rangeId] ?? 0) + 1 } };
}
