import { MODES, type Mode, type Row } from "@/lib/genxCompute";
import { CONFIRM_IV } from "@/lib/genxConfirm";
import { inWeekendCloseWindow, inScanQuietWindow } from "@/lib/flow/autoExec";
import { type FxPair, U, units } from "@/lib/genfx/pairs";
import { readFromSeries, genfxOf } from "@/lib/genfx/compute";
import { confirmFromCandles, type Candle } from "@/lib/genfx/confirm";
import { decideFxEntry, sameSetupZone, scanKey, zoneKey, zoneOf, zoneAction, zoneBand, ZONE_TTL_MS, SAME_SETUP_WINDOW_MS } from "@/lib/genfx/decide";
import { judgeSignal, noiseRoom, slopeFrom15m, fxChoch, fxBreaker, type StopRow } from "@/lib/genfx/guards";

/**
 * GEN FX REPLAY — what would GEN FX have done over real history?
 *
 * GEN FX has no track record: the engine's record is all gold. Before anybody's account takes a
 * trade from it, this runs the WHOLE live pipeline over months of real 5-minute candles — the same
 * functions the live desk calls, not a re-implementation of them:
 *
 *   the engine read, every five minutes, on all three horizons          (compute.readFromSeries)
 *   page setups registered and entered on touch                         (decide.zoneOf / zoneAction)
 *   scanner setups: heads-up, closed-candle confirmation, arm / enter   (confirm.confirmFromCandles, decide.decideFxEntry)
 *   the placement guards                                                (guards.judgeSignal)
 *   one trade per pair per side, the desk breaker
 *   the trade manager's break-even and trail for a non-gold position    (simulated here, see `manageBar`)
 *
 * WHAT IT IS HONEST ABOUT.
 *   • No lookahead. At each step the engine sees only candles that had CLOSED by then, plus the price
 *     of that moment. tests/genfx-replay.test.ts cuts the future off and requires the past not to move.
 *   • Costs are charged. Every trade pays `costPips` (spread + commission) — a replay that trades for
 *     free flatters a tight-stop strategy more than anything else.
 *   • The unknown order of events inside one candle is resolved AGAINST the trade: if a candle's range
 *     holds both the stop and the target, it is a loss; a setup entered inside a candle can be stopped
 *     by that candle but not paid by it.
 *   • It reports both ways of running a trade: as the live manager would (break-even, then a trail),
 *     and left alone on its original stop and target.
 *
 * WHAT IT CANNOT KNOW. Fills are assumed at the price of the moment — live fills are worse, most of
 * all around news. Five-minute candles hide what happened inside them. And a setting chosen by
 * looking at this history will look better on this history than it will live.
 */

export type Bar = { t: number; o: number; h: number; l: number; c: number };   // t = candle START, ms UTC, 5-minute, ascending

export type ReplayParams = {
  /** Round-trip cost per trade in pips. Default: the pair's own. */
  costPips?: number;
  /** Tightest stop taken, in pips. Default: the pair's own. */
  minStopPips?: number;
  modes?: Mode[];
  /** Candles of history the engine needs before the first decision (weekly bars for Swing). */
  warmupBars?: number;
  /**
   * Called whenever the run has held the thread for `yieldEveryMs` (default 12ms), so a long replay
   * shares its process — on the worker that process is also running the trade manager.
   */
  onYield?: () => Promise<void>;
  yieldEveryMs?: number;
  /** Keep every call that reached placement in the result (the tests compare them; a stored result does not need them). */
  keepEvents?: boolean;
};

const M5 = 5 * 60_000;
const TF_MS: Record<string, number> = { "1min": M5, "5min": M5, "15min": 15 * 60_000, "30min": 30 * 60_000, "1h": 3600_000, "4h": 4 * 3600_000, "1day": 86_400_000, "1week": 7 * 86_400_000 };
const MONDAY = 4 * 86_400_000;     // 1970-01-05 was a Monday
const bucketStart = (tf: string, t: number): number => tf === "1week" ? Math.floor((t - MONDAY) / TF_MS[tf]) * TF_MS[tf] + MONDAY : Math.floor(t / TF_MS[tf]) * TF_MS[tf];
const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");
const row = (t: number, o: number, h: number, l: number, c: number): Row => ({ datetime: stamp(t), open: String(o), high: String(h), low: String(l), close: String(c) });

