/**
 * The three style detectors. All PURE: bars in, a Setup or null out — so every rule is unit-testable and the
 * same code runs live, in the shadow recorder and in a backtest.
 */
import { type Bar, type Setup, type StyleCtx, round2 } from "./types";

const hi = (bars: Bar[], n = bars.length) => Math.max(...bars.slice(-n).map((b) => b.h));
const lo = (bars: Bar[], n = bars.length) => Math.min(...bars.slice(-n).map((b) => b.l));
const last = <T,>(a: T[]): T | null => (a.length ? a[a.length - 1] : null);
const body = (b: Bar) => Math.abs(b.c - b.o);

/** Average true range over the last n bars, in dollars. */
export function atrOf(bars: Bar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  const tr: number[] = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const p = bars[i - 1];
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - p.c), Math.abs(bars[i].l - p.c)));
  }
  return tr.reduce((a, b) => a + b, 0) / tr.length;
}

/* ─────────────────────────── RAPID — 40–50 pip target, 30–40 pip stop ───────────────────────────
 * The busy style. Gold pushes off a session level with momentum; we go with the push, take 40–50 pips and
 * leave. Requirements: a real level nearby (session high/low or PDH/PDL), a decisive 5-minute close through
 * it, and enough volatility that 40 pips is a normal move rather than an hour's work.
 */
export const RAPID = { stopPips: 35, tp1Pips: 45, tp2Pips: 70, minAtr: 0.8, maxChasePips: 25, minBodyFrac: 0.5 };

export function detectRapid(ctx: StyleCtx): Setup | null {
  const { m5, m15, pip, price } = ctx;
  if (m5.length < 20 || m15.length < 8) return null;
  const a = atrOf(m15, 14);
  if (a == null || a < RAPID.minAtr) return null;                       // too quiet for a 45-pip target

  const trigger = last(m5)!;
  if (body(trigger) < (trigger.h - trigger.l) * RAPID.minBodyFrac) return null;   // indecisive candle

  // The levels a session push breaks: the last 4 hours of 5-minute highs/lows, plus the previous day's.
  const prior = m5.slice(0, -1);                                        // the level is what existed BEFORE this candle
  const recentHigh = hi(prior, 48), recentLow = lo(prior, 48);
  const levels: { price: number; name: string }[] = [
    { price: recentHigh, name: "the session high" },
    { price: recentLow, name: "the session low" },
    ...(ctx.pdh != null ? [{ price: ctx.pdh, name: "yesterday's high" }] : []),
    ...(ctx.pdl != null ? [{ price: ctx.pdl, name: "yesterday's low" }] : []),
  ];

  for (const lv of levels) {
    const brokeUp = trigger.c > lv.price && trigger.o <= lv.price;
    const brokeDown = trigger.c < lv.price && trigger.o >= lv.price;
    if (!brokeUp && !brokeDown) continue;
    const side: "buy" | "sell" = brokeUp ? "buy" : "sell";
    // Don't chase: the entry must still be within a few pips of the level.
    if (Math.abs(price - lv.price) > RAPID.maxChasePips * pip) continue;
    const d = side === "buy" ? 1 : -1;
    return {
      style: "rapid", side,
      entryLow: round2(Math.min(price, lv.price)), entryHigh: round2(Math.max(price, lv.price)),
      stop: round2(price - d * RAPID.stopPips * pip),
      tp1: round2(price + d * RAPID.tp1Pips * pip),
      tp2: round2(price + d * RAPID.tp2Pips * pip),
      tp3: null,
      confidence: 60,
      level: round2(lv.price),
      reason: `Rapid: a 5-minute close pushed ${side === "buy" ? "through" : "under"} ${lv.name} (${lv.price.toFixed(2)}) with the candle closing in that direction. Taking ${RAPID.tp1Pips} pips with a ${RAPID.stopPips}-pip stop.`,
    };
  }
  return null;
}

/* ───────────────────── STRUCTURE — break and retest (the picky one) ─────────────────────
 * A level must BREAK on a closed 15-minute candle, price must come BACK to it, and the retest must HOLD
 * (a candle that touches the level and closes back on the breakout side). No retest, no trade. The stop sits
 * beyond the retest wick, the first target is the measured move.
 */
export const STRUCTURE = { lookback: 40, retestBars: 12, holdFrac: 0.45, minStopPips: 15, maxStopPips: 90, maxChasePips: 30, tp1R: 1.6, tp2R: 2.6 };

