/**
 * WHAT THIS ACCOUNT HAS ACTUALLY DONE TODAY.
 *
 * The risk engine has always had limits for a losing day — 3% daily loss, 4% drawdown from the day's
 * peak, 6% on the week, a stop after four losses in a row, a session trade count, a cooldown between
 * entries. Every one of them was dead, because the validator built the account state it checks them
 * against out of hardcoded zeros:
 *
 *     dayPnlPct: 0, dayPeakEquity: i.equity, weekPnlPct: 0,
 *     consecutiveLosses: 0, tradesThisSession: 0, lastTradeAtMs: null,
 *
 * A limit compared against a constant zero can never fire. So the only thing actually restraining the
 * autopilot was a fixed count of entries per day — a brake that stops a good day at four trades and
 * does nothing whatsoever about a bad one. This file supplies the real numbers so the limits that were
 * written to protect the account can do it.
 *
 * IT FAILS CLOSED. If the history cannot be read, `readable` is false and the caller must refuse the
 * trade. A system that cannot tell whether it has lost three percent today has no business deciding
 * whether it may lose more. That is the standing rule for stale data here and it applies most of all
 * to the numbers the safety limits are made of.
 *
 * It reads. It never writes, and it never touches a broker.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "../adapters/db";

export type TradingHistory = {
  /** False when the history could not be read. The caller MUST treat this as a refusal. */
  readable: boolean;
  /** Closed-trade money since 00:00 UTC. Negative is a losing day. */
  dayPnl: number;
  /** Closed-trade money since the start of the trading week (Sunday 00:00 UTC). */
  weekPnl: number;
  /** The day's high-water equity, reconstructed from the equity curve of closed trades. */
  dayPeakEquity: number;
  /** How many losing trades in a row, most recent first. Reset by any winner. */
  consecutiveLosses: number;
  /** Positions opened on this account since 00:00 UTC. */
  tradesToday: number;
  /** When this account last OPENED a trade, for the cooldown. */
  lastTradeAtMs: number | null;
  /** Entries opened on this account in the last rolling hour — FLOW's max_orders_per_hour equivalent. */
  entriesLastHour: number;
  /** When the most recent LOSING trade closed. Null when there is none. Drives the conservative
   *  cool-down: a streak only holds an account while the last loss is still recent (09-22). */
  lastLossAtMs: number | null;
};

/** What a caller gets when nothing can be read. Every field is the one that blocks. */
export const UNREADABLE: TradingHistory = {
  readable: false,
  dayPnl: 0, weekPnl: 0, dayPeakEquity: 0,
  consecutiveLosses: 0, tradesToday: 0, lastTradeAtMs: null, entriesLastHour: 0, lastLossAtMs: null,
};

const startOfUtcDay = (now = Date.now()): Date => {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/**
 * The trading week starts on Sunday, because gold does. A Monday-anchored week would let a bad Sunday
 * night session disappear from the weekly limit a few hours after it happened.
 */
const startOfTradingWeek = (now = Date.now()): Date => {
  const d = startOfUtcDay(now);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
};

type PositionRow = { id: string; opened_at: string | null; closed_at: string | null };
type ReportRow = { position_id: string; pnl: number | null; closed_at: string | null };

/**
 * THE ARITHMETIC, SEPARATED FROM THE DATABASE.
 *
 * Everything the safety limits depend on is computed here, from plain arrays, so it can be tested
 * without a broker or a database. The function above it only fetches rows.
 */
export function summarise(input: {
  openedAtMs: number[];
  closed: { at: number; pnl: number }[];
  equityNow: number;
  now?: number;
}): TradingHistory {
  const now = input.now ?? Date.now();
  const dayStart = startOfUtcDay(now).getTime();

  const opened = input.openedAtMs.filter((n) => Number.isFinite(n));
  const lastTradeAtMs = opened.length ? Math.max(...opened) : null;
  const tradesToday = opened.filter((t) => t >= dayStart).length;
  const entriesLastHour = opened.filter((t) => t >= now - 3600_000).length;

  const closed = [...input.closed].filter((r) => Number.isFinite(r.at) && Number.isFinite(r.pnl)).sort((a, b) => a.at - b.at);
  const today = closed.filter((r) => r.at >= dayStart);
  const dayPnl = today.reduce((s, r) => s + r.pnl, 0);
  const weekPnl = closed.reduce((s, r) => s + r.pnl, 0);

  const dayStartEquity = input.equityNow - dayPnl;
  let running = dayStartEquity;
  let peak = Math.max(dayStartEquity, input.equityNow);
  for (const r of today) {
    running += r.pnl;
    if (running > peak) peak = running;
  }

  let consecutiveLosses = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    if (closed[i].pnl < 0) consecutiveLosses++;
    else break;
  }
  const losses = closed.filter((r) => r.pnl < 0).map((r) => r.at);
  const lastLossAtMs = losses.length ? Math.max(...losses) : null;

  return {
    readable: true,
    dayPnl: +dayPnl.toFixed(2),
    weekPnl: +weekPnl.toFixed(2),
    dayPeakEquity: +peak.toFixed(2),
    consecutiveLosses,
    tradesToday,
    lastTradeAtMs,
    entriesLastHour,
    lastLossAtMs,
  };
}

