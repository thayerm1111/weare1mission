/**
 * RANGE GUARD + DESK BREAKER (owner 09-18, after five straight stop-outs inside one overnight range:
 * "something needs to be fixed — the AI is trading the wrong way every time now").
 *
 * What actually happened, from the desk record:
 *   23:40 SELL @4344 → stop  (sold into the BOTTOM of a 4341–4380 range)
 *   02:40 BUY  @4351 → stop  (bought the middle, no room either way)
 *   03:30 SELL @4345 → stop  (sold the bottom AGAIN)
 * Each one passed its own checks: real structure on the 5-minute, a confirmed close, reward past the
 * minimum. What none of them asked was "where in the day's range am I doing this?" — a short at the low
 * of a range and a long at the high are the two trades a range punishes every time.
 *
 * Two pure rules, both unit-tested against those exact fires:
 *   1. RANGE POSITION — refuse a SELL in the bottom quarter of the recent range, and a BUY in the top
 *      quarter. Breakouts are unaffected: once price closes clear of the box, the box is stale and the
 *      guard steps aside (that is the PDH/PDL module's job, not this one).
 *   2. DESK BREAKER — after N real stop-outs inside a window, pause NEW entries for a cooling period.
 *      The market is telling the desk its read is wrong; the answer is to stop paying to find out again.
 */
export type Bar = { h: number; l: number; c: number };

export const RANGE_EDGE = 0.25;        // bottom/top quarter of the box
export const RANGE_MIN_BARS = 12;
export const RANGE_MIN_WIDTH = 8;      // $8 — below this the "range" is noise, not structure
export const BREAK_CLEAR = 0.15;       // a close this far beyond the box (as a share of width) = breakout

/** Where price sits in the recent range: 0 = at the low, 1 = at the high. null = no usable box. */
export function rangePosition(bars: Bar[], price: number): { pos: number; high: number; low: number; width: number } | null {
  if (!Array.isArray(bars) || bars.length < RANGE_MIN_BARS || !(price > 0)) return null;
  const high = Math.max(...bars.map((b) => b.h));
  const low = Math.min(...bars.map((b) => b.l));
  const width = high - low;
  if (!(width >= RANGE_MIN_WIDTH)) return null;
  // A genuine breakout invalidates the box — don't hold a breakout trade to range rules.
  if (price > high + width * BREAK_CLEAR || price < low - width * BREAK_CLEAR) return null;
  return { pos: Math.max(0, Math.min(1, (price - low) / width)), high, low, width };
}

/** The guard itself: true = don't take this entry. Pure. */
export function blockedByRange(side: string, r: { pos: number; high: number; low: number } | null): { blocked: boolean; reason: string } {
  if (!r) return { blocked: false, reason: "" };
  const long = String(side).toLowerCase() === "buy";
  const pct = Math.round(r.pos * 100);
  if (!long && r.pos <= RANGE_EDGE) {
    return { blocked: true, reason: `Range guard: price is only ${pct}% up the ${r.low.toFixed(2)}–${r.high.toFixed(2)} range — selling into the floor of a range is the trade that keeps stopping out. Waiting for a break of the low, or a rally back toward the top.` };
  }
  if (long && r.pos >= 1 - RANGE_EDGE) {
    return { blocked: true, reason: `Range guard: price is already ${pct}% up the ${r.low.toFixed(2)}–${r.high.toFixed(2)} range — buying into the ceiling of a range is the trade that keeps stopping out. Waiting for a break of the high, or a pullback toward the bottom.` };
  }
  return { blocked: false, reason: "" };
}

export const BREAKER_LOSSES = 3;
export const BREAKER_WINDOW_MS = 6 * 3600_000;
export const BREAKER_PAUSE_MS = 4 * 3600_000;

/** Desk breaker: given recent stop-out times, should new entries be paused (and until when)? Pure. */
export function deskBreaker(stopTimes: number[], now = Date.now(), losses = BREAKER_LOSSES): { paused: boolean; until: number; count: number } {
  const recent = stopTimes.filter((t) => now - t <= BREAKER_WINDOW_MS).sort((a, b) => b - a);
  if (recent.length < losses) return { paused: false, until: 0, count: recent.length };
  const until = recent[0] + BREAKER_PAUSE_MS;     // cool off from the MOST RECENT loss, not the first
  return { paused: now < until, until, count: recent.length };
}
