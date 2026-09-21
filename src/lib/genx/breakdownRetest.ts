/**
 * BREAKDOWN-RETEST SELLS (owner 09-21: "add the breakdown retest sells with limits").
 *
 * The night of 09-20/21 gold ground down from 4384 to 4352 without ever pulling back to the resistance
 * GENX was waiting to sell, so it called nothing. This adds the one pattern that catches that tape:
 *
 *   1. SUPPORT   a 5-minute swing low that price had bounced from (a real level, ≥ 1 ATR bounce)
 *   2. BREAK     a 5-minute close ≥ 0.3 ATR below it, ACCEPTED by the next close also below it
 *   3. AWAY      price pushes ≥ 0.8 ATR lower — the break displaced, it wasn't a wick
 *   4. RETEST    the FIRST time price comes back up to the level, the bar that tags it closes back
 *                below and rejects (bearish body or a long upper wick) — the old floor is now a ceiling
 *   5. HOLD      no close back above the level since the break (a failed breakdown is not a retest)
 *
 * Entry at the rejection close, stop just above the retest high ($4 minimum, $9 maximum — if the
 * structure needs more than $9 the call is skipped, never widened), TP1 at 1.6R.
 *
 * LIMITS — this is the pattern that chases, so it is fenced in:
 *   • only when GENX's own read is bearish (sells with the trend, never against it)
 *   • at most 2 per session and 3 per trading day; one call per level, ever
 *   • after a breakdown-retest loss, none for the rest of that session
 *   • never while another GENX gold call is still open
 *   • never inside the desk loss breaker, the news blackout, the daily reopen or the weekend close
 *   • marked quality_ok = false, so CONSERVATIVE accounts never take it; each account's own risk %
 *     sizes it exactly as any other call (nothing here raises anyone's risk)
 *   • kill switch: GENX_BREAKDOWN_RETEST=off
 *
 * This is a rule set, not a promise: it is new, it is unproven, and it will have losing days.
 */

export type Bar = { t: string; o: number; h: number; l: number; c: number };

export type BreakdownRetest = {
  level: number;       // the broken support, now resistance
  entry: number;       // the rejection bar's close
  stop: number;
  tp1: number;
  tp2: number;
  risk: number;
  atr: number;
  breakAt: string;
  retestAt: string;
  why: string;
};

export const BRK = {
  minBars: 60,
  pivotK: 3,                 // bars each side for a swing low
  lookback: 120,             // 10 hours of 5-minute bars
  bounceAtr: 1.0,            // the level must have held once
  breakAtr: 0.3,             // close this far below = a break
  breakWithin: 30,           // break in the last 2.5 hours
  displaceAtr: 0.8,          // price must push this far below after the break
  retestNearAtr: 0.25,       // the retest high must reach level − this…
  retestOverAtr: 0.5,        // …and not exceed level + this
  failCloseAtr: 0.25,        // a close this far above the level since the break = failed breakdown
  stopPadAtr: 0.3,
  minStop: 4,                // dollars — the desk noise floor
  maxStop: 9,                // dollars — beyond this the call is skipped, never widened
  tp1R: 1.6,
  tp2R: 2.6,
  perSession: 2,
  perDay: 3,
};

function atrOf(b: Bar[], n = 14): number {
  const tr: number[] = [];
  for (let i = Math.max(1, b.length - n); i < b.length; i++) {
    const p = b[i - 1].c;
    tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - p), Math.abs(b[i].l - p)));
  }
  return tr.length ? tr.reduce((a, x) => a + x, 0) / tr.length : 0;
}

