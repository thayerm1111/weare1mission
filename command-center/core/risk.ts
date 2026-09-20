/**
 * THE RISK ENGINE — deterministic, and above the model.
 *
 * Nothing here consults an opinion. Every function answers "is this permitted, and how big?" from numbers
 * and limits. A model can request; only this file can approve. The asymmetry is the whole design: a bug in
 * the intelligence layer costs a missed trade, a bug here costs an account.
 */
import type { Side } from "./types";
import { PIP } from "./types";

export type Instrument = { contractSize: number; minLot: number; maxLot: number; lotStep: number; pipValuePerLot: number };
/**
 * NULL MEANS NOT ENFORCED, AND THAT IS A REAL SETTING RATHER THAN A HOLE.
 *
 * The loss-accounting gates used to be plain numbers, which left no way to express "the desk does not
 * run this rule on gold" other than a sentinel — and every sentinel is wrong in this file. Zero is the
 * worst of them: `dayPnlPct <= -Math.abs(0)` fires on any loss at all, so a limit switched "off" by
 * setting it to zero would stop the account on its first losing cent.
 *
 * So these are nullable. Null is checked for explicitly and skipped, which lets a policy say plainly
 * which rules it runs — see FLOW_GOLD_LIMITS, which mirrors what the desk actually enforces.
 */
export type RiskLimits = {
  riskPct: number;
  maxOpenRiskPct: number;
  maxDailyLossPct: number | null;
  maxDailyDrawdownPct: number | null;
  maxWeeklyLossPct: number | null;
  maxConsecutiveLosses: number | null;
  maxTradesPerSession: number | null;
  maxOpenPositions: number;
  cooldownMs: number;
  maxSpread: number;
  maxStopPips: number;
  minEquity: number;
  /** Entries per rolling hour on one account. FLOW's equivalent defaults to 10. Null = not enforced. */
  maxEntriesPerHour?: number | null;
};
export type AccountState = {
  equity: number;
  openRiskPct: number;
  dayPnlPct: number;
  dayPeakEquity: number;
  weekPnlPct: number;
  consecutiveLosses: number;
  tradesThisSession: number;
  openPositions: number;
  lastTradeAtMs: number | null;
  /** Entries opened on this account in the last rolling hour. Null when not measured. */
  entriesLastHour?: number | null;
};

export const DEFAULT_LIMITS: RiskLimits = {
  riskPct: 0.5, maxOpenRiskPct: 2, maxDailyLossPct: 3, maxDailyDrawdownPct: 4, maxWeeklyLossPct: 6,
  maxConsecutiveLosses: 4, maxTradesPerSession: 8, maxOpenPositions: 1, cooldownMs: 3 * 60_000,
  maxSpread: 0.6, maxStopPips: 100, minEquity: 0, maxEntriesPerHour: null,
};

/**
 * WHAT THE DESK ACTUALLY ENFORCES ON GOLD — and therefore what the Command Center enforces.
 *
 * The owner's instruction was to run the same rules as FLOW and GENX rather than a separate set. So
 * these are read off FLOW's own automated path rather than chosen here, and where FLOW does not run a
 * rule, this does not invent one:
 *
 *   • NO daily loss, drawdown or weekly limit. `daily_loss_limit` exists as a settings field in FLOW
 *     and is enforced nowhere in the codebase — declared, written once, never read.
 *
 *   • NO consecutive-loss breaker on gold. FLOW has one, and gold is explicitly exempt from it by the
 *     owner's decision of 2026-09-16: "gold no longer pauses an account after 2 losses in a row
 *     (forex keeps its breaker)". Forex is not traded here, so the breaker has nothing to apply to.
 *
 * What FLOW restrains instead is PACE AND CONCURRENCY, and that is what is mirrored here. It is not
 * the looser choice it might look like: FLOW's cooldown for a quick trade is NINETY MINUTES against
 * the three minutes this file used to use, and the Command Center trades a single symbol. A 90-minute
 * gap plus one position at a time is a harder ceiling on a bad session than a loss limit that only
 * engages after the money is already gone.
 *
 * COOLDOWN_BY_STYLE carries FLOW's own numbers per mode. The per-style value is applied by the caller,
 * because only the caller knows which style the setup is.
 */
export const FLOW_GOLD_LIMITS: RiskLimits = {
  riskPct: 0.5,
  maxOpenRiskPct: 2,
  maxDailyLossPct: null,
  maxDailyDrawdownPct: null,
  maxWeeklyLossPct: null,
  maxConsecutiveLosses: null,
  maxTradesPerSession: null,
  maxOpenPositions: 1,
  cooldownMs: 90 * 60_000,      // replaced per style by COOLDOWN_BY_STYLE
  maxSpread: 0.6,
  maxStopPips: 100,             // replaced per style by the style's own ceiling
  minEquity: 0,
  maxEntriesPerHour: 10,        // FLOW's max_orders_per_hour default
};

