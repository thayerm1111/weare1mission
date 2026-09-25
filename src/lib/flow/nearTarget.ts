/**
 * THE NEAR TARGET (owner 09-25: "backtest the breakeven trigger... figure out how to change it to
 * make it better and then make that change").
 *
 * WHAT THE DATA SAID. 8,938 resolved gold trades over 30 days: 58.7% win rate, but +41 pips on the
 * average winner against −73 on the average loser, for an expectancy of −3.8 pips a trade. The cause
 * was not the break-even trigger on its own — turning break-even OFF measured WORSE (−11.7 vs −7.9
 * pips across 50 signals that ran both ways). The cause is that the TARGET IS OUT OF REACH. GENX
 * places its take-profit at ~1.9R, roughly 208 pips, while the median trade never moves more than
 * 52.8 pips in the member's favour. Only 8% of trades ever touch it. So the good trades do not get
 * paid at the target; they drift back and get scratched by the 30-pip break-even for ~+16 pips,
 * while the losers pay the full ~110-pip stop.
 *
 * THE FIX, AND WHY THIS SHAPE. Put a take-profit where price actually goes. Re-running every trade
 * with a nearer target is assumption-free — a take-profit that is never reached changes nothing
 * downstream, so a trade either now exits at the new target (it demonstrably traded through it) or
 * ends exactly as it really did:
 *
 *     target        expectancy      vs today
 *     today (1.9R)   −3.8 pips        —
 *     0.4R          +12.3          +16.1
 *     0.5R          +12.6          +16.4
 *     fixed 50p     +13.6          +17.4
 *     0.5R (30–80)  +13.4          +17.2
 *
 * The curve is flat from about 35 to 80 pips, which is the sign that this is a real property of the
 * market rather than one lucky number. Split in half by time it holds in BOTH halves: +18.8 in the
 * first, +8.2 in the second — the second half being the fortnight the desk actually lost 10.9 pips a
 * trade. A fraction of R is used rather than a flat pip count because gold stops here run from 8 to
 * 1,035 pips, and a flat 50-pip target on a 500-pip swing stop is not a trade; the clamp then keeps
 * it sane at both ends.
 *
 * WHAT IT COSTS. Capping at ~0.5R gives up the occasional big runner (trades that ran 120+ pips
 * averaged +45.9). That loss is already inside every number above, and the trade is still strongly
 * positive without them. Winning small and often beats winning rarely and being scratched.
 *
 * WHAT THIS DOES NOT TOUCH. GENX's own plan is unchanged — it still finds the trade the same way and
 * still publishes its 1.9R target, and `tp1` in the ledger is still that target. This only moves the
 * take-profit ORDER that FLOW parks at the broker. That distinction matters mechanically: the entry
 * limit price is derived from the GENX target to enforce a 0.75 reward:risk floor on the fill, and
 * feeding it a nearer target would make every entry unrepresentable and refuse the trade.
 *
 * A RESTING ORDER, NOT A POLLED CLOSE. The target lives at the broker, so it fills the moment price
 * trades through it. Closing from the manager's poll instead would miss exactly the fast moves this
 * is meant to capture — and the backtest above assumed a fill at the level, so a resting order is
 * what makes the measured result the delivered one.
 */

/** Fraction of the trade's own stop distance. */
export const NEAR_TP_R = Number(process.env.GENX_NEAR_TP_R || 0.5);
/** Never nearer than this — below it the spread and a normal wobble dominate the edge. */
export const NEAR_TP_MIN_PIPS = Number(process.env.GENX_NEAR_TP_MIN || 30);
/** Never further than this — past it the hit rate falls away faster than the extra pips pay. */
export const NEAR_TP_MAX_PIPS = Number(process.env.GENX_NEAR_TP_MAX || 80);
/** Master switch. Set GENX_NEAR_TP=off to go straight back to GENX's own target, no deploy needed. */
export const NEAR_TP_ON = String(process.env.GENX_NEAR_TP || "on").toLowerCase() !== "off";

/** Gold only. The measurement is gold's; nothing else here trades enough to have earned a change. */
export const nearTargetApplies = (symbol: string | null | undefined) =>
  NEAR_TP_ON && String(symbol || "").toUpperCase().replace(/[^A-Z]/g, "") === "XAUUSD";

/**
 * How far from entry the target sits, in pips. Returns null when the stop distance is unusable —
 * callers then leave GENX's own target alone rather than inventing a level.
 */
export function nearTargetPips(riskPips: number | null | undefined): number | null {
  if (riskPips == null) return null;          // Number(null) is 0, not NaN — reject before coercing
  const r = Number(riskPips);
  if (!Number.isFinite(r) || r <= 0) return null;
  return Math.min(NEAR_TP_MAX_PIPS, Math.max(NEAR_TP_MIN_PIPS, r * NEAR_TP_R));
}

/**
 * The near target as a PRICE. `pip` is the symbol's pip size (gold: 0.1).
 *
 * Returns null — meaning "leave GENX's target in place" — when the stop is unreadable, and also when
 * the near target would sit at or beyond GENX's own target. That second guard is the one that keeps
 * this honest on a tight setup: this is only ever allowed to bring a target CLOSER, never to push one
 * further away than the trade was sold on.
 */
export function nearTargetPrice(
  side: "buy" | "sell",
  entry: number | null | undefined,
  initStop: number | null | undefined,
  pip: number,
  genxTp?: number | null,
): number | null {
  // Reject nulls BEFORE coercing: Number(null) is 0, and a "0" entry silently produced a target
  // 8 pips above zero instead of no target at all.
  if (entry == null || initStop == null || pip == null) return null;
  const e = Number(entry), s = Number(initStop), p = Number(pip);
  if (!Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(p) || p <= 0) return null;
  if (e <= 0 || s <= 0) return null;
  const riskPips = Math.abs(e - s) / p;
  const pips = nearTargetPips(riskPips);
  if (pips == null) return null;
  const px = side === "buy" ? e + pips * p : e - pips * p;
  if (genxTp != null && Number.isFinite(Number(genxTp))) {
    const g = Number(genxTp);
    // Only ever nearer than GENX's target.
    if (side === "buy" ? px >= g : px <= g) return null;
  }
  return px;
}
