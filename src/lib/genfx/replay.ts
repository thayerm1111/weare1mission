import { MODES, type Mode, type Row } from "@/lib/genxCompute";
import { CONFIRM_IV } from "@/lib/genxConfirm";
import { hourlyStack, stackAgrees } from "@/lib/genx/trendGate";
import { inWeekendCloseWindow, inScanQuietWindow } from "@/lib/flow/autoExec";
import { type FxPair, U, units } from "@/lib/genfx/pairs";
import { readFromSeries, genfxOf } from "@/lib/genfx/compute";
import { confirmFromCandles, type Candle } from "@/lib/genfx/confirm";
import { decideFxEntry, sameSetupZone, scanKey, zoneKey, zoneOf, zoneAction, zoneBand, throughStop, gradeCandle, ENTRY_FLOOR_RR, ARM_MAX_MS, ZONE_TTL_MS, FORMING_TTL_MS, GRADE_EXPIRY_MS } from "@/lib/genfx/decide";
import { judgeSignal, noiseRoom, slopeFrom15m, fxChoch, fxBreaker, type StopRow } from "@/lib/genfx/guards";

/**
 * GEN FX REPLAY — what would GEN FX have done over real history?
 *
 * GEN FX has no track record: the engine's record is all gold. Before anybody's account takes a
 * trade from it, this runs the WHOLE live pipeline over months of real 5-minute candles — the same
 * functions the live desk calls, not a re-implementation of them:
 *
 *   the engine read, every five minutes, on all three horizons          (compute.readFromSeries)
 *   page setups registered, refreshed, revived and entered on touch     (decide.zoneOf / zoneAction)
 *   scanner setups: heads-up, closed-candle confirmation, arm / enter   (confirm.confirmFromCandles, decide.decideFxEntry)
 *   one call per setup while it is open                                 (decide.sameSetupZone)
 *   the placement guards                                                (guards.judgeSignal)
 *   one trade per pair per side, the desk breaker
 *   the trade manager's break-even and trail for a non-gold position    (simulated here, see `manageBar`)
 *
 * WHAT IT IS HONEST ABOUT.
 *   • No lookahead. At each step the engine sees only candles that had CLOSED by then, plus the price
 *     of that moment; a setup entered INSIDE a candle is judged on what was known before that candle
 *     began. tests/genfx-replay.test.ts cuts the future off and requires the past not to move.
 *   • Costs are charged. Every trade pays `costPips` (spread + commission) — a replay that trades for
 *     free flatters a tight-stop strategy more than anything else.
 *   • The unknown order of events inside one candle is resolved AGAINST the trade: if a candle's range
 *     holds both the stop and the target, it is a loss; a setup entered inside a candle can be stopped
 *     by that candle but not paid by it.
 *   • The managed result is given as TWO numbers, because one would be a guess. When the manager moves
 *     a stop up inside a candle, the candle cannot say whether its low came before or after. `managed`
 *     assumes before (the trade survives unless the candle CLOSES through the stop the manager could
 *     have reached); `managedLow` assumes after, in the worst order the candle allows: price rises
 *     just far enough to lift the stop to the candle's low, then falls to it. `managedLow` is a FLOOR
 *     for what the manager's own rules do, candle by candle — not a forecast. Measured (10-03, the
 *     same rules run tick by tick over a driftless random walk, 6,000 trades at each of two
 *     volatilities): tick by tick came out a little UNDER `managed` — 0.01 to 0.03R a trade — and well
 *     above `managedLow`, by 0.12 to 0.21R. The worst order of events inside every candle does not
 *     happen in every candle. Neither figure is a guarantee: a trade that "survives" a candle can
 *     still end worse later than one that was taken out in it.
 *   • A page setup is entered here whenever a candle's range reaches its level, and an armed setup's
 *     pull-back whenever a candle's range reaches the price worth taking. Live each takes two sightings
 *     of the price a second apart, so a touch that came and went inside a second is a trade here and
 *     not live — and those are the touches that turned. `byTouch` splits those trades into the ones
 *     where the candle went a full unit or more THROUGH the level and the bare touches. Read it for
 *     how many trades rest on a bare touch — NOT as "through is worse": a trade tagged "through" is
 *     one whose entry candle had, by definition, already gone a unit or more against it.
 *   • `byVia` says what turned each call into a trade: a touch of a page setup, the engine saying
 *     trade-ready, a candle confirming a pending setup, or an armed setup's pull-back.
 *   • Two things the live desk does, and GENX does, that the record should be read with:
 *     a page setup stays watched for up to twelve hours after the page last showed it (`byShown`:
 *     "fresh" = the page showed that level at the scan just before the entry; "stale" = it had already
 *     stopped showing it), and a level can be entered again soon after a call on it ended (`byAfter`:
 *     "loss" / "win" = within an hour of a call on the same idea ending that way; "first" = neither).
 *   • It also reports every trade left alone on its original stop and target (`raw`).
 *   • The higher timeframes are cut where the feed cuts them. The live engine reads the feed's own
 *     4-hour, daily and weekly candles, which are not cut at midnight UTC; history.ts measures the
 *     feed's clock from its own candles and the replay builds its candles on that clock.
 *
 * WHAT IT CANNOT KNOW. Fills are assumed at the price of the moment — live fills are worse, most of
 * all around news. Five-minute candles hide what happened inside them: the live watch looks every
 * second and wants a touch on two looks, the replay sees one range per five minutes. And a setting
 * chosen by looking at this history will look better on this history than it will live.
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
  /** The clock the feed cuts its 4-hour, daily and weekly candles on — an IANA zone, or "NY17" for the 5pm New York forex day. Default UTC. */
  zone?: string;
  /** Called whenever the run has held the thread for `yieldEveryMs` (default 12ms). */
  onYield?: () => Promise<void>;
  yieldEveryMs?: number;
  /** Told how far the run has got, at most once a second. */
  onProgress?: (done: number, total: number) => void;
  /** Keep every call that reached placement in the result (the tests compare them; a stored result does not need them). */
  keepEvents?: boolean;
};

