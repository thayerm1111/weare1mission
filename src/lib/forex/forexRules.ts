import { contractKey } from "@/lib/flow/sizing";
import {
  FOREX_PAIRS, FOREX_PIP, FOREX_MIN_STOP_PIPS, FOREX_RR_FLOOR,
  FOREX_SESSION_START_UTC, FOREX_SESSION_END_UTC,
} from "@/lib/forex/forexConfig";

/**
 * FOREX ENTRY RULES — the standalone forex strategy gates. Pure + unit-tested.
 *
 * Built specifically to NOT repeat the mixed-engine failures: no selling the bottom / buying the
 * top (trade WITH the higher-timeframe trend only), no thin-session entries, no noise-tight stops,
 * and no trade whose target is nearer than its stop (a real reward:risk floor). A setup must clear
 * EVERY gate to be actionable.
 */

export type ForexSide = "buy" | "sell";
export type ForexTrend = "bullish" | "bearish" | "ranging" | null;

/** Liquid London+NY window only (UTC). Skips the thin Asian / rollover hours. */
export function inForexSession(d: Date): boolean {
  const h = d.getUTCHours();
  return h >= FOREX_SESSION_START_UTC && h < FOREX_SESSION_END_UTC;
}

/** Trade only WITH a clear higher-timeframe trend. Ranging/unknown ⇒ stand aside. */
export function withForexTrend(side: ForexSide, trend: ForexTrend): boolean {
  if (side === "buy") return trend === "bullish";
  if (side === "sell") return trend === "bearish";
  return false;
}

/** Reward:risk from the actual entry/stop/tp (null when it can't be measured). */
export function forexRR(entry: number | null, stop: number | null, tp: number | null): number | null {
  if (entry == null || stop == null || tp == null) return null;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(tp - entry);
  if (!(risk > 0)) return null;
  return reward / risk;
}

/** Stop distance in pips for a pair. */
export function stopPipsFor(pair: string, entry: number, stop: number): number {
  const pip = FOREX_PIP[contractKey(pair)] ?? 0.0001;
  return Math.abs(entry - stop) / pip;
}

/**
 * The full gate: a forex setup is actionable only if the pair is enabled, we're in session, the
 * trade is with the trend, the stop is at least the minimum sane distance, and reward:risk clears
 * the floor. Returns the first failing reason so it's auditable.
 */
export function forexEntryGate(o: {
  pair: string; side: ForexSide; entry: number; stop: number; tp: number | null;
  trend: ForexTrend; at: Date;
}): { ok: boolean; reason: string } {
  if (!(FOREX_PAIRS as readonly string[]).includes(contractKey(o.pair))) return { ok: false, reason: "pair not enabled" };
  if (!inForexSession(o.at)) return { ok: false, reason: "outside London/NY session" };
  if (!withForexTrend(o.side, o.trend)) return { ok: false, reason: `against trend (${o.trend ?? "unknown"})` };

  const sp = stopPipsFor(o.pair, o.entry, o.stop);
  if (sp < FOREX_MIN_STOP_PIPS) return { ok: false, reason: `stop ${sp.toFixed(1)}p < ${FOREX_MIN_STOP_PIPS}p (noise)` };

  const rr = forexRR(o.entry, o.stop, o.tp);
  if (rr == null) return { ok: false, reason: "no target" };
  if (rr < FOREX_RR_FLOOR) return { ok: false, reason: `R:R ${rr.toFixed(2)} < ${FOREX_RR_FLOOR}` };

  return { ok: true, reason: "ok" };
}