type Series = { rows: Row[]; bars: Candle[]; end: number[] };

/** Build one timeframe from the 5-minute base. Buckets are UTC-aligned (weeks start Monday). */
export function aggregate(base: Bar[], tf: string): Series {
  const rows: Row[] = [], bars: Candle[] = [], end: number[] = [];
  let cur: { s: number; o: number; h: number; l: number; c: number } | null = null;
  const flush = () => { if (cur) { rows.push(row(cur.s, cur.o, cur.h, cur.l, cur.c)); bars.push({ o: cur.o, h: cur.h, l: cur.l, c: cur.c }); end.push(cur.s + TF_MS[tf]); } };
  for (const b of base) {
    const s = bucketStart(tf, b.t);
    if (!cur || cur.s !== s) { flush(); cur = { s, o: b.o, h: b.h, l: b.l, c: b.c }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
  }
  flush();
  return { rows, bars, end };
}

type Read = {
  action: string; state: string; entry: number | null; entry_low: number | null; entry_high: number | null;
  stop_loss: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  closest_support: number | null; closest_resistance: number | null; invalidation_price: number | null;
};
type SimAlert = {
  id: number; key: string; mode: Mode; side: "buy" | "sell"; kind: "zone" | "scanner";
  state: "zone" | "forming" | "entered" | "invalidated" | "expired" | "replaced";
  entry: number | null; entry_low: number; entry_high: number; stop: number; tp1: number | null;
  invalidation: number; createdAt: number; armedAt: number | null; enteredAt: number | null; enterPrice: number | null;
  outcome: "win" | "loss" | "expired" | null;
};
export type EnterEvent = {
  i: number; at: number; mode: Mode; side: "buy" | "sell"; setup: "zone" | "scanner";
  entryLow: number; entryHigh: number; stop: number; tp: number | null; fill: number;
  /** Entered INSIDE candle i (a touch) rather than at its close. */
  intrabar: boolean;
  room: number; slope: number | null; choch: "bullish" | "bearish" | null;
};
export type SimTrade = {
  mode: Mode; side: "buy" | "sell"; setup: "zone" | "scanner"; openedAt: number; closedAt: number;
  entry: number; stop: number; tp: number; stopPips: number;
  exit: number; how: "stop" | "target" | "breakeven" | "trail" | "open"; pips: number; r: number;
};
type Tally = { n: number; wins: number; losses: number; pips: number; r: number; avgStopPips: number; avgR: number; winRate: number; maxDrawdownR: number; byExit: Record<string, number> };
export type ReplayOut = {
  pair: string; from: string; to: string; bars: number; steps: number;
  costPips: number; minStopPips: number;
  /** Average candle range, in pips and in this pair's units — the check on pairs.ts `unit`. */
  ranges: Record<string, { pips: number; units: number }>;
  /** What the scanner called, graded on paper (first target or stop first; nobody had to take it). */
  alerts: Record<string, { entered: number; win: number; loss: number; expired: number }>;
  /** Calls that reached placement, and why the ones that were not placed were not. */
  placement: { calls: number; placed: number; skipped: Record<string, number> };
  managed: { all: Tally; byMode: Record<string, Tally>; bySetup: Record<string, Tally>; firstHalf: Tally; secondHalf: Tally };
  raw: { all: Tally; byMode: Record<string, Tally>; bySetup: Record<string, Tally>; firstHalf: Tally; secondHalf: Tally };
  trades: SimTrade[];
  events?: EnterEvent[];
};

const MODE_LIST: Mode[] = ["quick", "intraday", "swing"];
const FORMING_TTL: Record<Mode, number> = { quick: 8 * 3600_000, intraday: 8 * 3600_000, swing: 48 * 3600_000 };

/* ── the trade manager's rules for a non-gold position (flow/flowManage.ts), one candle at a time ── */
const BE_MIN_PIPS = 8, BE_PROFIT_PIPS = 5, PAD_FLOOR_PIPS = 3, GIVEBACK_R = 0.6, GIVEBACK_NEAR_R = 0.25, NEAR_TP_R = 0.4, NEAR_PARTIAL_R = 0.2;

export type Open = {
  ev: EnterEvent; entry: number; stop: number; tp: number; R: number; stopPips: number;
  cur: number; best: number; be: boolean; bePx: number; beTrigger: number; halfway: number;
};

export function openTrade(pair: FxPair, ev: EnterEvent, v: { sizeEntry: number; stop: number; tp: number; stopPips: number }, costPips: number): Open {
  const long = ev.side === "buy";
  const entry = v.sizeEntry, R = Math.abs(entry - v.stop);
  const halfway = (entry + v.tp) / 2;
  const cands = [halfway, long ? entry + R : entry - R];
  let trig = long ? Math.min(...cands) : Math.max(...cands);
  const floor = long ? entry + BE_MIN_PIPS * pair.pip : entry - BE_MIN_PIPS * pair.pip;
  trig = long ? Math.max(trig, floor) : Math.min(trig, floor);
  const pad = Math.min(Math.max(costPips, PAD_FLOOR_PIPS), 40) * pair.pip;
  const bePx = long ? entry + BE_PROFIT_PIPS * pair.pip + pad : entry - BE_PROFIT_PIPS * pair.pip - pad;
  return { ev, entry, stop: v.stop, tp: v.tp, R, stopPips: v.stopPips, cur: v.stop, best: entry, be: false, bePx, beTrigger: trig, halfway };
}

/**
 * Run one candle past an open trade. Returns the exit, or null if it is still open. Adverse first:
 * the stop is checked against the candle's worst price before anything favourable is credited.
 * `entryBar` = the trade was opened inside this candle, so only its stop is checked.
 */
export function manageBar(pair: FxPair, o: Open, b: Bar, managed: boolean, entryBar: boolean): { exit: number; how: SimTrade["how"] } | null {
  const long = o.ev.side === "buy";
  const adverse = long ? b.l : b.h, favour = long ? b.h : b.l;
  const hitStop = long ? adverse <= o.cur : adverse >= o.cur;
  if (hitStop) {
    // A candle that OPENS beyond the stop (the Sunday open, a news gap) fills there, not at the stop:
    // a stop is an order to sell at the market once touched, and the market was already past it.
    const gapped = !entryBar && (long ? b.o < o.cur : b.o > o.cur);
    return { exit: gapped ? b.o : o.cur, how: !o.be ? "stop" : Math.abs(o.cur - o.bePx) < pair.pip / 2 ? "breakeven" : "trail" };
  }
  if (entryBar) return null;
  if (long ? favour >= o.tp : favour <= o.tp) return { exit: o.tp, how: "target" };
  if (!managed) return null;

  o.best = long ? Math.max(o.best, favour) : Math.min(o.best, favour);
  const twoPips = 2 * pair.pip;
  if (!o.be) {
    // Break-even fires when the market reaches the trigger with price safely beyond the lock.
    const need = long ? Math.max(o.beTrigger, o.bePx + twoPips) : Math.min(o.beTrigger, o.bePx - twoPips);
    if (long ? favour >= need : favour <= need) {
      o.be = true; o.cur = o.bePx;
      // The candle then closed back through the lock: the lock was hit on the way.
      if (long ? b.c <= o.bePx : b.c >= o.bePx) return { exit: o.bePx, how: "breakeven" };
    }
    return null;
  }
  // The trail: a stop that ratchets behind the best price, tighter once the move is close to its target.
  const peakR = (long ? o.best - o.entry : o.entry - o.best) / o.R;
  const toTargetR = (long ? o.tp - o.best : o.best - o.tp) / o.R;
  const partialR = (long ? o.halfway - o.entry : o.entry - o.halfway) / o.R;
  const give = (toTargetR <= NEAR_TP_R || peakR >= partialR - NEAR_PARTIAL_R ? GIVEBACK_NEAR_R : GIVEBACK_R) * o.R;
  const want = long ? o.best - give : o.best + give;
  const lifted = long ? Math.max(want, o.bePx) : Math.min(want, o.bePx);
  // The candle gave back more than the trail allows after making its best: it was trailed out on the way.
  if (long ? (lifted > o.cur && b.c <= lifted) : (lifted < o.cur && b.c >= lifted)) return { exit: lifted, how: "trail" };
  const buf = Math.max(o.R * 0.1, twoPips);
  const capped = long ? Math.min(lifted, b.c - buf) : Math.max(lifted, b.c + buf);
  if (long ? capped > o.cur + o.R * 0.05 : capped < o.cur - o.R * 0.05) o.cur = capped;
  return null;
}

function tally(trades: SimTrade[]): Tally {
  const n = trades.length;
  const byExit: Record<string, number> = {};
  let wins = 0, losses = 0, pips = 0, r = 0, stopSum = 0, peak = 0, eq = 0, dd = 0;
  for (const t of trades) {
    if (t.pips > 0) wins++; else if (t.pips < 0) losses++;
    pips += t.pips; r += t.r; stopSum += t.stopPips;
    byExit[t.how] = (byExit[t.how] ?? 0) + 1;
    eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { n, wins, losses, pips: Math.round(pips * 10) / 10, r: r2(r), avgStopPips: n ? Math.round((stopSum / n) * 10) / 10 : 0, avgR: n ? r2(r / n) : 0, winRate: n ? Math.round((wins / n) * 1000) / 10 : 0, maxDrawdownR: r2(dd), byExit };
}
function tallies(trades: SimTrade[], midMs: number) {
  const group = (key: (t: SimTrade) => string) => { const out: Record<string, Tally> = {}; for (const k of [...new Set(trades.map(key))]) out[k] = tally(trades.filter((t) => key(t) === k)); return out; };
  return { all: tally(trades), byMode: group((t) => t.mode), bySetup: group((t) => t.setup), firstHalf: tally(trades.filter((t) => t.openedAt < midMs)), secondHalf: tally(trades.filter((t) => t.openedAt >= midMs)) };
}

/** Place and run the entered calls. `managed` = with the live manager's break-even and trail, or left alone. */
export function runTrades(pair: FxPair, base: Bar[], events: EnterEvent[], managed: boolean, costPips: number, minStopPips: number): { trades: SimTrade[]; placement: ReplayOut["placement"] } {
  const trades: SimTrade[] = [];
  const skipped: Record<string, number> = {};
  const open: Open[] = [];
  const stops: StopRow[] = [];
  let placed = 0, e = 0;
  const close = (o: Open, x: { exit: number; how: SimTrade["how"] }, at: number) => {
    const long = o.ev.side === "buy";
    const gross = (long ? x.exit - o.entry : o.entry - x.exit) / pair.pip;
    const pips = Math.round((gross - costPips) * 10) / 10;
    trades.push({ mode: o.ev.mode, side: o.ev.side, setup: o.ev.setup, openedAt: o.ev.at, closedAt: at, entry: o.entry, stop: o.stop, tp: o.tp, stopPips: o.stopPips, exit: x.exit, how: x.how, pips, r: Math.round((pips / o.stopPips) * 100) / 100 });
    if (x.how === "stop") stops.push({ side: o.ev.side, init_stop: o.stop, resolved_at: new Date(at).toISOString(), result_pips: Math.round(gross), partial_taken: false });
  };
  const tryOpen = (ev: EnterEvent, openAtStart: Set<Open> | null) => {
    const m = { live: ev.fill, room: ev.room, slope: ev.slope, choch: ev.choch, breakerPaused: fxBreaker(pair, stops, ev.at).paused, minStopPips };
    const v = judgeSignal(pair, { side: ev.side, mode: ev.mode, entryLow: ev.entryLow, entryHigh: ev.entryHigh, stop: ev.stop, tp: ev.tp, setup: ev.setup }, m);
    if (!v.ok) { skipped[v.code] = (skipped[v.code] ?? 0) + 1; return null; }
    // One GEN FX trade per pair per side. A touch inside a candle is judged against what was open
    // when the candle began — a trade that closed during it does not free the slot retroactively.
    const busy = (openAtStart ? [...openAtStart] : open).some((o) => o.ev.side === ev.side);
    if (busy) { skipped.one_open = (skipped.one_open ?? 0) + 1; return null; }
    const o = openTrade(pair, ev, v, costPips);
    open.push(o); placed++;
    return o;
  };
  for (let i = 0; i < base.length; i++) {
    const b = base[i], at = b.t + M5;
    const atStart = new Set(open);
    for (let k = open.length - 1; k >= 0; k--) {
      const x = manageBar(pair, open[k], b, managed, false);
      if (x) { close(open[k], x, at); open.splice(k, 1); }
    }
    while (e < events.length && events[e].i === i) {
      const ev = events[e++];
      const o = tryOpen(ev, ev.intrabar ? atStart : null);
      if (o && ev.intrabar) {
        const x = manageBar(pair, o, b, managed, true);
        if (x) { close(o, x, at); open.splice(open.indexOf(o), 1); }
      }
    }
  }
  const last = base[base.length - 1];
  for (const o of open) close(o, { exit: last.c, how: "open" }, last.t + M5);
  trades.sort((a, b) => a.closedAt - b.closedAt);
  return { trades, placement: { calls: events.length, placed, skipped } };
}

export async function replay(pair: FxPair, base: Bar[], params: ReplayParams = {}): Promise<ReplayOut> {
  const costPips = params.costPips ?? pair.costPips;
  const minStop = params.minStopPips ?? pair.minStopPips;
  const modes = params.modes?.length ? params.modes : MODE_LIST;
  const warmup = Math.max(params.warmupBars ?? 0, 600);
  const touch = units(pair, U.zoneTouch);

  // Every timeframe any horizon reads, built once from the 5-minute base.
  const tfs = new Set<string>(["5min", "15min"]);
  for (const m of modes) { const tf = MODES[m].tf; [tf.d1, tf.h1, tf.m30, tf.m15, tf.m5].forEach((x) => tfs.add(x)); tfs.add(CONFIRM_IV[m]); }
  const S = new Map<string, Series>();
  for (const tf of tfs) S.set(tf, aggregate(base, tf));
  const ptr = new Map<string, number>([...tfs].map((tf) => [tf, 0]));

  /** The series a live read would get at time T: the last `n − 1` closed candles, then the one still forming. */
  const liveRows = (tf: string, n: number, T: number, i: number, price: number, realForming: boolean): Row[] => {
    const s = S.get(tf)!, k = ptr.get(tf)!;
    const out = s.rows.slice(Math.max(0, k - (n - 1)), k);
    const start = bucketStart(tf, T);
    let o = price, h = price, l = price;
    if (realForming) { let first = true; for (let j = i; j >= 0 && base[j].t >= start; j--) { h = first ? base[j].h : Math.max(h, base[j].h); l = first ? base[j].l : Math.min(l, base[j].l); o = base[j].o; first = false; } }
    out.push(row(start, o, h, l, price));
    return out;
  };
  const liveCandles = (tf: string, n: number, T: number, i: number, price: number): Candle[] =>
    liveRows(tf, n, T, i, price, true).map((r) => ({ o: +r.open, h: +r.high, l: +r.low, c: +r.close }));

  const alerts = new Map<string, SimAlert>();
  const open: SimAlert[] = [];           // alerts still in play: zone, forming, or entered and not yet graded
  const events: EnterEvent[] = [];
  const paper: Record<string, { entered: number; win: number; loss: number; expired: number }> = {};
  const paperOf = (a: SimAlert) => (paper[`${a.kind}:${a.mode}`] ??= { entered: 0, win: 0, loss: 0, expired: 0 });
  let nextId = 1, steps = 0;
  const yieldEvery = Math.max(1, params.yieldEveryMs ?? 12);
  let lastYield = Date.now();

  const marketAt = (i: number, T: number) => {
    const k5 = ptr.get("5min")!, k15 = ptr.get("15min")!;
    const m5 = S.get("5min")!.bars, m15 = S.get("15min")!.bars;
    return {
      room: noiseRoom(pair, m5.slice(Math.max(0, k5 - 12), k5)),
      choch: k5 >= 8 ? fxChoch(pair, m5.slice(Math.max(0, k5 - 30), k5)) : null,
      slope: slopeFrom15m(m15.slice(Math.max(0, k15 - 100), k15).map((b) => b.c)),
    };
  };
  const enter = (a: SimAlert, i: number, T: number, fill: number, intrabar: boolean) => {
    a.state = "entered"; a.enteredAt = T; a.enterPrice = fill;
    paperOf(a).entered++;
    const m = marketAt(i, T);
    events.push({ i, at: T, mode: a.mode, side: a.side, setup: a.kind, entryLow: a.entry_low, entryHigh: a.entry_high, stop: a.stop, tp: a.tp1, fill, intrabar, room: m.room, slope: a.kind === "scanner" ? m.slope : null, choch: m.choch });
  };
  const twinOf = (z: { side: "buy" | "sell"; entry_low: number; entry_high: number }, T: number, excludeId?: number): SimAlert | null => {
    for (const a of open) {
      if (a.id === excludeId || a.kind !== "scanner" || a.mode !== "quick" || a.outcome) continue;
      if (a.state !== "forming" && a.state !== "entered") continue;
      if (T - a.createdAt > SAME_SETUP_WINDOW_MS) continue;
      if (sameSetupZone(pair, a, z)) return a;
    }
    return null;
  };

  for (let i = 0; i < base.length; i++) {
    const b = base[i], T = b.t + M5, price = b.c;
    for (const tf of tfs) { const s = S.get(tf)!; let k = ptr.get(tf)!; while (k < s.end.length && s.end[k] <= T) k++; ptr.set(tf, k); }
    if (i < warmup) continue;
    steps++;
    if (params.onYield && Date.now() - lastYield >= yieldEvery) { await params.onYield(); lastYield = Date.now(); }
    const when = new Date(T);
    const quiet = inWeekendCloseWindow(when) || inScanQuietWindow(when);

    for (let k = open.length - 1; k >= 0; k--) {
      const a = open[k];
      // ── paper grade of a call already entered: first target or stop first, stop wins a tie ──
      if (a.state === "entered") {
        if (a.enteredAt === T) continue;
        const sell = a.side === "sell";
        const hitStop = sell ? b.h >= a.stop : b.l <= a.stop;
        const hitTp = a.tp1 != null && (sell ? b.l <= a.tp1 : b.h >= a.tp1);
        if (hitStop) a.outcome = "loss"; else if (hitTp) a.outcome = "win"; else if (T - (a.enteredAt ?? T) > 8 * 3600_000) a.outcome = "expired";
        if (a.outcome) { paperOf(a)[a.outcome]++; open.splice(k, 1); }
        continue;
      }
      if (a.createdAt >= T) continue;
      // ── page setup: entered the moment price touches its entry ──
      if (a.state === "zone") {
        if (T - a.createdAt > ZONE_TTL_MS) { a.state = "expired"; open.splice(k, 1); continue; }
        if (quiet || a.entry == null) continue;
        const sell = a.side === "sell";
        const level = sell ? a.entry - touch : a.entry + touch;
        if (sell ? b.o >= a.stop : b.o <= a.stop) { a.state = "invalidated"; open.splice(k, 1); continue; }
        if (sell ? b.h >= level : b.l <= level) enter(a, i, T, sell ? Math.max(b.o, level) : Math.min(b.o, level), true);
        continue;
      }
      // ── pending scanner setup: confirm on closed candles, then enter / arm / drop ──
      if (a.state === "forming") {
        if (T - a.createdAt > FORMING_TTL[a.mode]) { a.state = "expired"; open.splice(k, 1); continue; }
        if (quiet) continue;
        if (a.mode === "quick") { const tw = twinOf(a, T, a.id); if (tw && tw.createdAt <= a.createdAt) { a.state = "invalidated"; open.splice(k, 1); continue; } }
        const conf = confirmFromCandles(pair, { side: a.side, zoneLo: a.entry_low, zoneHi: a.entry_high, inv: a.invalidation, candles: liveCandles(CONFIRM_IV[a.mode], 24, T, i, price), live: price });
        const act = decideFxEntry(pair, { armed: a.armedAt != null, confState: conf.state, lp: price, entryLow: a.entry_low, entryHigh: a.entry_high, stop: a.stop, tp1: a.tp1, armedAtMs: a.armedAt ?? T, nowMs: T });
        if (act.do === "arm") a.armedAt = T;
        else if (act.do === "enter") enter(a, i, T, price, false);
        else if (act.do === "invalidate") { a.state = "invalidated"; open.splice(k, 1); }
      }
    }

    // ── the full scan: read every horizon, register its page setup, record a new scanner setup ──
    // In the quiet window the live scan registers nothing and calls nothing, so there is nothing to read for.
    if (quiet) continue;
    for (const mode of modes) {
      const tf = MODES[mode].tf;
      const r = readFromSeries(pair, mode, {
        d1: liveRows(tf.d1, 90, T, i, price, false), h1: liveRows(tf.h1, 120, T, i, price, false), m30: liveRows(tf.m30, 120, T, i, price, false),
        m15: liveRows(tf.m15, 150, T, i, price, true), m5: liveRows(tf.m5, 150, T, i, price, false),
      }, price, T);
      const g = genfxOf(pair, r.read, { mode, price, session: r.session, dataStatus: "replay", hold: MODES[mode].hold, triggerTf: MODES[mode].triggerTf, contextTf: MODES[mode].contextTf, marketStory: [], volatility: r.volatility, atr: r.atr }) as unknown as Read & { engine_state: string };

      const z = zoneOf(g);
      if (z && zoneAction(pair, z.side, z.entry, z.stop, price) !== "invalidate") {
        const key = zoneKey(pair, mode, z.side, z.entry, T);
        for (let k = open.length - 1; k >= 0; k--) { const a = open[k]; if (a.state === "zone" && a.mode === mode && a.side === z.side && a.key !== key) { a.state = "replaced"; open.splice(k, 1); } }
        if (!alerts.has(key)) {
          const band = zoneBand(pair, z.entry);
          const a: SimAlert = { id: nextId++, key, mode, side: z.side, kind: "zone", state: "zone", entry: z.entry, entry_low: band.low, entry_high: band.high, stop: z.stop, tp1: z.tp1, invalidation: z.stop, createdAt: T, armedAt: null, enteredAt: null, enterPrice: null, outcome: null };
          alerts.set(key, a); open.push(a);
        }
      }

      const st = String(g.engine_state || "");
      if ((st !== "TRADE_READY" && st !== "DEVELOPING_SETUP") || g.entry_low == null || g.entry_high == null || g.stop_loss == null) continue;
      const side: "buy" | "sell" = String(g.action).includes("SELL") ? "sell" : "buy";
      const key = scanKey(pair, mode, side, g.entry_low, g.entry_high, T);
      if (alerts.has(key)) continue;
      if (twinOf({ side, entry_low: g.entry_low, entry_high: g.entry_high }, T)) continue;
      const a: SimAlert = { id: nextId++, key, mode, side, kind: "scanner", state: "forming", entry: g.entry, entry_low: g.entry_low, entry_high: g.entry_high, stop: g.stop_loss, tp1: g.tp1, invalidation: g.invalidation_price ?? g.stop_loss, createdAt: T, armedAt: null, enteredAt: null, enterPrice: null, outcome: null };
      alerts.set(key, a); open.push(a);
      if (st === "TRADE_READY") enter(a, i, T, price, false);
    }
  }

  events.sort((x, y) => x.i - y.i || Number(y.intrabar) - Number(x.intrabar));
  const first = base[Math.min(warmup, base.length - 1)], last = base[base.length - 1];
  const mid = (first.t + last.t) / 2;
  const man = runTrades(pair, base, events, true, costPips, minStop);
  const raw = runTrades(pair, base, events, false, costPips, minStop);

  const ranges: ReplayOut["ranges"] = {};
  for (const tf of ["5min", "15min", "1h", "1day"]) {
    const s = S.get(tf) ?? aggregate(base, tf);
    const avg = s.bars.length ? s.bars.reduce((n, x) => n + (x.h - x.l), 0) / s.bars.length : 0;
    ranges[tf] = { pips: Math.round((avg / pair.pip) * 10) / 10, units: Math.round((avg / pair.unit) * 100) / 100 };
  }

  return {
    pair: pair.key, from: new Date(first.t).toISOString(), to: new Date(last.t + M5).toISOString(), bars: base.length, steps,
    costPips, minStopPips: minStop, ranges, alerts: paper,
    placement: man.placement,
    managed: tallies(man.trades, mid), raw: tallies(raw.trades, mid),
    trades: man.trades,
    ...(params.keepEvents ? { events } : {}),
  };
}
