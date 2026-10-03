import { type Mode } from "@/lib/genxCompute";
import { type FxPair, U, units, px } from "@/lib/genfx/pairs";

/**
 * GEN FX — THE PURE DECISIONS. Each of these is GENX's rule (the file it came from is named beside
 * it), with gold's dollars turned into the pair's units and nothing else changed. No database, no
 * network: the scanner, the fast watch and the replay all call the same functions, and
 * tests/genfx-decide.test.ts checks them against GENX's own on gold's numbers.
 */

/** Reward ÷ risk at a price. Null when a level is missing or the stop is not behind the price. */
export function rewardRisk(entry: number | null, stop: number | null, tp: number | null): number | null {
  if (entry == null || stop == null || tp == null) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return Math.abs(tp - entry) / risk;
}

// ── watchTick.decideGoldEntry ────────────────────────────────────────────────────────────────────
export const ENTRY_FLOOR_RR = 0.8;        // take the trade at 0.8:1 or better; below it, wait for a pullback
export const ARM_MAX_MS = 5 * 60_000;     // wait five minutes for that pullback, then let it go

/** Is `lp` at or beyond the stop for a trade this way? The side is read from where the target sits. */
export function throughStop(lp: number | null, stop: number | null, tp1: number | null, entryLow: number | null, entryHigh: number | null): boolean {
  if (lp == null || stop == null) return false;
  const ref = tp1 ?? (entryLow != null && entryHigh != null ? (Number(entryLow) + Number(entryHigh)) / 2 : entryLow ?? entryHigh);
  if (ref == null || ref === stop) return false;
  return ref > stop ? lp <= stop : lp >= stop;          // a buy's stop is below it, a sell's above
}

/**
 * Enter now, arm and wait for a pullback, abandon, or keep waiting. `armed` = already announced once.
 *
 * TWO DIFFERENCES FROM GENX, on purpose.
 *   • Reward ÷ risk is measured with absolute distances, so a price that has gone THROUGH the stop
 *     reads as a tiny risk and a huge reward — "10 to 1, take it" — and GENX's rule enters. Gold's
 *     placement refuses that order a step later, so no trade is lost there, but the call itself is
 *     recorded as entered at a price beyond its own stop. Here a price at or through the stop is never
 *     an entry: the setup waits (a candle closing beyond its invalidation ends it).
 *   • An armed setup's five minutes are five minutes. GENX asks "is the price worth taking?" before it
 *     asks "has the time run out?", which is the same thing while a watch looks every second — and is
 *     not after a gap: a setup armed at 4:12pm New York, frozen through the daily close, would be
 *     entered at 7pm on the first price that qualified. Here the clock is asked first.
 */
export function decideFxEntry(pair: FxPair, o: {
  armed: boolean; confState: string; lp: number | null;
  entryLow: number | null; entryHigh: number | null; stop: number | null; tp1: number | null;
  armedAtMs: number; nowMs: number;
}): { do: "enter" | "arm" | "invalidate" | "wait"; reason: string } {
  if (o.confState === "INVALIDATED") return { do: "invalidate", reason: "invalidated" };
  // (Written so that an arming time nobody can read — NaN — counts as expired, not as "never expires".)
  if (o.armed && !(o.nowMs - o.armedAtMs <= ARM_MAX_MS)) return { do: "invalidate", reason: "arm_expired_5min" };
  if (throughStop(o.lp, o.stop, o.tp1, o.entryLow, o.entryHigh)) return { do: "wait", reason: "through_stop" };
  const rr = rewardRisk(o.lp, o.stop, o.tp1);
  const zLo = Math.min(Number(o.entryLow), Number(o.entryHigh));
  const zHi = Math.max(Number(o.entryLow), Number(o.entryHigh));
  const floor = units(pair, U.confirmBuf);
  const buf = Number.isFinite(zHi - zLo) ? Math.max(floor, (zHi - zLo) * 0.15) : floor;
  const inZone = o.lp != null && Number.isFinite(zLo) && o.lp >= zLo - buf && o.lp <= zHi + buf;
  const takeable = inZone || (rr != null && rr >= ENTRY_FLOOR_RR);
  if (!o.armed) {
    if (o.confState !== "CONFIRMED") return { do: "wait", reason: "pending:" + o.confState };
    if (takeable) return { do: "enter", reason: "confirmed_rr_ok" };
    return { do: "arm", reason: "chased_below_floor" };
  }
  if (takeable) return { do: "enter", reason: "pullback_to_entry" };
  return { do: "wait", reason: "armed_waiting" };
}

// ── watchTick.sameSetupZone ──────────────────────────────────────────────────────────────────────
/** GENX's window for calling a drifted Quick zone the same setup. Kept as the number; see scan.findSameSetup for how GEN FX applies the rule. */
export const SAME_SETUP_WINDOW_MS = 4 * 3600_000;
type ZoneLike = { side: "buy" | "sell"; entry_low: number | null; entry_high: number | null };

