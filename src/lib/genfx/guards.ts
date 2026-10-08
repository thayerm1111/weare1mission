import { type Mode } from "@/lib/genxCompute";
import { BREAKER_LOSSES, BREAKER_WINDOW_MS, BREAKER_PAUSE_MS, deskBreaker } from "@/lib/genx/rangeGuard";
import { type FxPair, U, units, px } from "@/lib/genfx/pairs";
import { rewardRisk, ENTRY_FLOOR_RR } from "@/lib/genfx/decide";

/**
 * GEN FX — THE PLACEMENT GUARDS, as pure functions.
 *
 * These are the checks GENX runs between "the scanner says enter" and "an order leaves"
 * (autoExec.placeGenxGold and the files it calls), at the settings gold runs live. Each is the same
 * rule with gold's dollars expressed in the pair's units. One is GEN FX's own — the minimum stop — and
 * says so. Three of gold's are deliberately NOT here, because they are tuning measured on gold fills
 * and nothing else: the 100-pip stop cap on Quick, the 0.5R "near target" take-profit, and the
 * 30-pip break-even trigger. A currency pair gets the engine's own stop and target, and the trade
 * manager's generic break-even.
 */

/* ── The corrupt-stop bound (placeGenxGold "stop_data_insane") ──────────────────────────────────── */
/** A "structural" stop this far from its own zone is a bad number, not a strategy. Wider horizons carry wider stops. */
export function stopSane(pair: FxPair, mode: Mode | string | null | undefined, entry: number, stop: number): { ok: boolean; distUnits: number; maxUnits: number } {
  const mult = mode === "swing" ? 8 : mode === "intraday" ? 4 : 2.5;
  const maxUnits = mult * U.stopAllowance;
  const distUnits = Math.abs(entry - stop) / pair.unit;
  return { ok: distUnits <= maxUnits + 1e-9, distUnits: +distUnits.toFixed(2), maxUnits };
}

/* ── The quality gate (genx/qualityGate.ts) ─────────────────────────────────────────────────────── */
export const MIN_RR = 1.0;
export type GateResult = { ok: boolean; reason: string; rr: number | null; slope: number | null };

/**
 * Reward at the WORST fill we allow must still be at least 1:1, and — for a scanner call — the
 * 20-hour average must be moving the trade's way. `slope` null skips the trend half (a page setup is
 * entered at a level chosen in advance, and gold skips it for those too; missing data also skips it,
 * so a feed gap never freezes the desk).
 */
export function qualityGate(pair: FxPair, o: { side: "buy" | "sell"; entryLow: number | null; entryHigh: number | null; stop: number | null; tp: number | null; slope: number | null }): GateResult {
  const dir = o.side === "buy" ? 1 : -1;
  const edge = o.side === "buy" ? (o.entryHigh ?? o.entryLow) : (o.entryLow ?? o.entryHigh);
  const ref = edge != null && edge > 0 ? edge + dir * units(pair, U.chase) : null;
  let rr: number | null = null;
  if (ref != null && o.stop != null && o.tp != null) {
    const risk = Math.abs(ref - o.stop);
    const reward = dir * (o.tp - ref);
    rr = risk > 0 ? reward / risk : null;
  }
  if (rr != null && rr < MIN_RR) return { ok: false, reason: `reward ${rr.toFixed(2)} to 1 at the worst allowed fill — needs ${MIN_RR}`, rr, slope: o.slope };
  const minSlope = units(pair, U.slope);
  if (o.slope != null && dir * o.slope < minSlope) {
    const pips = (o.slope / pair.pip).toFixed(1);
    return { ok: false, reason: `the 20-hour average moved ${o.slope >= 0 ? "+" : ""}${pips} pips in 3 hours — not ${o.side === "buy" ? "rising" : "falling"} enough`, rr, slope: o.slope };
  }
  return { ok: true, reason: "ok", rr, slope: o.slope };
}

/**
 * The same slope gold reads from its 1-minute archive — the average price of the last 20 hours minus
 * the average of the 20 hours that ended 3 hours ago — from 15-minute closes (80 bars is 20 hours, 12
 * bars is 3). `closes` is oldest → newest and must be CLOSED bars. Null when there is not enough.
 */
export function slopeFrom15m(closes: number[]): number | null {
  const xs = closes.filter((n) => Number.isFinite(n) && n > 0);
  if (xs.length < 92) return null;
  const avg = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
  return avg(xs.slice(-80)) - avg(xs.slice(-92, -12));
}

/* ── The chase guard (autoExec.goldChasedAt) ────────────────────────────────────────────────────── */
/** Price already ran: at or through the target, or the reward left is under the floor. No feed → not chased. */
export function chasedAt(side: "buy" | "sell", stop: number | null, tp: number | null, lp: number | null): boolean {
  if (stop == null || tp == null || lp == null) return false;
  if (side === "buy" && lp >= tp) return true;
  if (side === "sell" && lp <= tp) return true;
  const rr = rewardRisk(lp, stop, tp);
  return rr != null && rr < ENTRY_FLOOR_RR;
}

