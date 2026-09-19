/**
 * THE EXECUTION VALIDATOR — the last deterministic word before anything is sent to a broker.
 *
 * Nothing above this file can overrule it. Not the member clicking quickly, not THE BRAIN being confident,
 * not an automation flag. It answers one question — "may this order be sent, and at what size?" — from
 * numbers, limits and permissions, and it says no with a reason a person can read.
 *
 * Ordering matters here. Permission and data-quality gates come BEFORE sizing, because a trade that is not
 * allowed should never have had a size calculated for it in the first place.
 */
import type { MarketSnapshot, Side } from "../core/types";
import { checkAccountLimits, sizePosition, DEFAULT_LIMITS, type AccountState, type Instrument, type RiskLimits } from "../core/risk";
import { STYLE, type Style } from "../core/style";
import { toPips } from "../core/instrument";
import { tradeable } from "./snapshot";
import type { AccountRow } from "./broker";

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

  /* 2 — can we see the market well enough to act on it? */
  if (!i.snapshot) return no("There is no market read — THE BRAIN cannot see gold right now.");
  const gate = tradeable(i.snapshot);
  if (!gate.ok) return no(gate.reason);

  /* 3 — is the instruction itself coherent? */
  const price = i.entry ?? i.snapshot.price;
  if (!(price > 0)) return no("No usable price for this order.");
  if (!(i.stop > 0)) return no("A stop is required. THE BRAIN will not send an order without one.");
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
    ...DEFAULT_LIMITS,
    maxStopPips: STYLE[i.style].maxStopPips,
    ...accountLimits,
    ...(i.limits ?? {}),
  };
  const state: AccountState = {
    equity: i.equity,
    openRiskPct: i.openRiskPct,
    dayPnlPct: 0, dayPeakEquity: i.equity, weekPnlPct: 0,
    consecutiveLosses: 0, tradesThisSession: 0,
    openPositions: i.openPositions,
    lastTradeAtMs: null,
  };
  const acct = checkAccountLimits(state, limits, Date.now(), { spread: i.spread, stopPips, newTradeRiskPct: riskPct });
  if (!acct.ok) return no(acct.reason, acct.hard);

  /* 6 — only now, size it. */
  const sized = sizePosition({
    equity: i.equity, entry: price, stop: i.stop, side: i.side, riskPct,
    inst: i.instrument, maxStopPips: limits.maxStopPips,
  });
  if (!sized.ok) return no(sized.reason, false);

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
