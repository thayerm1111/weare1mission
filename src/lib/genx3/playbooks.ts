import type { Bar } from "./candles";
import { candleFeatures } from "./candleFeatures";
import { pivots, sweepReclaim } from "./structure";
import type { Levels } from "./levels";
import type { RegimeResult } from "./regime";
import { CONFIG } from "./config";
import { roundPrice } from "./instrument";

export type SetupType = "TREND_PULLBACK" | "SWEEP_RECLAIM" | "BREAKOUT_RETEST" | "RANGE_REJECTION";
export type Side = "BUY" | "SELL";
export type Stage = "WATCHING" | "APPROACHING" | "ARMED" | "TRIGGERED";

export type Candidate = {
  setupType: SetupType; side: Side; stage: Stage;
  anchorKey: string;                 // structure that defines this setup (new anchor = new setup)
  entry: number; zoneLow: number; zoneHigh: number;
  invalidation: number;              // structural level
  stop: number; target: number;
  evidence: string[]; contradictions: string[]; invalidationConditions: string[];
  location: number; confirmation: number; momentum: number;   // 0..1 component inputs
  rejectReason: string | null;       // set when the setup is otherwise valid but fails trade limits
};

type Ctx = { m5: Bar[]; m15: Bar[]; h1: Bar[]; regime: RegimeResult; levels: Levels; asOf: number };

/** Liquidity/structure levels above or below price, for targets and blocking. */
function opposingLevels(ctx: Ctx, side: Side): number[] {
  const px = ctx.m5.at(-1)!.c;
  const L = ctx.levels;
  const h1p = pivots(ctx.h1.slice(-72), 3, 3, 3_600_000).confirmed;
  // Significant liquidity only (session levels, active range bounds, confirmed 1H swings). Minor
  // 15m pivots are not treated as target-blocking structure.
  const cands = [L.prevDayHigh, L.prevDayLow, L.asiaHigh, L.asiaLow, ctx.regime.box15m?.high, ctx.regime.box15m?.low,
    ...h1p.map((p) => p.price)].filter((x): x is number => typeof x === "number");
  return side === "BUY" ? cands.filter((x) => x > px).sort((a, b) => a - b) : cands.filter((x) => x < px).sort((a, b) => b - a);
}

/** Apply the shared stop/target/limit rules; returns the finished candidate or a reject reason. */
function finish(ctx: Ctx, c: Omit<Candidate, "stop" | "target" | "zoneLow" | "zoneHigh" | "rejectReason">, preferredTarget: number | null): Candidate {
  const T = CONFIG.trade, K = CONFIG.costs;
  const a15 = ctx.regime.atr15, a5 = ctx.regime.atr5 ?? a15 / 2;
  const dir = c.side === "BUY" ? 1 : -1;
  const buffer = T.stopBufferAtr * a15 + K.spreadEstimateUsd;
  const stop = roundPrice(c.invalidation - dir * buffer, c.side === "BUY" ? "down" : "up");
  const zoneW = T.zoneWidthAtr * a5;
  const zoneLow = roundPrice(c.side === "BUY" ? c.entry - zoneW : c.entry, "down");
  const zoneHigh = roundPrice(c.side === "BUY" ? c.entry : c.entry + zoneW, "up");
  const risk = Math.abs(c.entry - stop);
  const opp = opposingLevels(ctx, c.side);
  const nearest = opp.find((x) => Math.abs(x - c.entry) > 0.05) ?? null;
  let targetRaw = preferredTarget ?? (opp.find((x) => Math.abs(x - c.entry) >= T.minTargetUsd) ?? null);
  if (targetRaw == null) targetRaw = c.entry + dir * Math.min(T.maxTargetUsd, Math.max(T.minTargetUsd, 2 * a15));
  let reward = dir * (targetRaw - c.entry);
  if (reward > T.maxTargetUsd) { targetRaw = c.entry + dir * T.maxTargetUsd; reward = T.maxTargetUsd; }
  const target = roundPrice(targetRaw, c.side === "BUY" ? "down" : "up");
  reward = dir * (target - c.entry);
  const cost = K.spreadEstimateUsd + K.slippageEstimateUsd;
  let rejectReason: string | null = null;
  if (risk < T.minStopUsd) rejectReason = `stop $${risk.toFixed(2)} below min $${T.minStopUsd}`;
  else if (risk > T.maxStopUsd) rejectReason = `stop $${risk.toFixed(2)} above max $${T.maxStopUsd}`;
  else if (reward < T.minTargetUsd) rejectReason = `target $${reward.toFixed(2)} below min $${T.minTargetUsd}`;
  else if (nearest != null && dir * (nearest - c.entry) < T.minTargetUsd && dir * (nearest - c.entry) < reward - 0.05) rejectReason = `opposing structure ${nearest.toFixed(2)} blocks the target`;
  else if (reward / risk < T.minGrossRR) rejectReason = `gross R:R ${(reward / risk).toFixed(2)} < ${T.minGrossRR}`;
  else if ((reward - cost) / (risk + cost) < T.minNetRR) rejectReason = `net R:R ${((reward - cost) / (risk + cost)).toFixed(2)} < ${T.minNetRR}`;
  return { ...c, stop, target, zoneLow, zoneHigh, rejectReason };
}

