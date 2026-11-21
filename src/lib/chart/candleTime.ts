/**
 * CANDLE TIMES — what instant a candle's stamp names, and how that is said to the member.
 *
 * WHY THIS EXISTS (11-21 data audit). Twelve Data stamps a series in the clock it is asked for. Asked for
 * nothing, it stamped gold in Australia/Sydney time: the 15-minute candle that opened at 06:45 UTC on
 * 21 Nov arrived as "2026-11-21 17:45:00", and the gap moved from 10 to 11 hours on 4 Oct, when Sydney's
 * summer time began (floor_setup_history, every week since September). The Floor's chart therefore could
 * not print a clock time, and said "3 h ago" instead. The chart's candles are now asked for in UTC and
 * say so (`candlesTz: "UTC"`); older answers and saved snapshots without that mark keep their stamps and
 * are shown with distances between candles only — never with a clock time that might be wrong.
 *
 * Nothing is moved, merged or filled here: a stamp is read, a duplicate is dropped (the later answer
 * wins), and the order is made oldest → newest. A candle that is not a candle is left out.
 */
import { realCandles, agoText, type ChartCandle } from "@/lib/floor/chart";

export type TimedBar = { t: number; o: number; h: number; l: number; c: number };

/** A stamp as milliseconds, reading a zone-less "YYYY-MM-DD HH:MM[:SS]" as UTC. NaN when unreadable. */
export function stampMs(t: unknown): number {
  if (typeof t === "number") return Number.isFinite(t) ? t : NaN;
  const s = String(t ?? "").trim();
  if (!s) return NaN;
  if (/^\d{10,13}$/.test(s)) { const n = Number(s); return s.length === 10 ? n * 1000 : n; }
  return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
}

/**
 * The candles as the chart draws them: real candles only, stamped in milliseconds, oldest first, one per
 * stamp. `known` is true only when the stamps name real instants (the answer said they are UTC).
 */
export function timedBars(raw: unknown, tz: unknown): { bars: TimedBar[]; known: boolean; dropped: number } {
  const cs: ChartCandle[] = realCandles(raw);
  const byT = new Map<number, TimedBar>();
  let bad = Array.isArray(raw) ? raw.length - cs.length : 0;
  for (const k of cs) {
    const t = stampMs(k.t);
    if (!Number.isFinite(t)) { bad += 1; continue; }
    if (byT.has(t)) bad += 1;                       // the same candle twice: the later answer stands
    byT.set(t, { t, o: k.o, h: k.h, l: k.l, c: k.c });
  }
  const bars = [...byT.values()].sort((a, b) => a.t - b.t);
  return { bars, known: tz === "UTC" && bars.length > 0, dropped: bad };
}

/** The member's own clock, with its zone's short name ("14:45 CST"). */
export function clockText(ms: number, withZone = true): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, ...(withZone ? { timeZoneName: "short" } : {}) }).format(new Date(ms));
  } catch { return new Date(ms).toISOString().slice(11, 16) + " UTC"; }
}

/** "Fri 20 Nov" in the member's clock. */
export function dayText(ms: number): string {
  try { return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date(ms)); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
}

/** A candle's time for the readout: "Fri 20 Nov · 14:45 CST", or how far before the newest candle it opened. */
export function candleTimeText(t: number, known: boolean, newestT: number): string {
  if (known) return `${dayText(t)} · ${clockText(t)}`;
  const d = newestT - t;
  return d <= 0 ? "Newest candle" : `${agoText(d)} before the newest candle`;
}

/** Axis marks across the visible candles: clock times within a day or two, dates beyond; distances when the clock is unknown. */
export function axisMarks(bars: readonly TimedBar[], i0: number, i1: number, want: number, known: boolean): { i: number; text: string }[] {
  if (i1 - i0 < 2) return [];
  const every = Math.max(1, Math.round((i1 - i0) / Math.max(1, want)));
  const spanMs = bars[i1].t - bars[i0].t;
  const newest = bars[bars.length - 1].t;
  const out: { i: number; text: string }[] = [];
  for (let i = i0 + every; i < i1; i += every) {
    const t = bars[i].t;
    if (!known) { const d = newest - t; out.push({ i, text: d <= 0 ? "Newest" : `${agoText(d)} ago` }); continue; }
    out.push({ i, text: spanMs > 2.5 * 86_400_000 ? dayText(t) : clockText(t, false) });
  }
  return out;
}