/** The engine re-derives a zone every scan and it drifts; a zone this close on the same side is the same setup. */
export function sameSetupZone(pair: FxPair, a: ZoneLike, b: ZoneLike): boolean {
  if (a.side !== b.side || a.entry_low == null || a.entry_high == null || b.entry_low == null || b.entry_high == null) return false;
  const mid = (z: ZoneLike) => (Number(z.entry_low) + Number(z.entry_high)) / 2;
  const width = Math.max(Math.abs(Number(a.entry_high) - Number(a.entry_low)), Math.abs(Number(b.entry_high) - Number(b.entry_low)));
  return Math.abs(mid(a) - mid(b)) <= Math.max(units(pair, U.sameSetup), 1.5 * width);
}

/**
 * ONE IDEA, COUNTED ONCE. A page setup and a scanner setup are two routes to the same trade: the page
 * shows a level and it is entered on touch, and the scanner confirms the same zone a few minutes later.
 * Both are recorded — each is a call members could have acted on — and both are graded against the same
 * stop and target, so a record that adds them up counts one move twice. A call entered WHILE an earlier
 * call on the same pair, horizon, side and setup was still running is that idea again: the earlier one
 * is the one counted. A call made after the earlier one had finished is a new trade, and is counted.
 * (The same-setup rules in the scanner already keep two page calls, or two scanner calls, from running
 * together; this is the pair of them.) Returns the calls to count, and how many were repeats. Pure.
 */