const M5 = 5 * 60_000;
const TF_MS: Record<string, number> = { "1min": M5, "5min": M5, "15min": 15 * 60_000, "30min": 30 * 60_000, "1h": 3600_000, "4h": 4 * 3600_000, "1day": 86_400_000, "1week": 7 * 86_400_000 };
const MONDAY = 4 * 86_400_000;     // 1970-01-05 was a Monday
const ZONED = new Set(["4h", "1day", "1week"]);
const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");
const row = (t: number, o: number, h: number, l: number, c: number): Row => ({ datetime: stamp(t), open: String(o), high: String(h), low: String(l), close: String(c) });

/* ── the feed's clock ─────────────────────────────────────────────────────────────────────────── */
const fmts = new Map<string, Intl.DateTimeFormat>();
const offsets = new Map<string, Map<number, number>>();
/**
 * How far a zone's wall clock is ahead of UTC at time `t`, in ms (daylight saving included). "NY17" is
 * the forex day: New York's clock moved on seven hours, so that its midnight falls at 5pm New York.
 */
export function zoneOffsetMs(zone: string | undefined, t: number): number {
  if (!zone || zone === "UTC") return 0;
  const shift = zone === "NY17" ? 7 * 3600_000 : 0;
  const iana = zone === "NY17" ? "America/New_York" : zone;
  let byHour = offsets.get(iana);
  if (!byHour) { byHour = new Map(); offsets.set(iana, byHour); }
  const hk = Math.floor(t / 3600_000);
  let off = byHour.get(hk);
  if (off === undefined) {
    let f = fmts.get(iana);
    if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: iana, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); fmts.set(iana, f); }
    const p: Record<string, number> = {};
    for (const x of f.formatToParts(new Date(hk * 3600_000))) if (x.type !== "literal") p[x.type] = Number(x.value);
    off = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - hk * 3600_000;
    byHour.set(hk, off);
  }
  return off + shift;
}

/** The start of the `tf` candle holding `t`, as a reading of the zone's wall clock (for UTC, the time itself). Weeks start Monday. */
export function bucketStart(tf: string, t: number, zone?: string): number {
  const local = ZONED.has(tf) ? t + zoneOffsetMs(zone, t) : t;
  return tf === "1week" ? Math.floor((local - MONDAY) / TF_MS[tf]) * TF_MS[tf] + MONDAY : Math.floor(local / TF_MS[tf]) * TF_MS[tf];
}

type Series = { rows: Row[]; bars: Candle[]; end: number[] };

/** Build one timeframe from the 5-minute base, on the zone's clock (4-hour and up; shorter frames fall on the same boundaries on every clock). */
export function aggregate(base: Bar[], tf: string, zone?: string): Series {
  const rows: Row[] = [], bars: Candle[] = [], end: number[] = [];
  let cur: { s: number; o: number; h: number; l: number; c: number; last: number } | null = null;
  // A candle ends when the zone's clock reaches the next boundary — in UTC, that boundary less the zone's offset.
  const flush = () => { if (cur) { rows.push(row(cur.s, cur.o, cur.h, cur.l, cur.c)); bars.push({ o: cur.o, h: cur.h, l: cur.l, c: cur.c }); end.push(cur.s + TF_MS[tf] - (ZONED.has(tf) ? zoneOffsetMs(zone, cur.last) : 0)); } };
  for (const b of base) {
    const s = bucketStart(tf, b.t, zone);
    if (!cur || cur.s !== s) { flush(); cur = { s, o: b.o, h: b.h, l: b.l, c: b.c, last: b.t }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.last = b.t; }
  }
  flush();
  return { rows, bars, end };
}