/** FLOW's COOLDOWN_MIN, in the Command Center's own style names. quick 90m · hold 180m · swing 480m. */
export const COOLDOWN_BY_STYLE: Record<string, number> = {
  quick: 90 * 60_000,
  hold: 180 * 60_000,
  swing: 480 * 60_000,
};


/**
 * THE POSITION-SIZE CEILING — the guard that was missing, found on the first live open.
 *
 * Risk-based sizing has a hole in it that only opens when the stop is tight. Money-at-risk divided by
 * (stop distance x value per pip) is correct arithmetic, but as the stop shrinks the quantity grows
 * without bound. On the first night this produced real orders of 7 to 16 lots on 17-pip stops — 12.5
 * lots is 1,250 ounces, about $5.5 MILLION of gold against a $435,000 account. Every one was refused
 * by the broker, which is the only reason it was not a position.
 *
 * A broker's refusal is not a risk control. This is.
 *
 * TWO CEILINGS, AND THE NOTIONAL ONE IS THE REAL CONSTRAINT.
 *
 *   • NOTIONAL, as a multiple of equity. One lot of gold is roughly one times this account's equity, so
 *     this reads directly as "how many times the account may be controlled at once". It scales as the
 *     account grows, which a fixed lot number does not.
 *
 *   • LOTS, absolute. A backstop for the case where equity is wrong, stale, or enormous. A cap that
 *     depends on a number the broker reported is not a cap when that number is the thing in doubt.
 *
 * WHEN A CEILING BINDS, THE TRADE RISKS LESS THAN THE SETTING ASKED FOR. That is the safe direction
 * and it is deliberate: the alternative is widening the stop to fit the size, which is moving the exit
 * to justify the entry. The result reports `cappedBy` so the log says which ceiling bit rather than
 * leaving somebody to wonder why a trade came out smaller than the arithmetic.
 */
export const MAX_NOTIONAL_X_EQUITY = Number(process.env.CC_MAX_NOTIONAL_X_EQUITY ?? 2);
export const MAX_LOTS_ABSOLUTE = Number(process.env.CC_MAX_LOTS ?? 3);

export type SizeResult =
  | {
      ok: true; lots: number; riskAmount: number; stopPips: number; riskPctUsed: number;
      /** Which ceiling reduced the size, when one did. Null when risk alone decided it. */
      cappedBy?: "notional" | "max_lots" | "broker_max" | null;
      /** What risk-based sizing asked for before any ceiling applied. */
      uncappedLots?: number;
    }
  | { ok: false; reason: string };

/**
 * Size from risk, never the other way round. Lots round DOWN — a rounding that increases exposure is a bug
 * that only shows up on the day it matters.
 */
export function sizePosition(input: {
  equity: number; entry: number; stop: number; side: Side; riskPct: number; inst: Instrument; maxStopPips?: number;
  /** Overrides for the ceilings, so tests and callers can be explicit rather than inheriting the env. */
  maxNotionalXEquity?: number; maxLots?: number;
}): SizeResult {
  const { equity, entry, stop, side, riskPct, inst } = input;
  if (!(equity > 0)) return { ok: false, reason: "No account equity" };
  if (!(riskPct > 0)) return { ok: false, reason: "Risk per trade is zero" };
  if (!(entry > 0) || !(stop > 0)) return { ok: false, reason: "Entry or stop missing" };
  const wrongSide = side === "buy" ? stop >= entry : stop <= entry;
  if (wrongSide) return { ok: false, reason: "Stop is on the wrong side of the entry" };

  const stopPips = Math.abs(entry - stop) / PIP;
  if (input.maxStopPips && stopPips > input.maxStopPips) return { ok: false, reason: `Stop is ${Math.round(stopPips)} pips — wider than the ${input.maxStopPips}-pip limit` };
  if (!(inst.pipValuePerLot > 0)) return { ok: false, reason: "Instrument specification unknown" };

  const riskAmount = equity * (riskPct / 100);
  const raw = riskAmount / (stopPips * inst.pipValuePerLot);
  const stepped = Math.floor(raw / inst.lotStep + 1e-9) * inst.lotStep;
  const lots = +stepped.toFixed(4);
  if (lots < inst.minLot) return { ok: false, reason: `Risk allows ${lots} lots — below the ${inst.minLot} minimum` };

  /*
   * THE CEILINGS. Applied after risk sizing, never before: risk decides what the trade WANTS to be,
   * and these decide what it is allowed to be.
   */
  const maxNotionalX = input.maxNotionalXEquity ?? MAX_NOTIONAL_X_EQUITY;
  const maxLotsAbs = input.maxLots ?? MAX_LOTS_ABSOLUTE;

  const notionalPerLot = inst.contractSize > 0 ? inst.contractSize * entry : 0;
  const byNotional = notionalPerLot > 0 && maxNotionalX > 0
    ? (equity * maxNotionalX) / notionalPerLot
    : Number.POSITIVE_INFINITY;

  const ceiling = Math.min(inst.maxLot, maxLotsAbs > 0 ? maxLotsAbs : Number.POSITIVE_INFINITY, byNotional);

  let cappedBy: "notional" | "max_lots" | "broker_max" | null = null;
  if (lots > ceiling) {
    cappedBy = ceiling === byNotional ? "notional"
      : ceiling === maxLotsAbs ? "max_lots"
      : "broker_max";
  }

  // Round DOWN to a legal lot again: a ceiling that lands between steps must never round up into it.
  const clamped = Math.min(lots, ceiling);
  const capped = +(Math.floor(clamped / inst.lotStep + 1e-9) * inst.lotStep).toFixed(4);

  if (capped < inst.minLot) {
    return {
      ok: false,
      reason: `The size ceiling allows ${capped} lots here — below the ${inst.minLot} minimum. The stop is too tight to take this trade within the position limit.`,
    };
  }

  return {
    ok: true,
    lots: capped,
    riskAmount: +(capped * stopPips * inst.pipValuePerLot).toFixed(2),
    stopPips: Math.round(stopPips),
    riskPctUsed: +((capped * stopPips * inst.pipValuePerLot / equity) * 100).toFixed(3),
    cappedBy,
    uncappedLots: lots,
  };
}

