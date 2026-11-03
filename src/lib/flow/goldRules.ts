/**
 * THE SHAPE OF A GOLD TRADE (owner 11-02).
 *
 * "Where is this trade from? Seems so bad... I do not want trades like this. It is such a massive stop
 * loss and small take profit." The trade: a GENX intraday BUY at 3958.80 with its stop at 3895.85 — $63
 * of risk — and a take-profit parked 80 pips up at 3967.05. It reached his live account at 0.73 lots and
 * seven member accounts besides.
 *
 * Two things made it. Intraday and swing calls keep GENX's own structural stop (owner 09-21), and that
 * stop can sit $60–$100 away; only quick calls were held to the 100-pip cap. And FLOW's near target
 * (nearTarget.ts) put the take-profit at half the stop but never more than 80 pips — so the wider the
 * stop, the worse the trade looked.
 *
 * The owner's rule, for every account (his and every member's):
 *   • no gold trade whose stop is more than $15 (150 pips) from the entry — it is skipped, not resized;
 *   • the take-profit is never nearer than the stop: GENX's own target has to be at least as far as the
 *     stop (else the trade is skipped), and the take-profit FLOW parks at the broker is at least 1:1.
 */

/** The widest stop a gold trade may carry, in dollars of price (gold: $1 = 10 pips). */
export const GOLD_MAX_STOP_USD = Number(process.env.FLOW_GOLD_MAX_STOP_USD || 15);
/** The take-profit is at least this many times the stop distance. */
export const GOLD_MIN_TARGET_R = Number(process.env.FLOW_GOLD_MIN_TARGET_R || 1);

export const isGold = (symbol: string | null | undefined): boolean =>
  String(symbol || "").toUpperCase().replace(/[^A-Z]/g, "") === "XAUUSD";

export type GoldShape = { ok: true; risk: number; reward: number | null } | { ok: false; reason: string; risk: number; reward: number | null };

/**
 * Judge a gold trade as it would be placed: entry, the stop it would carry, and GENX's own target.
 * A trade with no stop is refused (gold never trades without one); a trade with no target is judged on
 * its stop alone. Comparisons carry a hair of tolerance so a stop of exactly $15.00 still passes.
 */
export function goldTradeShape(side: "buy" | "sell", entry: number | null | undefined, stop: number | null | undefined, tp: number | null | undefined): GoldShape {
  const e = Number(entry), s = Number(stop);
  if (entry == null || stop == null || !Number.isFinite(e) || !Number.isFinite(s) || e <= 0 || s <= 0) {
    return { ok: false, reason: "gold_no_stop (a gold trade needs a stop and an entry)", risk: NaN, reward: null };
  }
  const risk = side === "buy" ? e - s : s - e;
  if (!(risk > 0)) return { ok: false, reason: `gold_stop_wrong_side (stop ${s} is not ${side === "buy" ? "below" : "above"} entry ${e})`, risk, reward: null };
  const t = tp == null ? NaN : Number(tp);
  const reward = Number.isFinite(t) && t > 0 ? (side === "buy" ? t - e : e - t) : null;
  if (risk > GOLD_MAX_STOP_USD + 1e-6) {
    return { ok: false, reason: `gold_stop_over_limit (stop $${risk.toFixed(2)} from entry; the limit is $${GOLD_MAX_STOP_USD})`, risk, reward };
  }
  if (reward != null && reward + 1e-6 < risk * GOLD_MIN_TARGET_R) {
    return { ok: false, reason: `gold_target_inside_stop (target $${reward.toFixed(2)} away, stop $${risk.toFixed(2)}; the target must be at least the stop)`, risk, reward };
  }
  return { ok: true, risk, reward };
}

/**
 * Where a limit entry actually fills: at the quote when the quote is already better than the limit (a buy
 * limit above the ask fills at the ask), else at the limit. The shape is judged here — at the limit alone,
 * a marketable buy capped far above the quote would look like a much wider stop than the trade carries.
 */
export function expectedFill(side: "buy" | "sell", price: number, limitPx: number | null | undefined): number {
  if (limitPx == null || !Number.isFinite(limitPx) || limitPx <= 0) return price;
  return side === "buy" ? Math.min(price, limitPx) : Math.max(price, limitPx);
}
