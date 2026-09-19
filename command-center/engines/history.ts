/**
 * WHAT ALREADY HAPPENED.
 *
 * THE BRAIN could describe the present in great detail and remembered nothing. Asked what gold did last
 * week it answered that the market was closed — true, irrelevant, and the giveaway that every question
 * was being routed through one live snapshot. A trader who cannot discuss last Tuesday is not a trader
 * you can talk to.
 *
 * This reads real bars for a real window and MEASURES what happened. Nothing here is generated prose:
 * every number is computed from the series, so the language model is describing arithmetic rather than
 * recalling an impression. That distinction is the whole reason this file exists — a system that can
 * invent last week's range is worse than one that admits it does not know.
 *
 * It deliberately does NOT read our own database. Those tables are empty: nothing has ever been written
 * to cc_snapshots or cc_brain_thesis, so "what did you think on Tuesday" genuinely has no answer yet and
 * must not be reconstructed from what the price did. Inventing a past opinion to match a known outcome
 * is the most dishonest thing a trading system can do.
 */
import { series, GOLD } from "../adapters/twelvedata";
import { PIP } from "../core/types";
import type { Bar, Timeframe } from "../core/types";

export type Window = {
  /** What the member said, so the answer can use their words back. */
  label: string;
  fromMs: number;
  toMs: number;
  /** The chart this window is best read on. A week is not a story told in one-minute bars. */
  tf: Timeframe;
  bars: number;
};

const DAY = 86_400_000;

/**
 * Turn a spoken phrase into a window.
 *
 * Returns null when the question is not about the past at all, which is most of them — this must not
 * fire on "what is gold doing", because a retrospective is slower and costs an API call.
 */
export function parseWindow(q: string, nowMs = Date.now()): Window | null {
  const t = q.toLowerCase();

  // "last week" means the week that finished, not the trailing seven days, because that is what a
  // person looking at a weekly candle means by it.
  if (/\b(last|past|previous)\s+week\b/.test(t) || /\bweek\s+(just\s+)?gone\b/.test(t)) {
    return { label: "last week", fromMs: nowMs - 7 * DAY, toMs: nowMs, tf: "4h", bars: 60 };
  }
  if (/\bthis\s+week\b/.test(t)) return { label: "this week", fromMs: nowMs - 5 * DAY, toMs: nowMs, tf: "1h", bars: 130 };
  if (/\b(yesterday|last\s+session)\b/.test(t)) return { label: "yesterday", fromMs: nowMs - 2 * DAY, toMs: nowMs, tf: "1h", bars: 50 };
  if (/\btoday\b/.test(t)) return { label: "today", fromMs: nowMs - DAY, toMs: nowMs, tf: "15m", bars: 100 };
  if (/\b(last|past|this)\s+(month|four\s+weeks)\b/.test(t)) return { label: "the last month", fromMs: nowMs - 31 * DAY, toMs: nowMs, tf: "1d", bars: 45 };
  if (/\b(last|past)\s+(few\s+)?(days|couple\s+of\s+days)\b/.test(t)) return { label: "the last few days", fromMs: nowMs - 4 * DAY, toMs: nowMs, tf: "1h", bars: 100 };
  if (/\b(last|past)\s+(three|3)\s+months\b/.test(t)) return { label: "the last three months", fromMs: nowMs - 93 * DAY, toMs: nowMs, tf: "1d", bars: 110 };
  if (/\b(this\s+)?year\b/.test(t)) return { label: "this year", fromMs: nowMs - 365 * DAY, toMs: nowMs, tf: "1d", bars: 400 };

  const n = t.match(/\b(?:last|past)\s+(\d{1,3})\s+(hour|day|week|month)s?\b/);
  if (n) {
    const count = Number(n[1]);
    const unit = n[2];
    const days = unit === "hour" ? count / 24 : unit === "day" ? count : unit === "week" ? count * 7 : count * 31;
    const tf: Timeframe = days <= 1 ? "15m" : days <= 5 ? "1h" : days <= 21 ? "4h" : "1d";
    return { label: `the last ${count} ${unit}${count === 1 ? "" : "s"}`, fromMs: nowMs - days * DAY, toMs: nowMs, tf, bars: 400 };
  }
  return null;
}

/** Does this question reach into the past at all? Cheap, and the gate on doing any of the above. */
export function isRetrospective(q: string, nowMs = Date.now()): boolean {
  return parseWindow(q, nowMs) !== null;
}