/** Pure: does the LAST CLOSED bar complete a breakdown-retest sell? `bars` = closed 5m bars, oldest first. */
export function detectBreakdownRetest(bars: Bar[]): { ok: true; setup: BreakdownRetest } | { ok: false; reason: string } {
  const n = bars.length;
  if (n < BRK.minBars) return { ok: false, reason: "not_enough_bars" };
  const atr = atrOf(bars);
  if (!(atr > 0)) return { ok: false, reason: "no_atr" };
  const r = n - 1; // the bar that must be the retest
  const K = BRK.pivotK;

  // swing lows, most recent first
  const pivots: number[] = [];
  for (let i = Math.max(K, n - BRK.lookback); i < n - K - 1; i++) {
    let low = true;
    for (let j = 1; j <= K && low; j++) if (!(bars[i].l <= bars[i - j].l && bars[i].l <= bars[i + j].l)) low = false;
    if (low) pivots.push(i);
  }
  pivots.reverse();

  let lastReason = "no_broken_support";
  for (const p of pivots) {
    const level = bars[p].l;
    // the first decisive close below it
    let b = -1;
    for (let i = p + K; i < r; i++) if (bars[i].c < level - BRK.breakAtr * atr) { b = i; break; }
    if (b < 0) continue;
    // it was support: price bounced ≥ 1 ATR off it before breaking
    let bounce = -Infinity;
    for (let i = p + 1; i < b; i++) bounce = Math.max(bounce, bars[i].h);
    if (!(bounce >= level + BRK.bounceAtr * atr)) { lastReason = "level_never_held"; continue; }
    if (b < r - BRK.breakWithin) { lastReason = "break_too_old"; continue; }
    if (!(b + 1 < r && bars[b + 1].c < level)) { lastReason = "break_not_accepted"; continue; }
    if (r - b < 3) { lastReason = "retest_too_soon"; continue; }
    // no close back above the level since the break (before the retest bar)
    let failed = false, firstTouch = true, lowAfter = Infinity;
    for (let i = b; i < r; i++) {
      if (bars[i].c > level + BRK.failCloseAtr * atr) failed = true;
      if (i >= b + 2 && bars[i].h >= level - BRK.retestNearAtr * atr) firstTouch = false;
      lowAfter = Math.min(lowAfter, bars[i].l);
    }
    if (failed) { lastReason = "failed_breakdown"; continue; }
    if (!(lowAfter <= level - BRK.displaceAtr * atr)) { lastReason = "no_displacement"; continue; }
    if (!firstTouch) { lastReason = "not_first_retest"; continue; }
    // the retest bar itself
    const x = bars[r];
    if (!(x.h >= level - BRK.retestNearAtr * atr)) return { ok: false, reason: "waiting_for_retest" };
    if (x.h > level + BRK.retestOverAtr * atr) return { ok: false, reason: "retest_overshot" };
    if (!(x.c < level - 0.05 * atr)) return { ok: false, reason: "retest_closed_above" };
    const range = x.h - x.l;
    const upperWick = x.h - Math.max(x.o, x.c);
    if (!(x.c < x.o || (range > 0 && upperWick >= 0.5 * range))) return { ok: false, reason: "no_rejection" };

    const entry = x.c;
    let stop = Math.max(x.h, level) + Math.max(BRK.stopPadAtr * atr, 0.8);
    if (stop - entry < BRK.minStop) stop = entry + BRK.minStop;
    const risk = stop - entry;
    if (risk > BRK.maxStop) return { ok: false, reason: `stop_too_wide_${risk.toFixed(2)}` };
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
      ok: true,
      setup: {
        level: r2(level), entry: r2(entry), stop: r2(stop), tp1: r2(entry - BRK.tp1R * risk), tp2: r2(entry - BRK.tp2R * risk),
        risk: r2(risk), atr: r2(atr), breakAt: bars[b].t, retestAt: x.t,
        why: `Support ${level.toFixed(2)} broke at ${bars[b].t}, price pushed to ${lowAfter.toFixed(2)}, and the first retest rejected.`,
      },
    };
  }
  return { ok: false, reason: lastReason };
}

/** Pure: the limits, given what has already been called. `calls` = earlier breakdown-retest alerts. */
export function breakdownLimits(
  calls: { createdAt: string; session: string; outcome: string | null }[],
  now: { session: string; dayStartMs: number },
): { ok: true } | { ok: false; reason: string } {
  const today = calls.filter((c) => Date.parse(c.createdAt) >= now.dayStartMs);
  if (today.length >= BRK.perDay) return { ok: false, reason: "daily_limit" };
  const session = today.filter((c) => c.session === now.session);
  if (session.length >= BRK.perSession) return { ok: false, reason: "session_limit" };
  if (session.some((c) => c.outcome === "loss")) return { ok: false, reason: "session_loss_stop" };
  return { ok: true };
}

/** 5 pm New York — the start of gold's trading day — as epoch ms. */
export function tradingDayStart(d = new Date()): number {
  const ny = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const start = new Date(ny);
  start.setHours(17, 0, 0, 0);
  if (ny.getHours() < 17) start.setDate(start.getDate() - 1);
  return d.getTime() - (ny.getTime() - start.getTime());
}
