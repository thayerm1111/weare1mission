/**
 * NEW YORK CLOCK for the FX market's day and week. Pure (uses the runtime's time-zone database).
 *
 *   • The FX trading day runs 17:00 → 17:00 New York; the daily loss limit is measured over it.
 *   • No NEW entries (open positions are still managed) around the daily rollover, from the Friday
 *     cutoff to the Sunday reopen plus a short delay, and on Saturday. Spreads at the rollover and the
 *     reopen are routinely many pips wide, and a 2-minute trade opened minutes before the weekly close
 *     could be left open over the weekend if the market shuts before its time exit.
 */

const FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export type NyParts = { y: number; mo: number; d: number; h: number; mi: number; s: number; dow: number };

export function nyParts(ms: number): NyParts {
  const parts = Object.fromEntries(FMT.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day),
    h: Number(parts.hour) % 24, mi: Number(parts.minute), s: Number(parts.second),
    dow: DOW[parts.weekday as string] ?? 0,
  };
}

/** UTC milliseconds of a New York wall-clock time. */
export function nyToUtc(y: number, mo: number, d: number, h: number, mi: number): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const p = nyParts(guess);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    const diff = shown - asUtc;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

/** The start (17:00 New York) of the FX trading day containing `ms`. */
export function fxDayStart(ms: number): number {
  const p = nyParts(ms);
  const today = nyToUtc(p.y, p.mo, p.d, 17, 0);
  if (ms >= today) return today;
  const y = new Date(Date.UTC(p.y, p.mo - 1, p.d) - 86_400_000);
  return nyToUtc(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate(), 17, 0);
}

/** The FX trading day's label: the New York date on which it ENDS (a day starting Monday 17:00 is Tuesday's). */
export function fxDayKey(ms: number): string {
  // 24 hours after 17:00 is 16:00–18:00 the next day across a clock change — the same date either way.
  const end = nyParts(fxDayStart(ms) + 86_400_000);
  return `${end.y}-${String(end.mo).padStart(2, "0")}-${String(end.d).padStart(2, "0")}`;
}

const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Why new entries are not allowed right now on the New York clock, or null. */
export function entryBlackout(ms: number, s: { rolloverStart: string; rolloverEnd: string; fridayCutoff: string; sundayOpenDelayMin: number }): string | null {
  const p = nyParts(ms);
  const now = p.h * 60 + p.mi;
  if (p.dow === 6) return "The market is closed for the weekend.";
  if (p.dow === 0 && now < 17 * 60 + s.sundayOpenDelayMin) return `The market reopens Sunday 17:00 New York; entries start ${s.sundayOpenDelayMin} minutes after.`;
  if (p.dow === 5 && now >= mins(s.fridayCutoff)) return `No new entries after ${s.fridayCutoff} New York on Friday (weekly close).`;
  const a = mins(s.rolloverStart), b = mins(s.rolloverEnd);
  const inRoll = a <= b ? now >= a && now < b : now >= a || now < b;
  if (inRoll) return `Daily rollover (${s.rolloverStart}–${s.rolloverEnd} New York): spreads widen.`;
  return null;
}