export function oneCallPerIdea<T extends { mode: string; side: "buy" | "sell"; entry_low: number | null; entry_high: number | null; enter_sent_at: string | null; resolved_at: string | null }>(pair: FxPair, calls: T[]): { counted: T[]; repeats: number } {
  const at = (s: string | null) => (s ? Date.parse(s) : NaN);
  const sorted = [...calls].sort((a, b) => (at(a.enter_sent_at) || 0) - (at(b.enter_sent_at) || 0));
  const counted: T[] = [];
  let repeats = 0;
  for (const c of sorted) {
    const t = at(c.enter_sent_at);
    const twin = Number.isFinite(t) && counted.some((k) => {
      const from = at(k.enter_sent_at), to = at(k.resolved_at);
      return k.mode === c.mode && Number.isFinite(from) && Number.isFinite(to) && from <= t && t < to && sameSetupZone(pair, k, c);
    });
    if (twin) repeats++; else counted.push(c);
  }
  return { counted, repeats };
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────
// GENX keys a scanner setup "quick:sell:4357:4359" — the zone rounded to the dollar — and a page
// setup "zone:quick:sell:4348.2" — the entry rounded to ten cents. A dollar is one unit and ten
// cents a tenth of one, so here both are whole numbers of those steps, with the pair in front.
// The mode stays the SECOND segment of a scanner key and the pair the FIRST, so neither can be
// mistaken for a gold key ("quick:…") by anything that reads both tables.
//
// ONE DIFFERENCE FROM GENX, on purpose: the key ends with the UTC day. A key is unique forever in
// the alerts table, so gold's undated key means a zone that was called once can never be called
// again at the same level, however many weeks later price returns to it — its "expired" row is
// still in the way. Currency pairs revisit round levels constantly. Dated, the same level can be
// called again on another day; within a day the unique key still makes a call impossible to announce
// or place twice, and the same-setup check (above) carries a setup across midnight.
const steps = (pair: FxPair, price: number, u: number) => Math.round(price / units(pair, u));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
export const scanKey = (pair: FxPair, mode: Mode, side: "buy" | "sell", entryLow: number, entryHigh: number, nowMs: number): string =>
  `${pair.key}:${mode}:${side}:${steps(pair, entryLow, U.dedupe)}:${steps(pair, entryHigh, U.dedupe)}:${day(nowMs)}`;
export const zoneKey = (pair: FxPair, mode: Mode, side: "buy" | "sell", entry: number, nowMs: number): string =>
  `zone:${pair.key}:${mode}:${side}:${steps(pair, entry, U.zoneKey)}:${day(nowMs)}`;
export const isZoneKey = (k: string) => k.startsWith("zone:");

// ── zoneSetups.zoneOf / zoneAction ───────────────────────────────────────────────────────────────
type Read = { action?: unknown; entry?: unknown; stop_loss?: unknown; tp1?: unknown; tp2?: unknown; tp3?: unknown };
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export type Zone = { side: "buy" | "sell"; entry: number; stop: number; tp1: number; tp2: number | null; tp3: number | null };

/** The page setup a read is showing — a WAIT-for-trigger or a LIMIT at a level — or null. */
export function zoneOf(g: Read): Zone | null {
  const a = String(g.action ?? "").toUpperCase();
  const side = /^WAIT_FOR_BUY_TRIGGER$|^BUY_LIMIT$/.test(a) ? "buy" : /^WAIT_FOR_SELL_TRIGGER$|^SELL_LIMIT$/.test(a) ? "sell" : null;
  const entry = n(g.entry), stop = n(g.stop_loss), tp1 = n(g.tp1);
  if (!side || entry == null || stop == null || tp1 == null) return null;
  if (side === "sell" ? !(stop > entry && entry > tp1) : !(stop < entry && entry < tp1)) return null;
  return { side, entry, stop, tp1, tp2: n(g.tp2), tp3: n(g.tp3) };
}

/** What to do with a registered setup at live price `lp`: enter on touch, drop through the stop, else wait. */
export function zoneAction(pair: FxPair, side: "buy" | "sell", entry: number, stop: number, lp: number): "enter" | "invalidate" | "wait" {
  const touch = units(pair, U.zoneTouch);
  if (side === "sell") { if (lp >= stop) return "invalidate"; return lp >= entry - touch ? "enter" : "wait"; }
  if (lp <= stop) return "invalidate";
  return lp <= entry + touch ? "enter" : "wait";
}

/** The band a page setup is stored with: the entry, a touch either side. */
export function zoneBand(pair: FxPair, entry: number): { low: number; high: number } {
  const touch = units(pair, U.zoneTouch);
  return { low: px(pair, entry - touch), high: px(pair, entry + touch) };
}
export const ZONE_TTL_MS = 12 * 3600_000;

// ── the life of a call on paper ──────────────────────────────────────────────────────────────────
/** A pending scanner setup that has not confirmed in this long is let go (gold's windows). */
export const FORMING_TTL_MS: Record<Mode, number> = { quick: 8 * 3600_000, intraday: 8 * 3600_000, swing: 48 * 3600_000 };
/**
 * An entered call that has reached neither its target nor its stop in this long is closed as
 * "expired" — no result. GENX uses eight hours for every horizon, which fits a trade meant to last
 * twenty minutes and cuts off one meant to last two days before it has done anything; here each
 * horizon gets a window that fits how long it is meant to be held.
 */
export const GRADE_EXPIRY_MS: Record<Mode, number> = { quick: 8 * 3600_000, intraday: 24 * 3600_000, swing: 96 * 3600_000 };

export type GradeCandle = { t: number; h: number; l: number };   // t = the candle's START, ms UTC

/**
 * One candle past an entered call: "loss", "win", or null (nothing yet). The live grading and the
 * replay both grade with this, so the two records are kept by one rule. Two things a candle cannot
 * show are settled against the call:
 *   • a candle that holds both the stop and the target is a loss;
 *   • the candle the entry happened INSIDE can stop the call but cannot pay it — its range includes
 *     whatever price did before the entry.
 * A candle that had closed by the entry says nothing. Pure.
 */
export function gradeCandle(a: { side: "buy" | "sell"; stop: number; tp1: number | null; enterMs: number }, c: GradeCandle, ivMs: number): "win" | "loss" | null {
  if (!(c.t + ivMs > a.enterMs)) return null;           // closed at or before the entry
  const sell = a.side === "sell";
  if (sell ? c.h >= a.stop : c.l <= a.stop) return "loss";
  const entryCandle = c.t <= a.enterMs;
  if (!entryCandle && a.tp1 != null && (sell ? c.l <= a.tp1 : c.h >= a.tp1)) return "win";
  return null;
}

/**
 * Grade an entered call against the candles since, in time order whatever order they arrive in.
 *   `closedByMs`  only candles that had CLOSED by then are read. The feed's newest candle is still
 *                 forming, and a forming candle that has touched the target can still go on to touch
 *                 the stop — which, in one candle, is a loss.
 *   `untilMs`     candles that START at or after this say nothing: the call had run out of time. It
 *                 is how a call nobody graded for a while is graded as it would have been on time.
 * Pure.
 */
export function gradeCall(a: { side: "buy" | "sell"; stop: number; tp1: number; enterMs: number }, candles: GradeCandle[], ivMs: number, o: { closedByMs?: number; untilMs?: number } = {}): { result: "win" | "loss"; at: number } | null {
  for (const c of [...candles].sort((x, y) => x.t - y.t)) {
    if (o.untilMs != null && c.t >= o.untilMs) break;
    if (o.closedByMs != null && c.t + ivMs > o.closedByMs) break;
    const result = gradeCandle(a, c, ivMs);
    if (result) return { result, at: c.t + ivMs };
  }
  return null;
}

/**
 * When entries last reopened: the end of the most recent quiet window (the daily close, the weekend),
 * to five minutes. A page setup registered before it describes a market that has since been shut and
 * reopened — on a Sunday, with a gap — so the watch does not act on one until a scan has shown it
 * again. Pure, given the desk's own "is it quiet?" rule.
 */
export function lastReopenMs(nowMs: number, quiet: (d: Date) => boolean): number {
  const STEP = 5 * 60_000;
  let t = Math.floor(nowMs / STEP) * STEP;
  for (let i = 0; i < 12 * 24 * 5; i++, t -= STEP) if (quiet(new Date(t))) return t + STEP;
  return 0;
}

// ── genxConservativeGate is imported where it is used; it has no gold numbers in it. ──
