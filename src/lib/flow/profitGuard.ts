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
/*
 * 09-22 (owner, on the 10:05 CT BUY: ran +101 pips, changed character, rode back to a loss). Two holes:
 *   1. The guard qualified on CURRENT profit (>= 1R AND 50 pips) at the moment the 5m flip confirmed.
 *      A flip only confirms after price has already come off the top, so a 106-pip-risk trade that
 *      peaked at +101 (0.95R) could never qualify. It now qualifies on the trade's PEAK (>= 50 pips),
 *      and snaps behind the market — never worse than break-even — even if some of the move is gone.
 *   2. No lock at all without a flip. Now once the peak reaches 100 pips, the stop locks at least 40% of
 *      the peak (101 → +40 pips), flip or not. Still opt-in (profit_guard), still only tightens.
 */
export const GUARD_MIN_PIPS = 50;       // peak gold pips before a flip can snap the stop
export const GUARD_BEHIND_PIPS = 12;    // how far behind the market the snapped stop sits
export const LOCK_TRIGGER_PIPS = 100;   // peak pips that arm the flip-independent lock
export const LOCK_SHARE = 0.4;          // share of the peak the lock keeps

export type GuardInput = {
  side: string;                 // "buy" | "sell"
  entry: number; price: number; R: number; pip: number;
  curStop: number | null; bePx: number;
  choch: "bullish" | "bearish" | null;
  spread?: number | null;
  /** Best price the trade has reached (defaults to the current price). */
  best?: number | null;
};

/** The tightened stop, or null when the guard shouldn't act. Pure (unit-tested). */
export function profitGuardPlan(i: GuardInput): { stop: number; profitPips: number; peakPips: number; why: "flip" | "lock" } | null {
  const long = String(i.side).toLowerCase() === "buy";
  if (!(i.entry > 0 && i.price > 0 && i.R > 0 && i.pip > 0)) return null;
  const profit = long ? i.price - i.entry : i.entry - i.price;
  const profitPips = Math.round(profit / i.pip);
  const bestPx = i.best != null && i.best > 0 ? (long ? Math.max(i.best, i.price) : Math.min(i.best, i.price)) : i.price;
  const peakPips = Math.round((long ? bestPx - i.entry : i.entry - bestPx) / i.pip);
  if (peakPips < GUARD_MIN_PIPS) return null;

  const pad = Math.max(GUARD_BEHIND_PIPS * i.pip, (i.spread ?? 0) * 2);  // keep clear of the spread
  const ceiling = long ? i.price - pad : i.price + pad;                  // tightest a stop can legally sit
  const beOk = long ? ceiling >= i.bePx : ceiling <= i.bePx;
  if (!beOk) return null;                                                // market already back at break-even

  let stop: number | null = null; let why: "flip" | "lock" = "lock";
  const against = long ? "bearish" : "bullish";
  if (i.choch === against) { stop = ceiling; why = "flip"; }
  else if (peakPips >= LOCK_TRIGGER_PIPS) {
    const lock = LOCK_SHARE * peakPips * i.pip;
    stop = long ? Math.min(i.entry + lock, ceiling) : Math.max(i.entry - lock, ceiling);
  }
  if (stop == null) return null;
  stop = long ? Math.max(stop, i.bePx) : Math.min(stop, i.bePx);         // never worse than break-even
  const cur = i.curStop;
  const improved = cur == null || (long ? stop > cur + i.pip : stop < cur - i.pip);
  if (!improved) return null;                                            // already at least this tight
  return { stop: +stop.toFixed(2), profitPips, peakPips, why };
}