type Read = {
  action: string; state: string; entry: number | null; entry_low: number | null; entry_high: number | null;
  stop_loss: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  closest_support: number | null; closest_resistance: number | null; invalidation_price: number | null;
  entry_profile?: string;
};
type SimAlert = {
  id: number; key: string; mode: Mode; side: "buy" | "sell"; kind: "zone" | "scanner";
  state: "zone" | "forming" | "entered" | "invalidated" | "expired" | "replaced";
  entry: number | null; entry_low: number; entry_high: number; stop: number; tp1: number | null;
  invalidation: number; createdAt: number; lastShown: number; changedAt: number;
  armedAt: number | null; enteredAt: number | null; enterPrice: number | null;
  outcome: "win" | "loss" | "expired" | null; profile: string | null;
};
export type EnterEvent = {
  i: number; at: number; mode: Mode; side: "buy" | "sell"; setup: "zone" | "scanner";
  entryLow: number; entryHigh: number; stop: number; tp: number | null; fill: number;
  /** Entered INSIDE candle i (a touch, or an armed setup's pullback) rather than at its close. */
  intrabar: boolean;
  room: number; slope: number | null; choch: "bullish" | "bearish" | null;
  /** Does the 1-hour EMA 20/50/200 stack agree with the side? (Gold's trend gate — reported, not applied.) */
  trend?: "with" | "against" | "mixed" | null;
  /** The engine's own grade for the setup family: "core" or "aggressive_only". */
  profile?: string | null;
  /** Entries made on a candle's RANGE reaching a price (a page setup's level, an armed setup's pull-back): did the candle go a full unit or more through it ("through"), or only just reach it ("bare")? */
  touch?: "through" | "bare";
  /** Page setups: had the page shown this level at the scan just before the entry ("fresh"), or already stopped showing it ("stale")? */
  shown?: "fresh" | "stale";
  /** Page setups: did a call on the same idea end within the hour before this one — in a "loss", a "win" — or not ("first")? */
  after?: "first" | "win" | "loss";
  /** When the call was first recorded, and what turned it into an entry: a touch of a page setup, the engine saying trade-ready, a candle confirming it, or an armed setup's pull-back. */
  calledAt?: number;
  via?: "touch" | "ready" | "confirm" | "pullback";
};
export type SimTrade = {
  mode: Mode; side: "buy" | "sell"; setup: "zone" | "scanner"; openedAt: number; closedAt: number;
  entry: number; stop: number; tp: number; stopPips: number;
  exit: number; how: "stop" | "target" | "breakeven" | "trail" | "open"; pips: number; r: number;
  trend?: EnterEvent["trend"]; profile?: string | null; touch?: EnterEvent["touch"]; via?: EnterEvent["via"]; shown?: EnterEvent["shown"]; after?: EnterEvent["after"];
};
type Tally = { n: number; wins: number; losses: number; pips: number; r: number; avgStopPips: number; avgR: number; winRate: number; maxDrawdownR: number; byExit: Record<string, number> };
type Tallies = { all: Tally; byMode: Record<string, Tally>; bySetup: Record<string, Tally>; byTrend: Record<string, Tally>; byProfile: Record<string, Tally>; byTouch: Record<string, Tally>; byVia: Record<string, Tally>; byShown: Record<string, Tally>; byAfter: Record<string, Tally>; firstHalf: Tally; secondHalf: Tally };
type Placement = { calls: number; placed: number; skipped: Record<string, number> };
export type ReplayOut = {
  pair: string; from: string; to: string; bars: number; steps: number;
  costPips: number; minStopPips: number; zone: string;
  /** Average candle range, in pips and in this pair's units — the check on pairs.ts `unit`. */
  ranges: Record<string, { pips: number; units: number }>;
  /** What the scanner called, graded on paper (first target or stop first; nobody had to take it). */
  alerts: Record<string, { entered: number; win: number; loss: number; expired: number }>;
  /** Scanner setups recorded (each is a heads-up live), and the ones passed over because a candle had already closed through their invalidation when they were first seen. */
  scanner: { recorded: number; notYet: number };
  /** Calls that reached placement, and why the ones that were not placed were not — in the `managed` run. */
  placement: Placement;
  /** The same for each run. They differ a little: a trade that ends sooner in one run frees its side sooner, and trips the breaker sooner. */
  placements: Record<Run, Placement>;
  /** Run as the live manager would, with every in-candle doubt about a moved stop settled FOR the trade… */
  managed: Tallies;
  /** …and with every such doubt settled AGAINST it, in every candle: a floor, not a forecast. */
  managedLow: Tallies;
  /** Left alone on the original stop and target. */
  raw: Tallies;
  trades: SimTrade[];
  events?: EnterEvent[];
};

const MODE_LIST: Mode[] = ["quick", "intraday", "swing"];

/* ── the trade manager's rules for a non-gold position (flow/flowManage.ts), one candle at a time ── */
const BE_MIN_PIPS = 8, BE_PROFIT_PIPS = 5, PAD_FLOOR_PIPS = 3, GIVEBACK_R = 0.6, GIVEBACK_NEAR_R = 0.25, NEAR_TP_R = 0.4, NEAR_PARTIAL_R = 0.2;

export type Open = {
  ev: EnterEvent; entry: number; stop: number; tp: number; R: number; stopPips: number;
  cur: number; best: number; be: boolean; bePx: number; beTrigger: number; halfway: number;
};
/** How a run treats the stops the manager moves: not at all, with in-candle doubt settled for the trade, or against it. */
export type Run = "raw" | "managed" | "managedLow";
const runOf = (m: boolean | Run): Run => (m === true ? "managed" : m === false ? "raw" : m);

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
 * the stop the candle BEGAN with is checked against the candle's worst price before anything
 * favourable is credited. `entryBar` = the trade was opened inside this candle, so only its stop is
 * checked. `run` = how the manager's own stop moves are treated (a boolean still means managed / raw).
 */
