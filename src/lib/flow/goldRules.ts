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

/*
 * ── WHAT 60 DAYS OF FLOW SAID (owner 11-10: "look at the stats and make flow better") ──────────────────
 *
 * 536 gold trades, Sep 11 – Nov 10: 66% won, yet −2,033 pips, because the average loss (−63) was more than
 * twice the average win (+27). Two causes held up in BOTH 30-day halves, so they are treated as properties
 * of the market rather than of one lucky stretch:
 *
 *   1. GENX's 5-minute "quick" calls only paid during London hours. Quick trades by session: London
 *      +327 pips (73% won), Asia −879, New York −881, evening −297 — the same sign in each half. The owner's
 *      choice: FLOW takes quick calls 07:00–12:00 UTC only, for every account, Send It included. GENX still
 *      shows every call; intraday (15-minute) calls are not touched.
 *
 *   2. Break-even fired far too early. Since 11-03 the take-profit sits at 1:1, but break-even still moved at
 *      30 pips — a third of the way on a quick trade — so winners were closed near entry while losers paid
 *      the full stop. Replaying the 518 trades on 1-minute gold prices, waiting until a trade is 80% of the way
 *      to its take-profit scored about 10 pips a trade better (in both halves). The owner's choice: break-even,
 *      the follow-price trail and the reversal snap all wait until then, on every gold account, whatever
 *      break-even the account picked; the account's own pips still apply when they are further out.
 */

/**
 * The UTC hours FLOW takes GENX's quick (5-minute) calls in, as [from, to). FLOW_QUICK_HOURS_UTC changes it
 * without a deploy ("7-12"; "off" takes quick calls at every hour, as before 11-10).
 */
export function quickHoursUtc(): { from: number; to: number } | null {
  const raw = String(process.env.FLOW_QUICK_HOURS_UTC ?? "7-12").trim().toLowerCase();
  if (raw === "off" || raw === "all" || raw === "") return null;
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(raw);
  if (!m) return { from: 7, to: 12 };
  const from = Number(m[1]), to = Number(m[2]);
  return from >= 0 && from <= 24 && to >= 0 && to <= 24 && from !== to ? { from, to } : { from: 7, to: 12 };
}

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * May FLOW take this call now? Only quick calls are timed: a call with no mode is read as quick, the way the
 * placement paths have always read it. GENX 3.x runs its own strategy and is not held to this.
 */
export function quickCallAllowed(mode: string | null | undefined, nowMs: number, origin?: string | null): { ok: true } | { ok: false; reason: string } {
  if (origin === "genx3") return { ok: true };
  const m = String(mode ?? "quick").toLowerCase();
  if (m !== "quick") return { ok: true };
  const w = quickHoursUtc();
  if (!w) return { ok: true };
  const d = new Date(nowMs);
  const h = d.getUTCHours();
  const inside = w.from < w.to ? h >= w.from && h < w.to : h >= w.from || h < w.to;
  if (inside) return { ok: true };
  const now = `${String(h).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return { ok: false, reason: `quick_outside_hours (quick calls trade ${hh(w.from)}–${hh(w.to)} UTC; now ${now} UTC)` };
}

/** How far toward the take-profit a gold trade must get before FLOW moves its stop at all (0.8 = 80%). */
export const GOLD_PROTECT_AT = Number(process.env.FLOW_GOLD_PROTECT_AT || 0.8);
/**
 * Trades opened before this keep the protection they were opened under (break-even at the account's pips);
 * trades opened after it wait for 80% of the way to target. GOLD_PROTECT_AT_SINCE moves it without a deploy.
 */
export const PROTECT_AT_SINCE_DEFAULT = "2026-11-10T19:15:00Z";
export const protectAtSinceMs = (): number => Date.parse(process.env.GOLD_PROTECT_AT_SINCE || PROTECT_AT_SINCE_DEFAULT);

/**
 * The price a gold trade has to reach before break-even, the trail or the snap may touch its stop: 80% of the
 * way from the entry to the take-profit in force. Without a usable target, the 1:1 target the trade is placed
 * with (GOLD_MIN_TARGET_R × the stop distance) stands in. null = no floor (a trade from before the change, the
 * floor switched off, or nothing to measure from).
 */
export function goldProtectFromPx(side: string, entry: number, target: number | null | undefined, initStop: number | null | undefined, openedAtMs?: number | null): number | null {
  if (!(GOLD_PROTECT_AT > 0)) return null;
  if (openedAtMs != null && Number.isFinite(openedAtMs) && openedAtMs < protectAtSinceMs()) return null;
  const long = String(side).toLowerCase() === "buy";
  const e = Number(entry);
  if (!(Number.isFinite(e) && e > 0)) return null;
  const t = target == null ? NaN : Number(target);
  let dist = Number.isFinite(t) && t > 0 && (long ? t > e : t < e) ? Math.abs(t - e) : NaN;
  if (!(dist > 0)) {
    const s = initStop == null ? NaN : Number(initStop);
    const r = Number.isFinite(s) && s > 0 ? Math.abs(e - s) : NaN;
    dist = r > 0 ? r * GOLD_MIN_TARGET_R : NaN;
  }
  if (!(dist > 0)) return null;
  return long ? e + GOLD_PROTECT_AT * dist : e - GOLD_PROTECT_AT * dist;
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