export type Retrospective = {
  label: string;
  tf: Timeframe;
  open: number; close: number; high: number; low: number;
  highAt: number; lowAt: number;
  movePips: number; movePct: number; rangePips: number;
  /** Where it finished inside its own range. 0 = on the lows, 1 = on the highs. */
  closeInRange: number;
  /** The single strongest and weakest periods, because "what happened" usually means "when". */
  bestBar: { at: number; pips: number } | null;
  worstBar: { at: number; pips: number } | null;
  /** Sessions that actually trended, measured rather than characterised. */
  direction: "up" | "down" | "sideways";
  bars: number;
  firstAt: number; lastAt: number;
};

/**
 * Measure a window.
 *
 * "Sideways" is not a hedge — it is what a net move smaller than a fifth of the range actually means:
 * the market covered ground and gave it back. Calling that a trend because the close was two dollars
 * higher would be the kind of false precision this system exists to avoid.
 */
export function measure(w: Window, all: Bar[]): Retrospective | null {
  const bars = all.filter((b) => b.t >= w.fromMs && b.t <= w.toMs).sort((a, b) => a.t - b.t);
  if (bars.length < 2) return null;

  const open = bars[0].o, close = bars[bars.length - 1].c;
  let high = -Infinity, low = Infinity, highAt = 0, lowAt = 0;
  let best: { at: number; pips: number } | null = null;
  let worst: { at: number; pips: number } | null = null;

  for (const b of bars) {
    if (b.h > high) { high = b.h; highAt = b.t; }
    if (b.l < low) { low = b.l; lowAt = b.t; }
    const d = (b.c - b.o) / PIP;
    if (!best || d > best.pips) best = { at: b.t, pips: d };
    if (!worst || d < worst.pips) worst = { at: b.t, pips: d };
  }

  const movePips = (close - open) / PIP;
  const rangePips = (high - low) / PIP;
  return {
    label: w.label, tf: w.tf,
    open, close, high, low, highAt, lowAt,
    movePips, movePct: ((close - open) / open) * 100, rangePips,
    closeInRange: high > low ? (close - low) / (high - low) : 0.5,
    bestBar: best, worstBar: worst,
    direction: Math.abs(movePips) < rangePips * 0.2 ? "sideways" : movePips > 0 ? "up" : "down",
    bars: bars.length, firstAt: bars[0].t, lastAt: bars[bars.length - 1].t,
  };
}

/** Fetch and measure. Returns null rather than a guess when the feed cannot supply the window. */
export async function lookBack(q: string, nowMs = Date.now()): Promise<Retrospective | null> {
  const w = parseWindow(q, nowMs);
  if (!w) return null;
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return null;
  const r = await series(w.tf, w.bars, key, GOLD);
  if (!r.ok) return null;
  return measure(w, r.data);
}

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const px = (n: number) => n.toFixed(2);
const pips = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n)}`;

/**
 * The window as lines the model may quote.
 *
 * Written as measurements with their timestamps attached, so an answer about last Tuesday can be
 * checked against the chart rather than taken on trust.
 */
export function retrospectiveLines(r: Retrospective): string[] {
  return [
    `=== WHAT GOLD DID — ${r.label.toUpperCase()} (measured from ${r.tf} bars, ${r.bars} of them) ===`,
    `window: ${when(r.firstAt)} → ${when(r.lastAt)}`,
    `opened ${px(r.open)}, closed ${px(r.close)} — ${pips(r.movePips)} pips (${r.movePct >= 0 ? "+" : ""}${r.movePct.toFixed(2)}%), net direction ${r.direction}`,
    `high ${px(r.high)} at ${when(r.highAt)}; low ${px(r.low)} at ${when(r.lowAt)}`,
    `total range ${Math.round(r.rangePips)} pips; it finished ${(r.closeInRange * 100).toFixed(0)}% of the way up that range`,
    r.bestBar ? `strongest single ${r.tf} period ${pips(r.bestBar.pips)} pips at ${when(r.bestBar.at)}` : "",
    r.worstBar ? `weakest single ${r.tf} period ${pips(r.worstBar.pips)} pips at ${when(r.worstBar.at)}` : "",
    `NOTE: this is measured price history. It is NOT a record of what THE BRAIN thought at the time — that was not being stored, so do not claim to have called any of it.`,
  ].filter(Boolean);
}
