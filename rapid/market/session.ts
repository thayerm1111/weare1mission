/**
 * Broker-aligned session calendar, DST-aware.
 *
 * "Daily" means the broker's session candle, not a rolling 24 hours and not a UTC midnight day.
 * For spot gold the usual convention is a rollover at 17:00 America/New_York, a one-hour daily
 * maintenance break, a weekly open on Sunday evening and a weekly close on Friday afternoon.
 *
 * The rollover hour is configurable because it is a BROKER property, not a fact about gold. Where a
 * broker publishes its own session schedule that must win; this module is the fallback and the thing
 * the replay harness uses.
 */

export type SessionConfig = {
  /** IANA zone the rollover is expressed in. */
  zone: string;
  /** Local hour at which one trading day ends and the next begins. */
  rolloverHour: number;
  /** Minutes of maintenance break starting at the rollover. */
  breakMinutes: number;
  /** Local weekday/hour the week opens (0 = Sunday). */
  weekOpenDay: number;
  weekOpenHour: number;
  weekCloseDay: number;
  weekCloseHour: number;
  /** ISO dates (YYYY-MM-DD, in `zone`) on which the market is closed all day. */
  holidays: string[];
};

export const GOLD_SESSION: SessionConfig = {
  zone: "America/New_York",
  rolloverHour: 17,
  breakMinutes: 60,
  weekOpenDay: 0,
  weekOpenHour: 18,
  weekCloseDay: 5,
  weekCloseHour: 17,
  holidays: [],
};

const partsCache = new Map<string, Intl.DateTimeFormat>();
function fmt(zone: string): Intl.DateTimeFormat {
  let f = partsCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    partsCache.set(zone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

/** Wall-clock parts of `ms` in `zone`. Handles DST because Intl does. */
export function localParts(ms: number, zone: string): LocalParts {
  const p = fmt(zone).formatToParts(new Date(ms));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

export const isoDate = (ms: number, zone: string): string => {
  const p = localParts(ms, zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

/**
 * The trading day `ms` belongs to, labelled by the ISO date it CLOSES on. A bar at 18:00 Monday NY
 * belongs to Tuesday's session candle under a 17:00 rollover.
 */
export function tradingDay(ms: number, cfg: SessionConfig = GOLD_SESSION): string {
  const p = localParts(ms, cfg.zone);
  const advance = p.hour >= cfg.rolloverHour ? 1 : 0;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + advance));
  return d.toISOString().slice(0, 10);
}

/** ISO week label (`2026-W39`) of the trading week `ms` belongs to. */
export function tradingWeek(ms: number, cfg: SessionConfig = GOLD_SESSION): string {
  const day = tradingDay(ms, cfg);
  const d = new Date(`${day}T00:00:00Z`);
  // Shift to the Thursday of this ISO week, then take its year and week number.
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fdow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdow + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type SessionState =
  | { open: true; reason: "open" }
  | { open: false; reason: "weekend" | "daily_break" | "holiday" };

export function sessionState(ms: number, cfg: SessionConfig = GOLD_SESSION): SessionState {
  const p = localParts(ms, cfg.zone);
  if (cfg.holidays.includes(isoDate(ms, cfg.zone))) return { open: false, reason: "holiday" };

  // Weekend: from Friday close to Sunday open.
  const afterFridayClose = p.weekday === cfg.weekCloseDay && p.hour >= cfg.weekCloseHour;
  const saturday = p.weekday === 6;
  const beforeSundayOpen = p.weekday === cfg.weekOpenDay && p.hour < cfg.weekOpenHour;
  if (afterFridayClose || saturday || beforeSundayOpen) return { open: false, reason: "weekend" };

  // Daily maintenance break at the rollover.
  const minutesIntoDay = p.hour * 60 + p.minute;
  const breakStart = cfg.rolloverHour * 60;
  if (minutesIntoDay >= breakStart && minutesIntoDay < breakStart + cfg.breakMinutes) {
    return { open: false, reason: "daily_break" };
  }
  return { open: true, reason: "open" };
}

export const isSessionOpen = (ms: number, cfg: SessionConfig = GOLD_SESSION) => sessionState(ms, cfg).open;

/** Minutes until the next close (daily break or weekly close), or null when already closed. */
export function minutesToSessionEnd(ms: number, cfg: SessionConfig = GOLD_SESSION): number | null {
  if (!isSessionOpen(ms, cfg)) return null;
  const step = 60_000;
  for (let i = 1; i <= 60 * 24 * 7; i++) {
    if (!isSessionOpen(ms + i * step, cfg)) return i;
  }
  return null;
}

/**
 * Split a bar series into completed session days. The DEVELOPING day is returned separately and is
 * never treated as a completed prior-day level.
 */
export function splitSessionDays<T extends { t: number }>(
  bars: T[],
  now: number,
  cfg: SessionConfig = GOLD_SESSION,
): { completed: Array<{ day: string; bars: T[] }>; developing: { day: string; bars: T[] } | null } {
  const byDay = new Map<string, T[]>();
  for (const b of bars) {
    const d = tradingDay(b.t, cfg);
    const arr = byDay.get(d);
    if (arr) arr.push(b);
    else byDay.set(d, [b]);
  }
  const today = tradingDay(now, cfg);
  const completed: Array<{ day: string; bars: T[] }> = [];
  let developing: { day: string; bars: T[] } | null = null;
  for (const [day, arr] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (day === today) developing = { day, bars: arr };
    else completed.push({ day, bars: arr });
  }
  return { completed, developing };
}