export function detectStructure(ctx: StyleCtx): Setup | null {
  const { m15, pip, price } = ctx;
  if (m15.length < STRUCTURE.lookback + 4) return null;
  const window = m15.slice(-(STRUCTURE.lookback + STRUCTURE.retestBars), -STRUCTURE.retestBars);
  const level = { high: hi(window), low: lo(window) };
  const after = m15.slice(-STRUCTURE.retestBars);
  if (!after.length) return null;

  for (const dir of ["buy", "sell"] as const) {
    const lv = dir === "buy" ? level.high : level.low;
    const broke = after.findIndex((b) => (dir === "buy" ? b.c > lv : b.c < lv));
    if (broke < 0) continue;
    const since = after.slice(broke + 1);
    if (since.length < 2) continue;                                    // needs a bar to come back
    // the retest: a bar that trades back to the level and closes back on the breakout side
    const retest = since.find((b) => (dir === "buy"
      ? b.l <= lv + 3 * pip && b.c > lv && (b.c - b.l) > (b.h - b.l) * STRUCTURE.holdFrac
      : b.h >= lv - 3 * pip && b.c < lv && (b.h - b.c) > (b.h - b.l) * STRUCTURE.holdFrac));
    if (!retest) continue;
    if (Math.abs(price - lv) > STRUCTURE.maxChasePips * pip) continue;  // price has left the level behind
    const d = dir === "buy" ? 1 : -1;
    const stopRaw = dir === "buy" ? Math.min(retest.l, lv) - 4 * pip : Math.max(retest.h, lv) + 4 * pip;
    const stopPips = Math.abs(price - stopRaw) / pip;
    if (stopPips < STRUCTURE.minStopPips || stopPips > STRUCTURE.maxStopPips) continue;
    const r = Math.abs(price - stopRaw);
    return {
      style: "structure", side: dir,
      entryLow: round2(Math.min(price, lv)), entryHigh: round2(Math.max(price, lv)),
      stop: round2(stopRaw),
      tp1: round2(price + d * r * STRUCTURE.tp1R),
      tp2: round2(price + d * r * STRUCTURE.tp2R),
      tp3: null,
      confidence: 72,
      level: round2(lv),
      reason: `Structure: ${lv.toFixed(2)} broke on a closed 15-minute candle, price came back to it, and the retest held (${dir === "buy" ? "buyers defended it" : "sellers defended it"}). Stop beyond the retest, first target at 1.6R.`,
    };
  }
  return null;
}

/* ─────────────────────────────── SWING — the patient one ───────────────────────────────
 * Daily and 4-hour levels only. Price must sweep a daily extreme and reclaim it (the classic stop-run
 * reversal) with the 4-hour trend agreeing. Wide stop, targets measured against the opposite daily level.
 */
export const SWING = { minStopPips: 60, maxStopPips: 260, tp1R: 1.8, tp2R: 3, sweepBars: 6 };

export function detectSwing(ctx: StyleCtx): Setup | null {
  const { h1, h4, d1, pip, price } = ctx;
  if (d1.length < 6 || h4.length < 20 || h1.length < 12) return null;
  const prior = d1.slice(-4, -1);
  if (prior.length < 3) return null;
  const dHigh = hi(prior), dLow = lo(prior);
  const recent = h1.slice(-SWING.sweepBars);
  const ema = (vals: number[], p: number) => vals.reduce((acc, v, i) => (i ? acc + (v - acc) * (2 / (p + 1)) : v), 0);
  const h4Trend = ema(h4.slice(-30).map((b) => b.c), 10) - ema(h4.slice(-30).map((b) => b.c), 25);

  const sweptLow = recent.some((b) => b.l < dLow) && price > dLow && h4Trend > 0;
  const sweptHigh = recent.some((b) => b.h > dHigh) && price < dHigh && h4Trend < 0;
  if (!sweptLow && !sweptHigh) return null;

  const side: "buy" | "sell" = sweptLow ? "buy" : "sell";
  const d = side === "buy" ? 1 : -1;
  const extreme = sweptLow ? Math.min(...recent.map((b) => b.l)) : Math.max(...recent.map((b) => b.h));
  const stopRaw = sweptLow ? extreme - 10 * pip : extreme + 10 * pip;
  const stopPips = Math.abs(price - stopRaw) / pip;
  if (stopPips < SWING.minStopPips || stopPips > SWING.maxStopPips) return null;
  const r = Math.abs(price - stopRaw);
  return {
    style: "swing", side,
    entryLow: round2(Math.min(price, sweptLow ? dLow : dHigh)), entryHigh: round2(Math.max(price, sweptLow ? dLow : dHigh)),
    stop: round2(stopRaw),
    tp1: round2(price + d * r * SWING.tp1R),
    tp2: round2(price + d * r * SWING.tp2R),
    tp3: null,
    confidence: 78,
    level: round2(sweptLow ? dLow : dHigh),
    reason: `Swing: price ran the ${sweptLow ? "low" : "high"} of the last three days (${(sweptLow ? dLow : dHigh).toFixed(2)}), reclaimed it, and the 4-hour trend agrees. Stop beyond the sweep, first target at 1.8R.`,
  };
}

/** Run every style; returns each style's setup (or null) so the shadow recorder can log all three. */
export function detectAll(ctx: StyleCtx): Record<"rapid" | "structure" | "swing", Setup | null> {
  return { rapid: detectRapid(ctx), structure: detectStructure(ctx), swing: detectSwing(ctx) };
}