export function manageBar(pair: FxPair, o: Open, b: Bar, run: boolean | Run, entryBar: boolean): { exit: number; how: SimTrade["how"] } | null {
  const mode = runOf(run);
  const low = mode === "managedLow";
  const long = o.ev.side === "buy";
  const adverse = long ? b.l : b.h, favour = long ? b.h : b.l;
  const beyond = (level: number) => (long ? adverse <= level : adverse >= level);
  if (beyond(o.cur)) {
    // A candle that OPENS beyond the stop (the Sunday open, a news gap) fills there, not at the stop:
    // a stop is an order to sell at the market once touched, and the market was already past it.
    const gapped = !entryBar && (long ? b.o < o.cur : b.o > o.cur);
    return { exit: gapped ? b.o : o.cur, how: !o.be ? "stop" : Math.abs(o.cur - o.bePx) < pair.pip / 2 ? "breakeven" : "trail" };
  }
  if (entryBar) return null;
  const twoPips = 2 * pair.pip;
  const beNeed = long ? Math.max(o.beTrigger, o.bePx + twoPips) : Math.min(o.beTrigger, o.bePx - twoPips);
  const beFires = !o.be && (long ? favour >= beNeed : favour <= beNeed);
  // The trail: a stop that ratchets behind the best price, tighter once the move is close to its target.
  const buf = Math.max(o.R * 0.1, twoPips);
  const trailFor = (best: number): number => {
    const peakR = (long ? best - o.entry : o.entry - best) / o.R;
    const toTargetR = (long ? o.tp - best : best - o.tp) / o.R;
    const partialR = (long ? o.halfway - o.entry : o.entry - o.halfway) / o.R;
    const give = (toTargetR <= NEAR_TP_R || peakR >= partialR - NEAR_PARTIAL_R ? GIVEBACK_NEAR_R : GIVEBACK_R) * o.R;
    const want = long ? best - give : best + give;
    return long ? Math.max(want, o.bePx) : Math.min(want, o.bePx);
  };

  const atTarget = long ? favour >= o.tp : favour <= o.tp;
  if (low) {
    // SETTLED AGAINST THE TRADE. Every stop the manager would have moved inside this candle is taken
    // to have been in place before the candle's worst price — and before any target the candle shows.
    // Break-even first: it fired here, and the candle also traded back through the lock.
    if (beFires && beyond(o.bePx)) { o.be = true; o.cur = o.bePx; return { exit: o.bePx, how: "breakeven" }; }
    if (!o.be && !beFires) return atTarget ? { exit: o.tp, how: "target" } : null;
    // Then the trail, at the stop it would have reached at the candle's best price: the manager trails
    // every few seconds and keeps the stop a buffer behind the price of the moment.
    const seen = long ? Math.max(o.best, favour) : Math.min(o.best, favour);
    const best = long ? Math.min(seen, o.tp) : Math.max(seen, o.tp);
    const lifted = trailFor(best);
    const atBest = long ? Math.max(o.bePx, Math.min(lifted, best - buf)) : Math.min(o.bePx, Math.max(lifted, best + buf));
    const from = o.be ? o.cur : o.bePx;
    const step = o.R * 0.05;                              // the manager only moves a stop by more than this
    const moved = long ? atBest > from + step : atBest < from - step;
    o.be = true; o.best = seen; o.cur = moved ? atBest : from;
    // The candle's worst price is inside the range the stop could have been lifted through. The worst
    // order of events: price runs just far enough to bring the stop up to that worst price — never by
    // less than one step — and then falls to it. Out THERE, not at the stop for the candle's best.
    if (moved && beyond(atBest)) return { exit: long ? Math.min(atBest, Math.max(adverse, from + step)) : Math.max(atBest, Math.min(adverse, from - step)), how: "trail" };
    return atTarget ? { exit: o.tp, how: "target" } : null;
  }
  if (atTarget) return { exit: o.tp, how: "target" };
  if (mode === "raw") return null;

  o.best = long ? Math.max(o.best, favour) : Math.min(o.best, favour);
  if (!o.be) {
    // Break-even fires when the market reaches the trigger with price safely beyond the lock.
    if (beFires) {
      o.be = true; o.cur = o.bePx;
      // The candle then closed back through the lock: the lock was hit on the way.
      if (long ? b.c <= o.bePx : b.c >= o.bePx) return { exit: o.bePx, how: "breakeven" };
    }
    return null;
  }
  const lifted = trailFor(o.best);
  // The stop the manager could have reached INSIDE THIS CANDLE: the trail for the best price so far, but
  // never closer than the buffer to the best price this candle itself traded (a stop cannot be set at a
  // price the market was not above). If the candle then closed through it, it was trailed out there.
  const reach = long ? Math.min(lifted, favour - buf) : Math.max(lifted, favour + buf);
  const step = o.R * 0.05;                                // the manager only moves a stop by more than this — so it can only be trailed out at one that far on
  if (long ? (reach > o.cur + step && b.c <= reach) : (reach < o.cur - step && b.c >= reach)) return { exit: reach, how: "trail" };
  const capped = long ? Math.min(lifted, b.c - buf) : Math.max(lifted, b.c + buf);
  if (long ? capped > o.cur + step : capped < o.cur - step) o.cur = capped;
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
function tallies(trades: SimTrade[], midMs: number): Tallies {
  const group = (key: (t: SimTrade) => string | null | undefined) => {
    const out: Record<string, Tally> = {};
    for (const k of [...new Set(trades.map(key))]) if (k) out[k] = tally(trades.filter((t) => key(t) === k));
    return out;
  };
  return {
    all: tally(trades), byMode: group((t) => t.mode), bySetup: group((t) => t.setup), byTrend: group((t) => t.trend), byProfile: group((t) => t.profile), byTouch: group((t) => t.touch),
    byVia: group((t) => t.via), byShown: group((t) => t.shown), byAfter: group((t) => t.after),
    firstHalf: tally(trades.filter((t) => t.openedAt < midMs)), secondHalf: tally(trades.filter((t) => t.openedAt >= midMs)),
  };
}

/** Place and run the entered calls. `run` = raw, managed, or managedLow (a boolean still means managed / raw). */
export function runTrades(pair: FxPair, base: Bar[], events: EnterEvent[], run: boolean | Run, costPips: number, minStopPips: number): { trades: SimTrade[]; placement: ReplayOut["placement"] } {
  const mode = runOf(run);
  const trades: SimTrade[] = [];
  const skipped: Record<string, number> = {};
  const open: Open[] = [];
  const stops: StopRow[] = [];
  let placed = 0, e = 0;
  const close = (o: Open, x: { exit: number; how: SimTrade["how"] }, at: number) => {
    const long = o.ev.side === "buy";
    const gross = (long ? x.exit - o.entry : o.entry - x.exit) / pair.pip;
    const pips = Math.round((gross - costPips) * 10) / 10;
    trades.push({ mode: o.ev.mode, side: o.ev.side, setup: o.ev.setup, openedAt: o.ev.at, closedAt: at, entry: o.entry, stop: o.stop, tp: o.tp, stopPips: o.stopPips, exit: x.exit, how: x.how, pips, r: Math.round((pips / o.stopPips) * 100) / 100, ...(o.ev.trend !== undefined ? { trend: o.ev.trend } : {}), ...(o.ev.profile !== undefined ? { profile: o.ev.profile } : {}), ...(o.ev.touch !== undefined ? { touch: o.ev.touch } : {}), ...(o.ev.via !== undefined ? { via: o.ev.via } : {}), ...(o.ev.shown !== undefined ? { shown: o.ev.shown } : {}), ...(o.ev.after !== undefined ? { after: o.ev.after } : {}) });
    if (x.how === "stop") stops.push({ side: o.ev.side, init_stop: o.stop, resolved_at: new Date(at).toISOString(), result_pips: Math.round(gross), partial_taken: false });
  };
  const tryOpen = (ev: EnterEvent, busyWith: Open[]) => {
    const m = { live: ev.fill, room: ev.room, slope: ev.slope, choch: ev.choch, breakerPaused: fxBreaker(pair, stops, ev.at).paused, minStopPips };
    const v = judgeSignal(pair, { side: ev.side, mode: ev.mode, entryLow: ev.entryLow, entryHigh: ev.entryHigh, stop: ev.stop, tp: ev.tp, setup: ev.setup }, m);
    if (!v.ok) { skipped[v.code] = (skipped[v.code] ?? 0) + 1; return null; }
    if (busyWith.some((o) => o.ev.side === ev.side)) { skipped.one_open = (skipped.one_open ?? 0) + 1; return null; }
    const o = openTrade(pair, ev, v, costPips);
    open.push(o); placed++;
    return o;
  };
  for (let i = 0; i < base.length; i++) {
    const b = base[i], at = b.t + M5;
    // One GEN FX trade per pair per side. A setup entered INSIDE this candle is judged against what was
    // open when the candle began — a trade that closed during it does not free the slot retroactively —
    // and against anything else opened inside this same candle.
    const atStart = [...open];
    const openedHere: Open[] = [];
    for (let k = open.length - 1; k >= 0; k--) {
      const x = manageBar(pair, open[k], b, mode, false);
      if (x) { close(open[k], x, at); open.splice(k, 1); }
    }
    while (e < events.length && events[e].i === i) {
      const ev = events[e++];
      const o = tryOpen(ev, ev.intrabar ? [...atStart, ...openedHere] : open);
      if (!o) continue;
      openedHere.push(o);
      if (ev.intrabar) {
        const x = manageBar(pair, o, b, mode, true);
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
  const zone = params.zone || "UTC";
  const touch = units(pair, U.zoneTouch);
  const confirmBuf = units(pair, U.confirmBuf);

  // Every timeframe any horizon reads, built once from the 5-minute base.
  const tfs = new Set<string>(["5min", "15min", "1h"]);
  for (const m of modes) { const tf = MODES[m].tf; [tf.d1, tf.h1, tf.m30, tf.m15, tf.m5].forEach((x) => tfs.add(x)); tfs.add(CONFIRM_IV[m]); }
  const S = new Map<string, Series>();
  for (const tf of tfs) S.set(tf, aggregate(base, tf, zone));
  const ptr = new Map<string, number>([...tfs].map((tf) => [tf, 0]));

  /** The series a live read would get at time T: the last `n − 1` closed candles, then the one still forming. */
  const liveRows = (tf: string, n: number, T: number, i: number, price: number, realForming: boolean): Row[] => {
    const s = S.get(tf)!, k = ptr.get(tf)!;
    const out = s.rows.slice(Math.max(0, k - (n - 1)), k);
    const start = bucketStart(tf, T, zone);
    let o = price, h = price, l = price;
    if (realForming) { let first = true; for (let j = i; j >= 0 && bucketStart(tf, base[j].t, zone) === start; j--) { h = first ? base[j].h : Math.max(h, base[j].h); l = first ? base[j].l : Math.min(l, base[j].l); o = base[j].o; first = false; } }
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
  const scanner = { recorded: 0, notYet: 0 };
  const yieldEvery = Math.max(1, params.yieldEveryMs ?? 12);
  let lastYield = Date.now(), lastProgress = 0;

  /**
   * What placement would read at this moment. For a setup entered INSIDE candle i, that is the market
   * as it stood when the candle began: candle i itself (and a 15-minute or hourly candle it completes)
   * had not closed when the entry happened.
   */
  const marketAt = (T: number, intrabar: boolean) => {
    const asOf = intrabar ? T - M5 : T;
    const closedBy = (tf: string) => { const s = S.get(tf)!; let k = ptr.get(tf)!; while (k > 0 && s.end[k - 1] > asOf) k--; return k; };
    const k5 = closedBy("5min"), k15 = closedBy("15min"), k1h = closedBy("1h");
    const m5 = S.get("5min")!.bars, m15 = S.get("15min")!.bars, h1 = S.get("1h")!.bars;
    return {
      room: noiseRoom(pair, m5.slice(Math.max(0, k5 - 12), k5)),
      choch: k5 >= 8 ? fxChoch(pair, m5.slice(Math.max(0, k5 - 30), k5)) : null,
      slope: slopeFrom15m(m15.slice(Math.max(0, k15 - 100), k15).map((b) => b.c)),
      stack: hourlyStack(h1.slice(Math.max(0, k1h - 499), k1h).map((b) => b.c))?.stack ?? null,
    };
  };
  /** Page calls that have ended on paper, in time order: what `byAfter` looks back through. */
  const ended: { mode: Mode; side: "buy" | "sell"; entry_low: number; entry_high: number; at: number; outcome: "win" | "loss" }[] = [];
  const AFTER_MS = 60 * 60_000;
  const over = (a: SimAlert, T: number) => { if (a.kind === "zone" && (a.outcome === "win" || a.outcome === "loss")) ended.push({ mode: a.mode, side: a.side, entry_low: a.entry_low, entry_high: a.entry_high, at: T, outcome: a.outcome }); };
  /** `level`: the price the candle's range had to reach for an entry made inside it (an armed setup's pull-back; a page setup's is its own entry). */
  const enter = (a: SimAlert, i: number, T: number, fill: number, intrabar: boolean, b: Bar, via: NonNullable<EnterEvent["via"]>, level?: number) => {
    a.state = "entered"; a.changedAt = T; a.enterPrice = fill;
    // How far past the level the candle went: under one unit is a bare touch.
    const ref = a.kind === "zone" ? a.entry : level ?? null;
    const past = intrabar && ref != null ? (a.side === "sell" ? b.h - ref : ref - b.l) : null;
    // Inside the candle, or at its close: the paper grade treats the candle the entry fell in as one
    // that can stop the call but not pay it (decide.gradeCall), so it needs to know which that was.
    a.enteredAt = intrabar ? b.t + 1 : T;
    paperOf(a).entered++;
    const m = marketAt(T, intrabar);
    let after: EnterEvent["after"];
    if (a.kind === "zone") {
      after = "first";
      for (let k = ended.length - 1; k >= 0 && T - ended[k].at <= AFTER_MS; k--) { const e = ended[k]; if (e.mode === a.mode && sameSetupZone(pair, e, a)) { after = e.outcome; break; } }
    }
    events.push({
      i, at: T, mode: a.mode, side: a.side, setup: a.kind, entryLow: a.entry_low, entryHigh: a.entry_high, stop: a.stop, tp: a.tp1, fill, intrabar,
      room: m.room, slope: a.kind === "scanner" ? m.slope : null, choch: m.choch,
      trend: m.stack == null ? null : m.stack === "mixed" ? "mixed" : stackAgrees(a.side, m.stack) ? "with" : "against", profile: a.profile,
      ...(past != null ? { touch: past >= pair.unit ? ("through" as const) : ("bare" as const) } : {}),
      // The scan runs at each candle's close; an entry inside the next candle is on a level it showed if that was the last scan.
      ...(a.kind === "zone" ? { shown: T - a.lastShown > M5 ? ("stale" as const) : ("fresh" as const), after } : {}),
      calledAt: a.createdAt, via,
    });
    // The candle the entry fell in is graded here, by the live grading's own rule: it can stop the call, not pay it.
    if (intrabar) { const g = gradeCandle({ side: a.side, stop: a.stop, tp1: a.tp1, enterMs: a.enteredAt }, { t: b.t, h: b.h, l: b.l }, M5); if (g) { a.outcome = g; paperOf(a)[g]++; over(a, T); } }
  };
  /** An open scanner call on this horizon and side that is the same setup — pending, or entered and not yet graded. */
  const twinOf = (mode: Mode, z: { side: "buy" | "sell"; entry_low: number; entry_high: number }, excludeId?: number): SimAlert | null => {
    for (const a of open) {
      if (a.id === excludeId || a.kind !== "scanner" || a.mode !== mode || a.outcome) continue;
      if (a.state !== "forming" && a.state !== "entered") continue;
      if (sameSetupZone(pair, a, z)) return a;
    }
    return null;
  };
  const drop = (k: number, a: SimAlert, state: SimAlert["state"], T: number) => { a.state = state; a.changedAt = T; open.splice(k, 1); };

  for (let i = 0; i < base.length; i++) {
    const b = base[i], T = b.t + M5, price = b.c;
    for (const tf of tfs) { const s = S.get(tf)!; let k = ptr.get(tf)!; while (k < s.end.length && s.end[k] <= T) k++; ptr.set(tf, k); }
    if (i < warmup) continue;
    steps++;
    if (params.onYield && Date.now() - lastYield >= yieldEvery) { await params.onYield(); lastYield = Date.now(); }
    if (params.onProgress && Date.now() - lastProgress >= 1000) { params.onProgress(i, base.length); lastProgress = Date.now(); }
    const when = new Date(T);
    const quiet = inWeekendCloseWindow(when) || inScanQuietWindow(when);
    // What happens INSIDE this candle happened while it was open: the live watch looks until the quiet
    // window begins, so the candle that ends as the window opens is still watched. Its START decides.
    const began = new Date(b.t);
    const quietInside = inWeekendCloseWindow(began) || inScanQuietWindow(began);

    for (let k = open.length - 1; k >= 0; k--) {
      const a = open[k];
      // ── paper grade of a call already entered: first target or stop first, stop wins a tie ──
      if (a.state === "entered") {
        const at = a.enteredAt ?? T;
        if (!a.outcome) {
          // A candle that starts after the call ran out of time says nothing about it (scan.gradeEntered).
          a.outcome = b.t >= at + GRADE_EXPIRY_MS[a.mode] ? "expired" : gradeCandle({ side: a.side, stop: a.stop, tp1: a.tp1, enterMs: at }, { t: b.t, h: b.h, l: b.l }, M5);
          if (a.outcome) { paperOf(a)[a.outcome]++; over(a, T); }
        }
        if (a.outcome) open.splice(k, 1);
        continue;
      }
      if (a.createdAt >= T) continue;
      // ── page setup: entered when price touches its entry ──
      if (a.state === "zone") {
        // It lapses twelve hours after it was last shown, and at the daily close: nothing registered
        // before the market shut is acted on after it reopens.
        if (quietInside || T - a.lastShown > ZONE_TTL_MS) { drop(k, a, "expired", T); continue; }
        if (a.entry == null) { if (quiet) drop(k, a, "expired", T); continue; }
        const sell = a.side === "sell";
        const level = sell ? a.entry - touch : a.entry + touch;
        if (sell ? b.o >= a.stop : b.o <= a.stop) { drop(k, a, "invalidated", T); continue; }
        if (sell ? b.h >= level : b.l <= level) enter(a, i, T, sell ? Math.max(b.o, level) : Math.min(b.o, level), true, b, "touch");
        else if (quiet) drop(k, a, "expired", T);            // not touched while the candle was open, and the window has begun: it lapses
        continue;
      }
      // ── pending scanner setup: confirm on closed candles, then enter / arm / drop ──
      if (a.state === "forming") {
        if (T - a.createdAt > FORMING_TTL_MS[a.mode]) { drop(k, a, "expired", T); continue; }
        // A candle that lies wholly inside the quiet window: nobody was looking. The candle that ENDS as
        // the market reopens is different — nothing was watched inside it, but the scan that runs at its
        // close steps every pending setup, as the live one does.
        if (quietInside && quiet) continue;
        const tw = twinOf(a.mode, a, a.id);
        if (tw && (tw.createdAt < a.createdAt || (tw.createdAt === a.createdAt && tw.id < a.id))) { drop(k, a, "invalidated", T); continue; }
        // Armed setups get five minutes. The live watch looks at them on every pass, so one that had not
        // come back by then was let go a second or two later — a full candle before this step.
        if (a.armedAt != null && T - a.armedAt > ARM_MAX_MS) { drop(k, a, "invalidated", T); continue; }
        // Within those five minutes "is the price worth taking yet?" is asked on every pass, so a pullback
        // that came and went INSIDE this candle was taken — at the first price that paid 0.8 to 1 or was
        // back in the zone, whichever the pullback reached first.
        if (!quietInside && a.armedAt != null && a.armedAt < T && a.tp1 != null) {
          const sell = a.side === "sell";
          const cap = (a.tp1 + ENTRY_FLOOR_RR * a.stop) / (1 + ENTRY_FLOOR_RR);
          const zLo = Math.min(a.entry_low, a.entry_high), zHi = Math.max(a.entry_low, a.entry_high);
          const buf = Math.max(confirmBuf, (zHi - zLo) * 0.15);
          // A hair inside the price that pays exactly 0.8 to 1: AT it, whether the sum comes to 0.8 or to
          // 0.79999999 is a matter of floating point, and placement's "is it chased?" would toss a coin.
          const hair = pair.pip * 0.001;
          const takeAt = sell ? Math.min(cap, zLo - buf) + hair : Math.max(cap, zHi + buf) - hair;
          const reached = sell ? b.h >= takeAt : b.l <= takeAt;
          const fill = sell ? Math.max(b.o, takeAt) : Math.min(b.o, takeAt);
          if (reached && !throughStop(fill, a.stop, a.tp1, a.entry_low, a.entry_high)) { enter(a, i, T, fill, true, b, "pullback", takeAt); continue; }
        }
        // At the candle's close the quiet window has begun: no confirmation is read and nothing is entered at the close.
        if (quiet) continue;
        const conf = confirmFromCandles(pair, { side: a.side, zoneLo: a.entry_low, zoneHi: a.entry_high, inv: a.invalidation, candles: liveCandles(CONFIRM_IV[a.mode], 24, T, i, price), live: price });
        const act = decideFxEntry(pair, { armed: a.armedAt != null, confState: conf.state, lp: price, entryLow: a.entry_low, entryHigh: a.entry_high, stop: a.stop, tp1: a.tp1, armedAtMs: a.armedAt ?? T, nowMs: T });
        if (act.do === "arm") a.armedAt = T;
        else if (act.do === "enter") enter(a, i, T, price, false, b, a.armedAt != null ? "pullback" : "confirm");
        else if (act.do === "invalidate") drop(k, a, "invalidated", T);
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

      // The page setup, as scan.registerZone keeps it: a newer one on the horizon and side replaces the
      // older; one still showing is refreshed; one shown again the same day comes back; one entered or
      // broken stays used — today, and for twelve hours across midnight.
      const z = zoneOf(g);
      if (z && zoneAction(pair, z.side, z.entry, z.stop, price) !== "invalidate") {
        const key = zoneKey(pair, mode, z.side, z.entry, T);
        for (let k = open.length - 1; k >= 0; k--) { const a = open[k]; if (a.state === "zone" && a.mode === mode && a.side === z.side && a.key !== key) drop(k, a, "replaced", T); }
        const band = zoneBand(pair, z.entry);
        const have = alerts.get(key);
        const show = (a: SimAlert) => { a.entry = z.entry; a.entry_low = band.low; a.entry_high = band.high; a.stop = z.stop; a.tp1 = z.tp1; a.invalidation = z.stop; a.lastShown = T; };
        // The same setup as a page setup that has been entered and is still running is that trade (scan.registerZone).
        const running = open.some((a) => a.kind === "zone" && a.state === "entered" && !a.outcome && a.mode === mode && a.side === z.side && a.key !== key && sameSetupZone(pair, a, { side: z.side, entry_low: band.low, entry_high: band.high }));
        if (running) { /* used */ }
        else if (have) {
          if (have.state === "zone") show(have);
          else if (have.state === "replaced" || have.state === "expired") { show(have); have.state = "zone"; have.changedAt = T; have.createdAt = T; open.push(have); }
        } else {
          const prev = alerts.get(zoneKey(pair, mode, z.side, z.entry, T - 86_400_000));
          const used = !!prev && (prev.state === "entered" || prev.state === "invalidated") && T - prev.changedAt < ZONE_TTL_MS;
          if (!used) {
            const a: SimAlert = { id: nextId++, key, mode, side: z.side, kind: "zone", state: "zone", entry: z.entry, entry_low: band.low, entry_high: band.high, stop: z.stop, tp1: z.tp1, invalidation: z.stop, createdAt: T, lastShown: T, changedAt: T, armedAt: null, enteredAt: null, enterPrice: null, outcome: null, profile: g.entry_profile ?? null };
            alerts.set(key, a); open.push(a);
          }
        }
      }

      const st = String(g.engine_state || "");
      if ((st !== "TRADE_READY" && st !== "DEVELOPING_SETUP") || g.entry_low == null || g.entry_high == null || g.stop_loss == null) continue;
      const side: "buy" | "sell" = String(g.action).includes("SELL") ? "sell" : "buy";
      const key = scanKey(pair, mode, side, g.entry_low, g.entry_high, T);
      if (alerts.has(key)) continue;
      if (twinOf(mode, { side, entry_low: g.entry_low, entry_high: g.entry_high })) continue;
      const a: SimAlert = { id: nextId++, key, mode, side, kind: "scanner", state: "forming", entry: g.entry, entry_low: g.entry_low, entry_high: g.entry_high, stop: g.stop_loss, tp1: g.tp1, invalidation: g.invalidation_price ?? g.stop_loss, createdAt: T, lastShown: T, changedAt: T, armedAt: null, enteredAt: null, enterPrice: null, outcome: null, profile: g.entry_profile ?? null };
      if (st === "TRADE_READY") { alerts.set(key, a); open.push(a); scanner.recorded++; enter(a, i, T, price, false, b, "ready"); continue; }
      // As the live scan does: its confirmation is read before it is recorded — one that is already
      // invalid is not a call — and one that is recorded is acted on at once, on the candle that has
      // just closed, not a candle later.
      const conf = confirmFromCandles(pair, { side, zoneLo: a.entry_low, zoneHi: a.entry_high, inv: a.invalidation, candles: liveCandles(CONFIRM_IV[mode], 24, T, i, price), live: price });
      if (conf.state === "INVALIDATED") { scanner.notYet++; continue; }
      alerts.set(key, a); open.push(a); scanner.recorded++;
      const act = decideFxEntry(pair, { armed: false, confState: conf.state, lp: price, entryLow: a.entry_low, entryHigh: a.entry_high, stop: a.stop, tp1: a.tp1, armedAtMs: T, nowMs: T });
      if (act.do === "arm") a.armedAt = T;
      else if (act.do === "enter") enter(a, i, T, price, false, b, "confirm");
    }
  }

  events.sort((x, y) => x.i - y.i || Number(y.intrabar) - Number(x.intrabar));
  const first = base[Math.min(warmup, base.length - 1)], last = base[base.length - 1];
  const mid = (first.t + last.t) / 2;
  const man = runTrades(pair, base, events, "managed", costPips, minStop);
  const low = runTrades(pair, base, events, "managedLow", costPips, minStop);
  const raw = runTrades(pair, base, events, "raw", costPips, minStop);

  const ranges: ReplayOut["ranges"] = {};
  for (const tf of ["5min", "15min", "1h", "1day"]) {
    const s = S.get(tf) ?? aggregate(base, tf, zone);
    const avg = s.bars.length ? s.bars.reduce((n, x) => n + (x.h - x.l), 0) / s.bars.length : 0;
    ranges[tf] = { pips: Math.round((avg / pair.pip) * 10) / 10, units: Math.round((avg / pair.unit) * 100) / 100 };
  }

  return {
    pair: pair.key, from: new Date(first.t).toISOString(), to: new Date(last.t + M5).toISOString(), bars: base.length, steps,
    costPips, minStopPips: minStop, zone, ranges, alerts: paper, scanner,
    placement: man.placement,
    placements: { managed: man.placement, managedLow: low.placement, raw: raw.placement },
    managed: tallies(man.trades, mid), managedLow: tallies(low.trades, mid), raw: tallies(raw.trades, mid),
    trades: man.trades,
    ...(params.keepEvents ? { events } : {}),
  };
}
