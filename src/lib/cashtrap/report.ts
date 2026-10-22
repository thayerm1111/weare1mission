import type { Decision } from "./engine";
import type { SetupRecord } from "./replay";
import type { SignalRecord } from "./signals";

/**
 * PERFORMANCE REPORTING — per symbol, never pooled into one headline number.
 *
 * Win rate excludes ties and unresolved results. Net result is stated at an explicit payout r (net
 * profit per unit staked on a win; a loss loses one unit; a tie per the tie rule). Break-even win rate
 * excluding ties and costs is 1 / (1 + r): at an 80% payout, about 55.56%. A win rate above 50% is not
 * profitability. Agreement of related indicators ("5/5 conditions met") is confluence, not a
 * probability, and is never turned into one here.
 */
export const breakEvenWinRate = (r: number): number => 1 / (1 + r);

export type PeriodStats = {
  from: string | null;
  to: string | null;
  candlesDecided: number;
  dataUnavailable: number;
  setups: { armed: number; confirmed: number; cancelled: number; expired: number; confirmedNotPublished: number };
  signals: number;
  signalsPerTradingDay: number | null;
  missed: number;
  wins: number;
  losses: number;
  ties: number;
  unresolved: number;
  winRateExTies: number | null;
  longestLosingStreak: number;
  netAt: Array<{ payout: number; breakEvenWinRate: number; netUnits: number; perSignal: number | null }>;
};

export function periodStats(decisions: Decision[], setups: SetupRecord[], signals: SignalRecord[], payouts: number[], tieRule: "refund" | "loss"): PeriodStats {
  const ts = decisions.map((d) => d.candleT).sort((a, b) => a - b);
  const days = new Set(decisions.filter((d) => d.status !== "DATA_UNAVAILABLE").map((d) => new Date(d.candleT).toISOString().slice(0, 10)));
  const settled = signals.filter((s) => s.status === "settled").sort((a, b) => a.publishedAt - b.publishedAt);
  const wins = settled.filter((s) => s.result === "win").length;
  const losses = settled.filter((s) => s.result === "loss").length;
  const ties = settled.filter((s) => s.result === "tie").length;
  const unresolved = settled.filter((s) => s.result === "unresolved").length;
  let streak = 0, worst = 0;
  for (const s of settled) {
    if (s.result === "loss") { streak += 1; worst = Math.max(worst, streak); }
    else if (s.result === "win") streak = 0;
  }
  const decided = wins + losses;
  return {
    from: ts.length ? new Date(ts[0]).toISOString() : null,
    to: ts.length ? new Date(ts[ts.length - 1]).toISOString() : null,
    candlesDecided: decisions.length,
    dataUnavailable: decisions.filter((d) => d.status === "DATA_UNAVAILABLE").length,
    setups: {
      armed: setups.length,
      confirmed: setups.filter((s) => s.status === "confirmed" && s.published).length,
      cancelled: setups.filter((s) => s.status === "cancelled").length,
      expired: setups.filter((s) => s.status === "expired").length,
      confirmedNotPublished: setups.filter((s) => s.status === "confirmed" && !s.published).length,
    },
    signals: signals.length,
    signalsPerTradingDay: days.size ? +(signals.length / days.size).toFixed(2) : null,
    missed: signals.filter((s) => s.result === "missed").length,
    wins, losses, ties, unresolved,
    winRateExTies: decided ? +(wins / decided).toFixed(4) : null,
    longestLosingStreak: worst,
    netAt: payouts.map((r) => {
      const net = wins * r - losses + (tieRule === "loss" ? -ties : 0);
      const n = wins + losses + ties;
      return { payout: r, breakEvenWinRate: +breakEvenWinRate(r).toFixed(4), netUnits: +net.toFixed(4), perSignal: n ? +(net / n).toFixed(4) : null };
    }),
  };
}

/**
 * Chronological development / out-of-sample split: the first `devFraction` of the candle period is
 * development, the rest is the untouched out-of-sample period. Nothing is tuned on either — the rules
 * are fixed — so the split shows whether the behaviour holds up on data later than the rest.
 */
export function splitReport(decisions: Decision[], setups: SetupRecord[], signals: SignalRecord[], payouts: number[], tieRule: "refund" | "loss", devFraction = 0.7) {
  const ts = decisions.map((d) => d.candleT).sort((a, b) => a - b);
  if (!ts.length) return { cutoff: null, development: periodStats([], [], [], payouts, tieRule), outOfSample: periodStats([], [], [], payouts, tieRule), all: periodStats([], [], [], payouts, tieRule) };
  const cutoff = ts[0] + Math.floor((ts[ts.length - 1] - ts[0]) * devFraction);
  const before = (t: number) => t < cutoff;
  return {
    cutoff: new Date(cutoff).toISOString(),
    development: periodStats(decisions.filter((d) => before(d.candleT)), setups.filter((s) => before(s.exhaustionT)), signals.filter((s) => before(s.setupCandleT)), payouts, tieRule),
    outOfSample: periodStats(decisions.filter((d) => !before(d.candleT)), setups.filter((s) => !before(s.exhaustionT)), signals.filter((s) => !before(s.setupCandleT)), payouts, tieRule),
    all: periodStats(decisions, setups, signals, payouts, tieRule),
  };
}
