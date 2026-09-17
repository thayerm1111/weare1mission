/**
 * PROFIT GUARD (owner 09-17: "if the target was 300 pips and it made 220 then reversed, why not secure
 * 100-150 instead of riding it back to break-even?").
 *
 * While a managed trade is genuinely in profit and gold's 5-min structure flips AGAINST it (the same
 * change-of-character read that blocks entries against a reversal), the stop snaps to just behind the
 * market instead of sitting 0.6R behind the peak. The trade still runs — if the flip was noise and price
 * pushes on, the trade keeps going; if the reversal is real, the member keeps most of the move.
 *
 * Owner's choices: snap the stop (never a market close), only once profit >= max(1R, 50 pips), and OPT-IN
 * per account (profit_guard, default off).
 *
 * Hard rules: the stop only ever TIGHTENS, never moves through the market (the broker would reject it),
 * and never lands worse than break-even + the usual lock.
 */
export const GUARD_MIN_PIPS = 50;       // gold pips of open profit required (with >= 1R)
export const GUARD_MIN_R = 1.0;
export const GUARD_BEHIND_PIPS = 12;    // how far behind the market the snapped stop sits

export type GuardInput = {
  side: string;                 // "buy" | "sell"
  entry: number; price: number; R: number; pip: number;
  curStop: number | null; bePx: number;
  choch: "bullish" | "bearish" | null;
  spread?: number | null;
};

/** The snapped stop for a reversal, or null when the guard shouldn't act. Pure (unit-tested). */
export function profitGuardPlan(i: GuardInput): { stop: number; profitPips: number } | null {
  const long = String(i.side).toLowerCase() === "buy";
  if (!(i.entry > 0 && i.price > 0 && i.R > 0 && i.pip > 0)) return null;
  const against = long ? "bearish" : "bullish";
  if (i.choch !== against) return null;                                  // no flip against this trade
  const profit = long ? i.price - i.entry : i.entry - i.price;
  const profitPips = Math.round(profit / i.pip);
  if (profitPips < GUARD_MIN_PIPS || profit < GUARD_MIN_R * i.R) return null;
  const pad = Math.max(GUARD_BEHIND_PIPS * i.pip, (i.spread ?? 0) * 2);  // keep clear of the spread
  let stop = long ? i.price - pad : i.price + pad;
  stop = long ? Math.max(stop, i.bePx) : Math.min(stop, i.bePx);         // never worse than break-even
  const cur = i.curStop;
  const improved = cur == null || (long ? stop > cur + i.pip : stop < cur - i.pip);
  if (!improved) return null;                                            // already at least this tight
  return { stop: +stop.toFixed(2), profitPips };
}