/**
 * Read this account's recent trading.
 *
 * `equityNow` is the broker's current equity, used to reconstruct where the day started: the account
 * began the day at (equity now − what it has made or lost since midnight), which is the only honest
 * denominator for a daily percentage.
 */
export async function accountHistory(
  userId: string,
  accountRowId: string,
  equityNow: number,
): Promise<TradingHistory> {
  const c: SupabaseClient | null = db();
  if (!c || !accountRowId || !(equityNow > 0)) return UNREADABLE;

  const dayStart = startOfUtcDay();
  const weekStart = startOfTradingWeek();

  try {
    /*
     * cc_trade_reports HAS NO ACCOUNT COLUMN. It keys on position_id, so the account filter has to go
     * through cc_positions first. Checked against the live schema rather than assumed — the last time
     * a column was assumed here, every interlock query threw and silently blocked every entry.
     */
    const { data: posData, error: posErr } = await c
      .from("cc_positions")
      .select("id, opened_at, closed_at")
      .eq("user_id", userId)
      .eq("account_row_id", accountRowId)
      .gte("opened_at", weekStart.toISOString())
      .limit(500);
    if (posErr) return UNREADABLE;

    const positions = (posData ?? []) as PositionRow[];

    const openedMs = positions
      .map((p) => (p.opened_at ? Date.parse(p.opened_at) : NaN))
      .filter((n) => Number.isFinite(n));

    if (!positions.length) {
      // Nothing traded this week. Readable, and every counter is genuinely zero.
      return { readable: true, dayPnl: 0, weekPnl: 0, dayPeakEquity: equityNow, consecutiveLosses: 0, tradesToday: 0, lastTradeAtMs: null, entriesLastHour: 0, lastLossAtMs: null };
    }

    const { data: repData, error: repErr } = await c
      .from("cc_trade_reports")
      .select("position_id, pnl, closed_at")
      .eq("user_id", userId)
      .in("position_id", positions.map((p) => p.id))
      .limit(500);
    if (repErr) return UNREADABLE;

    const closed = ((repData ?? []) as ReportRow[])
      .filter((r) => r.closed_at && r.pnl != null && Number.isFinite(Number(r.pnl)))
      .map((r) => ({ at: Date.parse(r.closed_at as string), pnl: Number(r.pnl) }))
      .filter((r) => Number.isFinite(r.at));

    return summarise({ openedAtMs: openedMs, closed, equityNow });
  } catch {
    return UNREADABLE;
  }
}

/** The day's move as a percentage of where the day started — not of where it ended. */
export function dayPnlPct(h: TradingHistory, equityNow: number): number {
  const start = equityNow - h.dayPnl;
  return start > 0 ? +((h.dayPnl / start) * 100).toFixed(3) : 0;
}

/** The week's move as a percentage of where the week started. */
export function weekPnlPct(h: TradingHistory, equityNow: number): number {
  const start = equityNow - h.weekPnl;
  return start > 0 ? +((h.weekPnl / start) * 100).toFixed(3) : 0;
}
