/**
 * THE EXECUTION VALIDATOR — the last deterministic word before anything is sent to a broker.
 *
 * Nothing above this file can overrule it. Not the member clicking quickly, not ATLAS being confident,
 * not an automation flag. It answers one question — "may this order be sent, and at what size?" — from
 * numbers, limits and permissions, and it says no with a reason a person can read.
 *
 * Ordering matters here. Permission and data-quality gates come BEFORE sizing, because a trade that is not
 * allowed should never have had a size calculated for it in the first place.
 */
import type { MarketSnapshot, Side } from "../core/types";
import { checkAccountLimits, sizePosition, FLOW_GOLD_LIMITS, COOLDOWN_BY_STYLE, type AccountState, type Instrument, type RiskLimits } from "../core/risk";
import { STYLE, type Style } from "../core/style";
import { toPips } from "../core/instrument";
import { tradeable } from "./snapshot";
import { inWeekendCloseWindow } from "../core/sessions";
import type { AccountRow } from "./broker";
import { dayPnlPct, weekPnlPct, type TradingHistory } from "./accountHistory";

export type ValidateInput = {
  account: AccountRow;
  snapshot: MarketSnapshot | null;
  side: Side;
  style: Style;
  entry: number | null;          // null = market
  stop: number;
  takeProfit: number | null;
  riskPct: number;
  equity: number | null;
  instrument: Instrument;
  pipSize: number;
  spread: number | null;
  openPositions: number;
  openRiskPct: number;
  limits?: Partial<RiskLimits>;
  /**
   * What this account has actually done today and this week. REQUIRED for a trade to be allowed —
   * without it the loss, drawdown, streak, session and cooldown limits cannot be evaluated, and this
   * validator refuses rather than approving on numbers it does not have.
   */
  history?: TradingHistory;
  /** Is this a member pressing the button, or automation acting on its own? */
  origin: "member" | "brain" | "auto";
};

export type Sizing = { qty: number; riskAmount: number; stopPips: number; riskPctUsed: number; rMultipleToTp: number | null };

export type Validation =
  | { ok: true; sizing: Sizing; warnings: string[]; referencePrice: number }
  | { ok: false; reason: string; hard: boolean; warnings: string[] };

/** Risk percentages a member may choose. A custom value is still capped by the account's own limits. */
export const RISK_CHOICES = [0.25, 0.5, 0.75, 1.0];
export const MAX_RISK_PCT = 2.0;

