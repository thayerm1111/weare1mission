import { convert, type Rates } from "./money";
import type { Settings } from "./settings";

/**
 * ACCOUNT-LEVEL RISK RULES AND THE BOOKS. Pure.
 *
 *   • Loss streak: after N net losses in a row (default 3), no new entries for M minutes (default 15)
 *     from the last of them. A further loss while the streak stands pauses again. A trade whose result
 *     is not known yet counts as a loss here — the pause is a brake, and a brake errs on the safe side.
 *   • Daily loss: the bot's realized net (fills, commission and charges) for trades closed since 17:00
 *     New York, plus what its open trades would realize now (net of their closing charges). Deposits
 *     and withdrawals are not in it by construction. At the limit (default 1% of the day's starting
 *     eligible equity) entries stop and the bot's positions are closed.
 *   • Results come from the actual fill prices: the spread and any slippage are already in them and
 *     are not deducted again. Commission and charges are deducted once, at the configured rates.
 *   • Compensation counts only under terms the owner has entered; unknown eligibility is zero, and
 *     compensation is reported beside the trading result, never folded into it (a loss stays a loss).
 */

export function lossStreak(closed: Array<{ closedAt: number; net: number | null }>): { count: number; lastLossAt: number | null } {
  const sorted = [...closed].sort((a, b) => a.closedAt - b.closedAt);
  let count = 0;
  let lastLossAt: number | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const t = sorted[i];
    const loss = t.net == null || t.net < 0;
    if (!loss) break;
    if (lastLossAt == null) lastLossAt = t.closedAt;
    count++;
  }
  return { count, lastLossAt };
}

/** Until when new entries are paused by the loss streak, or null. */
export function streakPauseUntil(closed: Array<{ closedAt: number; net: number | null }>, s: Settings["risk"], nowMs: number): number | null {
  const { count, lastLossAt } = lossStreak(closed);
  if (count < s.lossStreakCount || lastLossAt == null) return null;
  const until = lastLossAt + s.lossStreakPauseMin * 60_000;
  return nowMs < until ? until : null;
}

/** The day's loss so far (positive = a loss), from realized nets and open trades' current nets. */
export function dayLoss(realizedNets: number[], openNets: number[]): number {
  const total = realizedNets.reduce((a, b) => a + b, 0) + openNets.reduce((a, b) => a + b, 0);
  return -total;
}

export type Pnl = { gross: number; commission: number; other: number; net: number; rate: number };

/**
 * One trade's result in the account currency. `exit` is the price it was closed at (or, for an open
 * trade, the executable price it would close at now: the bid for a buy, the ask for a sell).
 */
export function tradePnl(inp: {
  side: "buy" | "sell";
  lots: number;
  lotSize: number;
  fill: number;
  exit: number;
  quoteCcy: string;
  accountCcy: string;
  rates: Rates;
  commissionPerLotPerSide: number;
  otherRtPerLot: number;
  /** For an open trade only the opening side has been charged so far; both are counted (the close is coming). */
}): Pnl | null {
  const units = inp.lots * inp.lotSize;
  const grossQuote = (inp.side === "buy" ? inp.exit - inp.fill : inp.fill - inp.exit) * units;
  const gross = convert(grossQuote, inp.quoteCcy, inp.accountCcy, inp.rates);
  if (gross == null) return null;
  const rate = grossQuote !== 0 ? gross / grossQuote : (convert(1, inp.quoteCcy, inp.accountCcy, inp.rates) ?? 0);
  const commission = inp.commissionPerLotPerSide * 2 * inp.lots;
  const other = inp.otherRtPerLot * inp.lots;
  return { gross, commission, other, net: gross - commission - other, rate };
}

/** Lots that count toward compensation under the entered terms (zero when the terms are unknown). */
export function eligibleLots(lots: number, holdSec: number | null, p: Settings["payout"]): number {
  if (!p.termsEntered) return 0;
  if (p.minHoldSec != null && (holdSec == null || holdSec < p.minHoldSec)) return 0;
  return p.basis === "per_side" ? lots * 2 : lots;
}

export function estimatedCompensation(eligible: number, p: Settings["payout"]): number {
  if (!p.termsEntered || p.ratePerLot == null) return 0;
  return eligible * p.ratePerLot;
}
