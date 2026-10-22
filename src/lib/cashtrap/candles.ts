import { candleExpected, isOpen } from "./marketHours";
import { SYMBOL_SPECS, type CashtrapSymbol } from "./symbols";

/**
 * CANDLES — standard OHLC 5-minute candles (never Heikin-Ashi).
 *
 * Boundaries: a candle is identified by its OPEN time `t`, in milliseconds UTC, on an exact 5-minute
 * boundary (t % 300 000 === 0). It covers [t, t + 5 min) and is complete at t + 5 min. The feed is
 * asked for UTC timestamps; a timestamp that is not on a 5-minute boundary is rejected, not rounded.
 */
export const M5 = 5 * 60_000;
export type Candle = { t: number; o: number; h: number; l: number; c: number };

/**
 * Only candles from trading hours. TwelveData also sends candles while the market is closed (weekend
 * bars with small moves, gold's 17:00–18:00 New York break — seen in its history 10-22); a normal
 * chart has none, so the engine never sees them: they are dropped before storing, when loading, and in replay.
 */
export function tradingCandles<T extends { t: number }>(symbol: CashtrapSymbol, candles: T[]): T[] {
  const hours = SYMBOL_SPECS[symbol].hours;
  return candles.filter((k) => isOpen(hours, k.t));
}

/** The candle slot (open time) containing an instant. */
export const slotOf = (ms: number): number => Math.floor(ms / M5) * M5;
/** When the candle that opens at `t` closes. */
export const closeOf = (t: number): number => t + M5;
/** The next 5-minute close after an instant. */
export const nextClose = (ms: number): number => slotOf(ms) + M5;

export type FeedRow = { datetime?: string; open?: string | number; high?: string | number; low?: string | number; close?: string | number };

export type NormalizeResult = { candles: Candle[]; issues: string[] };

/**
 * Parse and check a batch of feed rows (UTC datetimes "YYYY-MM-DD HH:MM:SS"). Returns candles sorted
 * oldest → newest, one per open time. A row with a bad timestamp or impossible prices is dropped and
 * reported; two DIFFERENT rows for one open time are a conflict: both are dropped and reported.
 * Duplicates that agree are merged silently. Order of arrival does not matter.
 */
export function normalizeRows(rows: FeedRow[]): NormalizeResult {
  const issues: string[] = [];
  const byT = new Map<number, Candle>();
  const conflicted = new Set<number>();
  for (const r of rows) {
    const t = Date.parse(String(r.datetime ?? "").trim().replace(" ", "T") + "Z");
    const o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close);
    if (!Number.isFinite(t)) { issues.push(`unreadable timestamp "${r.datetime}"`); continue; }
    if (t % M5 !== 0) { issues.push(`${new Date(t).toISOString()} is not on a 5-minute boundary`); continue; }
    const bad = ![o, h, l, c].every((n) => Number.isFinite(n) && n > 0) || h < Math.max(o, c) || l > Math.min(o, c) || h < l;
    if (bad) { issues.push(`${new Date(t).toISOString()} has impossible prices (o ${o} h ${h} l ${l} c ${c})`); continue; }
    const k: Candle = { t, o, h, l, c };
    const prev = byT.get(t);
    if (prev && (prev.o !== o || prev.h !== h || prev.l !== l || prev.c !== c)) { conflicted.add(t); continue; }
    byT.set(t, k);
  }
  for (const t of conflicted) { byT.delete(t); issues.push(`${new Date(t).toISOString()} arrived twice with different prices`); }
  return { candles: [...byT.values()].sort((a, b) => a.t - b.t), issues };
}

/**
 * Split a fetched series into completed candles and the one still forming. A candle counts as
 * COMPLETED only if it was fetched at least `settleMs` after it closed — before that the feed may still
 * be finishing it. Anything newer than the forming candle (clock skew) is discarded.
 */
export function splitCompleted(candles: Candle[], fetchedAt: number, settleMs: number): { completed: Candle[]; developing: Candle | null } {
  const completed: Candle[] = [];
  let developing: Candle | null = null;
  for (const k of candles) {
    if (closeOf(k.t) + settleMs <= fetchedAt) completed.push(k);
    else if (k.t <= fetchedAt && (!developing || k.t > developing.t)) developing = k;
  }
  // A candle that closed but is not yet settled is not "forming" either: it is simply not used yet.
  if (developing && closeOf(developing.t) <= fetchedAt) developing = null;
  return { completed, developing };
}

export type DataCheck = { ok: true } | { ok: false; reason: string };

/**
 * Is the history ending at candle index `i` reliable enough to decide on?
 *   • at least `minWarmup` completed candles up to and including i;
 *   • no unexpected gap in the last `contiguity` candle slots ending at candles[i] (a slot inside a
 *     market closure or the fx rollover may be empty).
 */
export function checkHistory(symbol: CashtrapSymbol, candles: Candle[], i: number, minWarmup: number, contiguity: number): DataCheck {
  if (i + 1 < minWarmup) return { ok: false, reason: `warming up: ${i + 1} of ${minWarmup} candles` };
  const hours = SYMBOL_SPECS[symbol].hours;
  const have = new Set<number>();
  for (let j = Math.max(0, i - contiguity - 2); j <= i; j++) have.add(candles[j].t);
  const end = candles[i].t;
  for (let s = 0; s < contiguity; s++) {
    const t = end - s * M5;
    if (!have.has(t) && candleExpected(hours, t)) return { ok: false, reason: `missing candle at ${new Date(t).toISOString().slice(11, 16)} UTC` };
  }
  return { ok: true };
}

/**
 * Is the live feed current? At `nowMs`, with the market open, the newest completed candle should be the
 * one that closed at the last 5-minute boundary (allowing `settleMs` for the feed to show it).
 */
export function liveFreshness(symbol: CashtrapSymbol, latestCompletedT: number | null, nowMs: number, settleMs: number): { open: boolean; ok: boolean; reason?: string; lagMs: number | null } {
  const hours = SYMBOL_SPECS[symbol].hours;
  const open = isOpen(hours, nowMs);
  const lagMs = latestCompletedT == null ? null : nowMs - closeOf(latestCompletedT);
  if (!open) return { open, ok: false, reason: "market closed", lagMs };
  if (latestCompletedT == null) return { open, ok: false, reason: "no candles from the feed", lagMs };
  // The candle that should be the newest completed one: the slot before the current one, unless it was not expected.
  let expectT = slotOf(nowMs - settleMs) - M5;
  for (let k = 0; k < 24 && !candleExpected(hours, expectT); k++) expectT -= M5;
  if (latestCompletedT >= expectT) return { open, ok: true, lagMs };
  return { open, ok: false, reason: `feed is behind: newest closed candle ${new Date(latestCompletedT).toISOString().slice(11, 16)} UTC`, lagMs };
}