export type Gate = { ok: boolean; reason: string; hard: boolean };

/** Account-level gates. `hard: true` means no model, member or setting may override it in-session. */
export function checkAccountLimits(a: AccountState, l: RiskLimits, nowMs: number, ctx: { spread?: number | null; stopPips?: number | null; newTradeRiskPct?: number } = {}): Gate {
  const no = (reason: string, hard = true): Gate => ({ ok: false, reason, hard });

  if (l.minEquity > 0 && a.equity < l.minEquity) return no(`Equity ${a.equity.toFixed(0)} is below the ${l.minEquity} minimum for this account`);
  if (l.maxDailyLossPct != null && a.dayPnlPct <= -Math.abs(l.maxDailyLossPct)) return no(`Daily loss limit reached (${a.dayPnlPct.toFixed(2)}% of ${l.maxDailyLossPct}%)`);
  if (l.maxDailyDrawdownPct != null) {
    const dd = a.dayPeakEquity > 0 ? ((a.dayPeakEquity - a.equity) / a.dayPeakEquity) * 100 : 0;
    if (dd >= Math.abs(l.maxDailyDrawdownPct)) return no(`Daily drawdown limit reached (${dd.toFixed(2)}% from today's peak)`);
  }
  if (l.maxWeeklyLossPct != null && a.weekPnlPct <= -Math.abs(l.maxWeeklyLossPct)) return no(`Weekly loss limit reached (${a.weekPnlPct.toFixed(2)}%)`);
  if (l.maxConsecutiveLosses != null && a.consecutiveLosses >= l.maxConsecutiveLosses) return no(`${a.consecutiveLosses} losses in a row — this account is cooling off`);
  if (a.openPositions >= l.maxOpenPositions) return no(`Already holding ${a.openPositions} position${a.openPositions === 1 ? "" : "s"} (limit ${l.maxOpenPositions})`);
  if (l.maxTradesPerSession != null && a.tradesThisSession >= l.maxTradesPerSession) return no(`Session trade limit reached (${a.tradesThisSession})`);
  if (l.maxEntriesPerHour != null && a.entriesLastHour != null && a.entriesLastHour >= l.maxEntriesPerHour) {
    return no(`${a.entriesLastHour} entries in the last hour (limit ${l.maxEntriesPerHour})`);
  }
  if (a.lastTradeAtMs != null && nowMs - a.lastTradeAtMs < l.cooldownMs) {
    return no(`Cooldown: ${Math.ceil((l.cooldownMs - (nowMs - a.lastTradeAtMs)) / 1000)}s since the last trade`);
  }
  const want = ctx.newTradeRiskPct ?? l.riskPct;
  if (a.openRiskPct + want > l.maxOpenRiskPct) return no(`Total open risk would reach ${(a.openRiskPct + want).toFixed(2)}% (limit ${l.maxOpenRiskPct}%)`);
  if (ctx.spread != null && ctx.spread > l.maxSpread) return no(`Spread ${ctx.spread.toFixed(2)} is above the ${l.maxSpread} limit`, false);
  if (ctx.stopPips != null && ctx.stopPips > l.maxStopPips) return no(`Stop ${Math.round(ctx.stopPips)} pips is wider than the ${l.maxStopPips}-pip limit`, false);
  return { ok: true, reason: "", hard: false };
}

/** A stop may only ever move toward the trade. This is the last guard before any modify request. */
export function stopMoveAllowed(side: Side, current: number, proposed: number): Gate {
  const tighter = side === "buy" ? proposed > current : proposed < current;
  return tighter ? { ok: true, reason: "", hard: false }
    : { ok: false, reason: "A stop may only move toward the trade, never away from it", hard: true };
}