/* ── Noise room and the structural stop (autoExec.noiseRoomFromBars, sizing.structuralStop) ─────── */
/** Room a stop needs from the fill: 1.3 × the average range of recent closed 5-minute bars, never under the floor. */
export function noiseRoom(pair: FxPair, bars: { h: number; l: number }[]): number {
  const floor = units(pair, U.noiseFloor);
  const ranges = bars.map((b) => b.h - b.l).filter((r) => Number.isFinite(r) && r > 0);
  if (ranges.length < 6) return Math.max(floor, units(pair, U.noiseFallback));
  const avg = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  return px(pair, Math.max(floor, avg * 1.3));
}

/**
 * The signal's stop is the strategy's — it is kept. The one adjustment: a fill sitting nearly ON the
 * invalidation gets its stop pushed BEYOND the level until it has `minRoom`. Never tightened, never
 * re-derived from the live print. (sizing.structuralStop, at the pair's precision instead of gold's
 * two decimals — which would round a EUR/USD stop to the nearest whole cent.)
 */
export function structuralStop(pair: FxPair, o: { side: "buy" | "sell"; ref: number; anchor: number; minRoom: number }): number {
  if (!(o.ref > 0) || !(o.anchor > 0)) return o.anchor;
  const dist = Math.abs(o.ref - o.anchor);
  if (dist >= o.minRoom) return o.anchor;
  const pad = o.minRoom - dist;
  return px(pair, o.side === "sell" ? o.anchor + pad : o.anchor - pad);
}

/* ── GEN FX's own: the minimum stop ─────────────────────────────────────────────────────────────── */
/** Is the stop that will actually be placed wide enough to trade? See FxPair.minStopPips for why this exists. */
export function stopWideEnough(pair: FxPair, ref: number, stop: number, minPips: number): { ok: boolean; pips: number } {
  const p = Math.abs(ref - stop) / pair.pip;
  return { ok: p >= minPips - 1e-6, pips: Math.round(p * 10) / 10 };
}

/* ── Change of character (genx/choch.ts) ────────────────────────────────────────────────────────── */
export type Bar = { h: number; l: number; c: number };
/** A fresh structure flip on closed 5-minute bars. The swing it must clear is ~5× the bar range, clamped in units. */
export function fxChoch(pair: FxPair, bars: Bar[]): "bullish" | "bearish" | null {
  if (bars.length < 8) return null;
  const lastClose = bars[bars.length - 1].c;
  let loIdx = 0, hiIdx = 0;
  for (let i = 1; i < bars.length; i++) { if (bars[i].l < bars[loIdx].l) loIdx = i; if (bars[i].h > bars[hiIdx].h) hiIdx = i; }
  const tr = bars.slice(-15).map((b) => b.h - b.l).filter((v) => Number.isFinite(v) && v >= 0);
  const atr5 = tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : 0;
  const legMin = Math.max(units(pair, U.chochMin), Math.min(units(pair, U.chochMax), atr5 > 0 ? atr5 * 5 : units(pair, U.chochDefault)));
  if (bars[hiIdx].h - bars[loIdx].l < legMin) return null;
  if (loIdx < hiIdx) {
    const priorHigh = Math.max(...bars.slice(0, loIdx + 1).map((b) => b.h));
    if (lastClose > priorHigh) return "bullish";
  }
  if (hiIdx < loIdx) {
    const priorLow = Math.min(...bars.slice(0, hiIdx + 1).map((b) => b.l));
    if (lastClose < priorLow) return "bearish";
  }
  return null;
}
export const chochBlocks = (side: "buy" | "sell", flip: "bullish" | "bearish" | null): boolean =>
  (side === "sell" && flip === "bullish") || (side === "buy" && flip === "bearish");

/* ── The desk breaker (autoExec.goldDeskBreaker / lossEventsByTrade) ────────────────────────────── */
export type StopRow = { side: string | null; init_stop: number | null; resolved_at: string | null; result_pips: number | null; partial_taken: boolean | null };

/**
 * One real trade is one loss. A fan-out puts the same call on many accounts, and they do not stop
 * out together — so stop-outs are grouped by side and INITIAL STOP (every account filling one call
 * is given the same stop) and each group counts once, at its latest close. Keyed at the pair's
 * precision: gold's version keys to two decimals, which would fold every EUR/USD stop into "1.08".
 */
