/**
 * MATTY PIPS — trading-session context for gold. Pure function of the clock
 * and the 15M candles: which session is live, how deep into it we are, the
 * session's high/low so far (untouched extremes = resting liquidity), and a
 * 0–1 liquidity-quality figure the scorer can use. UTC throughout.
 */
import type { Candle } from "./types";

export type SessionName = "ASIA" | "LONDON" | "LONDON_NY_OVERLAP" | "NEW_YORK" | "LATE_NY" | "DEAD_ZONE";

export type SessionRead = {
  name: SessionName;
  label: string;                 // human label for the card
  minutesIn: number;
  sessionHigh: number | null;    // high/low since THIS session opened
  sessionLow: number | null;
  liquidityQuality: number;      // 0–1: how much real participation to expect
  note: string;
};

/** UTC session windows (hour boundaries). Gold's liquidity map, not equities'. */
const WINDOWS: { name: SessionName; label: string; from: number; to: number; lq: number }[] = [
  { name: "ASIA", label: "Asia", from: 23, to: 7, lq: 0.35 },
  { name: "LONDON", label: "London", from: 7, to: 12, lq: 0.8 },
  { name: "LONDON_NY_OVERLAP", label: "London/NY overlap", from: 12, to: 16, lq: 1.0 },
  { name: "NEW_YORK", label: "New York", from: 16, to: 20, lq: 0.75 },
  { name: "LATE_NY", label: "Late NY", from: 20, to: 21, lq: 0.4 },
  { name: "DEAD_ZONE", label: "Rollover", from: 21, to: 23, lq: 0.15 },
];

function windowFor(hour: number) {
  for (const w of WINDOWS) {
    if (w.from < w.to ? hour >= w.from && hour < w.to : hour >= w.from || hour < w.to) return w;
  }
  return WINDOWS[0];
}

/** Session read at `nowMs` (defaults to the clock) over closed 15M candles. */
export function readSession(m15: Candle[], nowMs?: number): SessionRead {
  const now = nowMs ?? Date.now();
  const d = new Date(now);
  const w = windowFor(d.getUTCHours());

  // Session open: today at w.from UTC (yesterday if the window wraps midnight).
  const open = new Date(now);
  open.setUTCHours(w.from, 0, 0, 0);
  if (open.getTime() > now) open.setUTCDate(open.getUTCDate() - 1);
  const openMs = open.getTime();
  const minutesIn = Math.max(0, Math.round((now - openMs) / 60000));

  const inSession = m15.filter((c) => c.t >= openMs && c.t <= now);
  const sessionHigh = inSession.length ? Math.max(...inSession.map((c) => c.h)) : null;
  const sessionLow = inSession.length ? Math.min(...inSession.map((c) => c.l)) : null;

  const note =
    w.name === "LONDON_NY_OVERLAP" ? "Both books open — the day's real moves usually start here." :
    w.name === "LONDON" ? "London driving — expect the Asia range to get tested." :
    w.name === "NEW_YORK" ? "New York in control — continuation or reversal of London's push." :
    w.name === "ASIA" ? "Asia hours — thinner tape, ranges and level-to-level moves." :
    w.name === "LATE_NY" ? "Late NY — participation fading, moves lose follow-through." :
    "Rollover — spreads widen, prints get noisy. Patience beats action here.";

  return { name: w.name, label: w.label, minutesIn, sessionHigh, sessionLow, liquidityQuality: w.lq, note };
}