export function evaluatePlaybooks(ctx: Ctx): Candidate[] {
  const out: Candidate[] = [];
  const { m5, regime: rg } = ctx;
  if (m5.length < 30) return out;
  const last = m5.at(-1)!, prev = m5.at(-2)!;
  const a15 = rg.atr15;
  const cf = candleFeatures(m5, rg.atr5);
  if (!cf) return out;
  const barT = last.t;

  // ── A: TREND PULLBACK CONTINUATION ──
  for (const side of ["BUY", "SELL"] as Side[]) {
    const up = side === "BUY";
    if (rg.regime !== (up ? "TREND_UP" : "TREND_DOWN")) continue;
    if (rg.bias1h === (up ? "DOWN" : "UP")) continue;
    const sw = rg.swings15m;
    const legStart = up ? sw.lastLow : sw.lastHigh, legEnd = up ? sw.lastHigh : sw.lastLow;
    if (!legStart || !legEnd || legEnd.t <= legStart.t) continue;
    const leg = Math.abs(legEnd.price - legStart.price);
    if (leg < 1.5 * a15) continue;
    const sinceEnd = m5.filter((b) => b.t >= legEnd.t);
    if (!sinceEnd.length) continue;
    const pullExtreme = up ? Math.min(...sinceEnd.map((b) => b.l)) : Math.max(...sinceEnd.map((b) => b.h));
    const retrace = Math.abs(legEnd.price - pullExtreme) / leg;
    const intact = up ? pullExtreme > legStart.price : pullExtreme < legStart.price;
    const anchorKey = `A:${side}:${legEnd.t}`;
    if (!intact) continue;
    const inValue = retrace >= 0.38 && retrace <= 0.75;
    const breakBack = up ? last.c > prev.h && cf.bullish && cf.closeLocation >= 0.6 : last.c < prev.l && cf.bearish && cf.closeLocation <= 0.4;
    const stage: Stage = inValue && breakBack ? "TRIGGERED" : inValue ? "ARMED" : retrace >= 0.25 ? "APPROACHING" : "WATCHING";
    if (stage !== "TRIGGERED") { out.push({ setupType: "TREND_PULLBACK", side, stage, anchorKey, entry: last.c, zoneLow: last.c, zoneHigh: last.c, invalidation: pullExtreme, stop: pullExtreme, target: legEnd.price, evidence: [`retrace ${(retrace * 100).toFixed(0)}% of ${leg.toFixed(2)} leg`], contradictions: [], invalidationConditions: [], location: 0, confirmation: 0, momentum: 0, rejectReason: "not_triggered" }); continue; }
    out.push(finish(ctx, {
      setupType: "TREND_PULLBACK", side, stage, anchorKey, entry: last.c, invalidation: pullExtreme,
      evidence: [`15m ${up ? "HH/HL" : "LH/LL"} trend, impulse $${leg.toFixed(2)} (${(leg / a15).toFixed(1)}×ATR15)`, `pullback ${(retrace * 100).toFixed(0)}% held above structure`, `5m close ${up ? "above" : "below"} prior bar ${up ? "high" : "low"}, close location ${cf.closeLocation.toFixed(2)}`, `1H bias ${rg.bias1h}`],
      contradictions: [...rg.contradicting],
      invalidationConditions: [`price trades ${up ? "below" : "above"} pullback extreme ${pullExtreme.toFixed(2)}`, `15m close ${up ? "below" : "above"} ${legStart.price.toFixed(2)}`],
      location: 1 - Math.abs(retrace - 0.55) / 0.3, confirmation: Math.min(1, cf.bodyToRange + 0.2), momentum: Math.min(1, (cf.rangeToAtr ?? 1) / 1.5),
    }, legEnd.price));
  }

  // ── B: LIQUIDITY SWEEP AND RECLAIM ──
  const L = ctx.levels;
  const levelSet: { name: string; px: number; side: Side }[] = [];
  const add = (name: string, px: number | null | undefined, side: Side) => { if (typeof px === "number") levelSet.push({ name, px, side }); };
  add("prior-day low", L.prevDayLow, "BUY"); add("prior-day high", L.prevDayHigh, "SELL");
  add("Asian low", L.asiaLow, "BUY"); add("Asian high", L.asiaHigh, "SELL");
  add("range low", rg.box15m?.low, "BUY"); add("range high", rg.box15m?.high, "SELL");
  for (const lv of levelSet) {
    const up = lv.side === "BUY";
    if (rg.regime === "DISORDERED_NO_TRADE") continue;
    if (rg.regime === "BREAKOUT_EXPANSION" && rg.breakoutSide === (up ? "down" : "up")) continue; // don't fade a live breakout
    const sw = sweepReclaim(m5, lv.px, up ? "below" : "above", 0.1 * a15, 4);
    const near = Math.abs(last.c - lv.px) <= 1.0 * a15;
    if (!near) continue;
    const anchorKey = `B:${lv.side}:${lv.name}:${lv.px.toFixed(2)}`;
    const confirm = up ? cf.bullish && cf.closeLocation >= 0.6 : cf.bearish && cf.closeLocation <= 0.4;
    if (!sw.swept || !confirm) { out.push({ setupType: "SWEEP_RECLAIM", side: lv.side, stage: sw.swept ? "ARMED" : "WATCHING", anchorKey, entry: last.c, zoneLow: last.c, zoneHigh: last.c, invalidation: lv.px, stop: lv.px, target: lv.px, evidence: [`near ${lv.name} ${lv.px.toFixed(2)}`], contradictions: [], invalidationConditions: [], location: 0, confirmation: 0, momentum: 0, rejectReason: "not_triggered" }); continue; }
    out.push(finish(ctx, {
      setupType: "SWEEP_RECLAIM", side: lv.side, stage: "TRIGGERED", anchorKey, entry: last.c, invalidation: sw.extreme!,
      evidence: [`swept ${lv.name} ${lv.px.toFixed(2)} to ${sw.extreme!.toFixed(2)} ${sw.barsAgo} bar(s) ago`, `5m close back ${up ? "above" : "below"} the level, close location ${cf.closeLocation.toFixed(2)}`, `regime ${rg.regime}`],
      contradictions: [...rg.contradicting, ...(rg.bias1h === (up ? "DOWN" : "UP") ? ["1H bias opposes the reversal"] : [])],
      invalidationConditions: [`trade beyond sweep extreme ${sw.extreme!.toFixed(2)}`, `5m close back ${up ? "below" : "above"} ${lv.px.toFixed(2)}`],
      location: 1, confirmation: Math.min(1, cf.bodyToRange + (up ? cf.lowerWick : cf.upperWick) / Math.max(cf.range, 1e-9) * 0.5), momentum: Math.min(1, (cf.rangeToAtr ?? 1) / 1.5),
    }, null));
  }

  // ── C: COMPRESSION BREAKOUT AND RETEST ──
  if (rg.compressionBox && rg.breakoutSide && rg.regime === "BREAKOUT_EXPANSION") {
    const up = rg.breakoutSide === "up"; const side: Side = up ? "BUY" : "SELL";
    const edge = up ? rg.compressionBox.high : rg.compressionBox.low;
    const height = rg.compressionBox.high - rg.compressionBox.low;
    const touched = up ? last.l <= edge + 0.2 * a15 : last.h >= edge - 0.2 * a15;
    const held = up ? last.c > edge && cf.closeLocation >= 0.55 : last.c < edge && cf.closeLocation <= 0.45;
    const anchorKey = `C:${side}:${edge.toFixed(2)}`;
    if (touched && held) {
      out.push(finish(ctx, {
        setupType: "BREAKOUT_RETEST", side, stage: "TRIGGERED", anchorKey, entry: last.c, invalidation: up ? Math.min(last.l, edge - 0.25 * a15) : Math.max(last.h, edge + 0.25 * a15),
        evidence: [`compression ${rg.compressionBox.low.toFixed(2)}–${rg.compressionBox.high.toFixed(2)} broke ${rg.breakoutSide} with displacement`, `5m retest of ${edge.toFixed(2)} held, close location ${cf.closeLocation.toFixed(2)}`],
        contradictions: [...rg.contradicting],
        invalidationConditions: [`5m close back inside the box beyond ${edge.toFixed(2)}`],
        location: 1, confirmation: Math.min(1, cf.bodyToRange + 0.2), momentum: 0.8,
      }, edge + (up ? 1 : -1) * Math.max(height, CONFIG.trade.minTargetUsd)));
    } else {
      out.push({ setupType: "BREAKOUT_RETEST", side, stage: "ARMED", anchorKey, entry: last.c, zoneLow: edge, zoneHigh: edge, invalidation: edge, stop: edge, target: edge, evidence: [`awaiting retest of ${edge.toFixed(2)}`], contradictions: [], invalidationConditions: [], location: 0, confirmation: 0, momentum: 0, rejectReason: "not_triggered" });
    }
  }

  // ── D: ORDERLY RANGE REJECTION ──
  if (rg.regime === "ORDERLY_RANGE" && rg.box15m) {
    const { high, low } = rg.box15m; const w = high - low; const mid = (high + low) / 2;
    for (const side of ["BUY", "SELL"] as Side[]) {
      const up = side === "BUY";
      const edge = up ? low : high;
      const nearEdge = up ? last.l <= low + 0.15 * w : last.h >= high - 0.15 * w;
      const rejected = up ? cf.rejectionBull && last.c > low && last.c < mid : cf.rejectionBear && last.c < high && last.c > mid;
      const anchorKey = `D:${side}:${low.toFixed(2)}:${high.toFixed(2)}`;
      if (!nearEdge) continue;
      if (!rejected) { out.push({ setupType: "RANGE_REJECTION", side, stage: "APPROACHING", anchorKey, entry: last.c, zoneLow: last.c, zoneHigh: last.c, invalidation: edge, stop: edge, target: mid, evidence: [`at range ${up ? "low" : "high"} ${edge.toFixed(2)}`], contradictions: [], invalidationConditions: [], location: 0, confirmation: 0, momentum: 0, rejectReason: "not_triggered" }); continue; }
      out.push(finish(ctx, {
        setupType: "RANGE_REJECTION", side, stage: "TRIGGERED", anchorKey, entry: last.c, invalidation: up ? Math.min(last.l, low) : Math.max(last.h, high),
        evidence: [`orderly range ${low.toFixed(2)}–${high.toFixed(2)}`, `5m rejection at the ${up ? "low" : "high"}: wick ${((up ? cf.lowerWick : cf.upperWick) / Math.max(cf.range, 1e-9) * 100).toFixed(0)}% of range`],
        contradictions: [...rg.contradicting],
        invalidationConditions: [`5m close ${up ? "below" : "above"} ${edge.toFixed(2)}`, "regime changes to BREAKOUT_EXPANSION"],
        location: 1 - Math.abs(last.c - edge) / (0.5 * w), confirmation: Math.min(1, (up ? cf.lowerWick : cf.upperWick) / Math.max(cf.range, 1e-9) + 0.3), momentum: 0.5,
      }, up ? high - 0.1 * w : low + 0.1 * w));
    }
  }
  void barT;
  return out;
}