export function fxLossEvents(pair: FxPair, rows: StopRow[]): number[] {
  const minPips = units(pair, U.realLoss) / pair.pip;
  const byTrade = new Map<string, number>();
  for (const r of rows) {
    // A real loss is a real net result. result_pips counts any partial banked on the way (10-08), so a
    // partial that pulled the stop-out above the line keeps it out, and one that did not, does not.
    if (!(Number(r.result_pips) <= -minPips)) continue;
    const t = r.resolved_at ? Date.parse(r.resolved_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const stop = r.init_stop == null || !Number.isFinite(Number(r.init_stop)) ? `t${Math.floor(t / 600_000)}` : Number(r.init_stop).toFixed(pair.dec);
    const key = `${String(r.side ?? "").toLowerCase()}@${stop}`;
    byTrade.set(key, Math.max(byTrade.get(key) ?? 0, t));
  }
  return [...byTrade.values()].sort((a, b) => b - a);
}

/** Three real stop-outs on a pair inside six hours pause new entries on it for four, from the last loss. */
export function fxBreaker(pair: FxPair, rows: StopRow[], nowMs = Date.now()): { paused: boolean; until: number; count: number } {
  return deskBreaker(fxLossEvents(pair, rows), nowMs, BREAKER_LOSSES);
}
export { BREAKER_WINDOW_MS, BREAKER_PAUSE_MS, BREAKER_LOSSES };

/* ── All of it, in the order placement runs it ──────────────────────────────────────────────────── */
export type Signal = {
  side: "buy" | "sell"; mode: Mode | string | null;
  entryLow: number | null; entryHigh: number | null; stop: number | null; tp: number | null;
  /** "zone" = a page setup entered on touch; "scanner" = a confirmed scanner call. */
  setup: "zone" | "scanner";
};
export type Market = {
  /** Live price, or null when the feed is down. */
  live: number | null;
  /** Noise room for the stop (noiseRoom). */
  room: number;
  /** 20-hour slope (slopeFrom15m), or null when unknown. Ignored for page setups. */
  slope: number | null;
  /** Fresh structure flip, or null. */
  choch: "bullish" | "bearish" | null;
  /** Is the pair's desk breaker holding entries? */
  breakerPaused: boolean;
  minStopPips: number;
};
export type Verdict =
  | { ok: true; entry: number; sizeEntry: number; stop: number; tp: number; stopPips: number; rr: number | null }
  | { ok: false; reason: string; code: string };

/**
 * Should this call be placed at all? Pure: the same answer for the live desk and the replay. Every
 * "no" carries a code (for counting) and a sentence (for the breadcrumb a member can read).
 */
export function judgeSignal(pair: FxPair, sig: Signal, m: Market): Verdict {
  const no = (code: string, reason: string): Verdict => ({ ok: false, code, reason });
  const entry = sig.entryLow != null && sig.entryHigh != null ? (sig.entryLow + sig.entryHigh) / 2 : (sig.entryLow ?? sig.entryHigh);
  if (entry == null || sig.stop == null || sig.tp == null) return no("bad_levels", "the call is missing an entry, stop or target");
  const buy = sig.side === "buy";
  if (buy ? !(sig.stop < entry && entry < sig.tp) : !(sig.stop > entry && entry > sig.tp)) return no("bad_levels", "the stop and target are not either side of the entry");

  const q = qualityGate(pair, { side: sig.side, entryLow: sig.entryLow, entryHigh: sig.entryHigh, stop: sig.stop, tp: sig.tp, slope: sig.setup === "zone" ? null : m.slope });
  if (!q.ok) return no("quality_gate", q.reason);
  if (m.breakerPaused) return no("desk_breaker", `three losing ${pair.name} trades inside six hours — new entries on it are paused`);
  if (chochBlocks(sig.side, m.choch)) return no("change_of_character", `${pair.name} structure just flipped ${m.choch} — not taking a ${buy ? "BUY" : "SELL"} against it`);

  const ref = m.live != null && m.live > 0 ? m.live : entry;
  if (buy ? ref <= sig.stop : ref >= sig.stop) return no("through_stop", "price is already through the stop");
  const stop = structuralStop(pair, { side: sig.side, ref, anchor: sig.stop, minRoom: m.room });
  const sane = stopSane(pair, sig.mode, entry, stop);
  if (!sane.ok) return no("stop_data_insane", `the stop is ${(Math.abs(entry - stop) / pair.pip).toFixed(1)} pips from its own zone — that is a bad number, not a setup`);
  const wide = stopWideEnough(pair, ref, stop, m.minStopPips);
  if (!wide.ok) return no("stop_too_tight", `the stop is ${wide.pips} pips — under the ${m.minStopPips}-pip minimum for ${pair.name}, where the spread would be too much of the risk`);
  if (chasedAt(sig.side, stop, sig.tp, m.live)) {
    const rr = rewardRisk(m.live, stop, sig.tp);
    return no("chased", `price ran past the zone${rr != null ? ` (reward now ${rr.toFixed(2)} to 1, floor ${ENTRY_FLOOR_RR})` : ""}`);
  }
  return { ok: true, entry, sizeEntry: ref, stop, tp: sig.tp, stopPips: wide.pips, rr: rewardRisk(ref, stop, sig.tp) };
}