export function validate(i: ValidateInput): Validation {
  const warnings: string[] = [];
  const no = (reason: string, hard = true): Validation => ({ ok: false, reason, hard, warnings });

  /* 1 — may this account trade at all? */
  if (i.account.is_live && !i.account.live_authorized_at) {
    return no("This is a LIVE account and live trading has not been authorised on it yet.");
  }
  if (i.origin === "member" && i.account.permissions?.manual_execute === false) {
    return no("Manual execution is switched off for this account.");
  }
  if (i.origin === "auto" && !i.account.auto_trading) {
    return no("Automatic trading is off for this account.");
  }

  /*
   * 1b — THE FRIDAY WINDOW. FLOW stops opening anything in the last half hour of the week on every
   *      automated path; matching it here means the two engines shut their entry windows together
   *      rather than half an hour apart. A member pressing the button themselves is not blocked —
   *      this is about what automation does unattended into a two-day gap.
   */
  if (i.origin !== "member" && inWeekendCloseWindow()) {
    return no("The week closes within the half hour — no new automated entries until gold reopens.");
  }

  /* 2 — can we see the market well enough to act on it? */
  if (!i.snapshot) return no("There is no market read — ATLAS cannot see gold right now.");
  const gate = tradeable(i.snapshot);
  if (!gate.ok) return no(gate.reason);

  /* 3 — is the instruction itself coherent? */
  const price = i.entry ?? i.snapshot.price;
  if (!(price > 0)) return no("No usable price for this order.");
  if (!(i.stop > 0)) return no("A stop is required. ATLAS will not send an order without one.");
  const wrongSide = i.side === "buy" ? i.stop >= price : i.stop <= price;
  if (wrongSide) return no(`For a ${i.side} the stop must sit ${i.side === "buy" ? "below" : "above"} the entry.`);
  if (i.takeProfit != null) {
    const tpWrong = i.side === "buy" ? i.takeProfit <= price : i.takeProfit >= price;
    if (tpWrong) return no(`For a ${i.side} the target must sit ${i.side === "buy" ? "above" : "below"} the entry.`);
  }

  const riskPct = Math.min(Math.max(i.riskPct, 0), MAX_RISK_PCT);
  if (!(riskPct > 0)) return no("Risk per trade is zero.");
  if (riskPct !== i.riskPct) warnings.push(`Risk was capped at ${MAX_RISK_PCT}% for this account.`);

  if (!(i.equity != null && i.equity > 0)) {
    return no("The broker has not reported an account balance yet, so this trade cannot be sized.");
  }

  /* 4 — style-aware sanity on the stop. A stop inside the style's own noise floor is not a stop. */
  const stopPips = toPips(Math.abs(price - i.stop), i.pipSize);
  const floor = STYLE[i.style].noiseFloorPips;
  if (stopPips < floor * 0.5) {
    return no(`A ${Math.round(stopPips)}-pip stop is inside the noise of a ${STYLE[i.style].label} trade — it would be taken out by ordinary movement.`, false);
  }

  /* 5 — account-level limits. The stop ceiling comes from the STYLE, because one global number either
         rejects every real swing or waves through a "quick" trade with a hundred-pip stop. An explicit
         account or caller limit still wins — this only replaces the default. */
  const accountLimits = (i.account.risk_limits as Partial<RiskLimits> | undefined) ?? {};
  const limits: RiskLimits = {
    ...FLOW_GOLD_LIMITS,
    maxStopPips: STYLE[i.style].maxStopPips,
    // FLOW paces by style: quick 90 minutes, hold 180, swing 480. This is the brake that does the work.
    cooldownMs: COOLDOWN_BY_STYLE[i.style] ?? FLOW_GOLD_LIMITS.cooldownMs,
    ...accountLimits,
    ...(i.limits ?? {}),
  };
  /*
   * THE ACCOUNT'S REAL DAY, NOT A ROW OF ZEROS.
   *
   * This used to read:
   *
   *     dayPnlPct: 0, dayPeakEquity: i.equity, weekPnlPct: 0,
   *     consecutiveLosses: 0, tradesThisSession: 0, lastTradeAtMs: null,
   *
   * Every loss-based limit below was therefore comparing against a constant zero and could never fire.
   * The daily loss limit, the drawdown limit, the weekly limit, the four-losses-in-a-row stop, the
   * session count and the cooldown were all decorative — six guards, none of them connected.
   *
   * A caller that cannot supply the history gets refused rather than waved through. "I don't know what
   * this account has lost today" is not a reason to allow another trade; it is the reason not to.
   */
  if (!i.history) {
    return no("The account's recent trading was not supplied, so the cooldown and hourly pace cannot be checked.");
  }
  if (!i.history.readable) {
    return no("Cannot read when this account last entered, so the cooldown cannot be enforced. Refusing rather than risking a stacked entry.");
  }

  const state: AccountState = {
    equity: i.equity,
    openRiskPct: i.openRiskPct,
    dayPnlPct: dayPnlPct(i.history, i.equity),
    dayPeakEquity: i.history.dayPeakEquity,
    weekPnlPct: weekPnlPct(i.history, i.equity),
    consecutiveLosses: i.history.consecutiveLosses,
    tradesThisSession: i.history.tradesToday,
    openPositions: i.openPositions,
    lastTradeAtMs: i.history.lastTradeAtMs,
    entriesLastHour: i.history.entriesLastHour,
  };
  const acct = checkAccountLimits(state, limits, Date.now(), { spread: i.spread, stopPips, newTradeRiskPct: riskPct });
  if (!acct.ok) return no(acct.reason, acct.hard);

  /* 6 — only now, size it. */
  const sized = sizePosition({
    equity: i.equity, entry: price, stop: i.stop, side: i.side, riskPct,
    inst: i.instrument, maxStopPips: limits.maxStopPips,
  });
  if (!sized.ok) return no(sized.reason, false);

  /*
   * A CLAMPED SIZE IS NEWS, NOT A DETAIL.
   *
   * When a ceiling binds, the trade goes on smaller than the risk setting asked for — which is the safe
   * direction, and exactly the sort of thing that must never happen silently. On the first live night
   * risk-based sizing wanted 12.5 lots on a 17-pip stop; a person reading "1.98 lots" with no
   * explanation would reasonably assume the risk setting had changed.
   */
  if (sized.cappedBy) {
    const why = sized.cappedBy === "notional" ? "the position-size limit"
      : sized.cappedBy === "max_lots" ? "the maximum lot size"
      : "the broker's own maximum";
    warnings.push(
      `Sized down from ${sized.uncappedLots} to ${sized.lots} lots by ${why} — this trade risks ` +
      `${sized.riskPctUsed}% rather than the ${riskPct}% requested. The stop is tight, so full risk ` +
      `would have meant an outsized position.`,
    );
  }

  const rToTp = i.takeProfit != null && sized.stopPips > 0
    ? +(toPips(Math.abs(i.takeProfit - price), i.pipSize) / sized.stopPips).toFixed(2)
    : null;
  if (rToTp != null && rToTp < 0.8) {
    warnings.push(`That target is only ${rToTp}R away — you would be risking more than you stand to make.`);
  }
  for (const w of i.snapshot.warnings.slice(0, 2)) warnings.push(w);
  if (i.snapshot.news.nextEvent && (i.snapshot.news.minutesToNext ?? 999) <= 15) {
    warnings.push(`${i.snapshot.news.nextEvent.name} is ${Math.round(i.snapshot.news.minutesToNext ?? 0)} minutes away.`);
  }

  return {
    ok: true,
    referencePrice: price,
    warnings,
    sizing: {
      qty: sized.lots,
      riskAmount: sized.riskAmount,
      stopPips: sized.stopPips,
      riskPctUsed: sized.riskPctUsed,
      rMultipleToTp: rToTp,
    },
  };
}
