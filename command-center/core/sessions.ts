/**
 * SESSIONS — gold's day has a shape: Asia accumulates, London expands, New York reverses.
 *
 * All boundaries are expressed in New York time because that is how the instrument's day is actually quoted
 * (18:00 Sunday open, 17:00–18:00 daily break). Deriving them from UTC offsets breaks twice a year.
 */
import type { Bar, Level, SessionName } from "./types";

// Formatters are built ONCE. Creating an Intl.DateTimeFormat per call (per bar, several times a second)
// is slow and allocates heavily — a replay of the engine grew to 4.6 GB in 500 steps because of it.
const NY_PARTS_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", weekday: "short", hour12: false });
const NY_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const nyParts = (ms: number) => {
  const f = NY_PARTS_FMT;
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: String(p.weekday) };
};

export function sessionAt(ms: number): SessionName {
  const { hour, weekday } = nyParts(ms);
  if (weekday === "Sat") return "closed";
  if (weekday === "Sun") return hour >= 18 ? "asia" : "closed";
  if (weekday === "Fri" && hour >= 17) return "closed";
  if (hour >= 17 && hour < 18) return "closed";          // the daily break
  if (hour >= 18 || hour < 3) return "asia";
  if (hour >= 3 && hour < 8) return "london";
  return "new_york";                                      // 08:00–17:00 NY
}

/** Minutes since this session began — a breakout 4 minutes into London is not the same trade as one 4 hours in. */
export function minutesIntoSession(ms: number): number {
  const { hour, minute } = nyParts(ms);
  const s = sessionAt(ms);
  const startHour = s === "asia" ? 18 : s === "london" ? 3 : s === "new_york" ? 8 : hour;
  let h = hour - startHour;
  if (h < 0) h += 24;
  return h * 60 + minute;
}

export const marketOpen = (ms: number): boolean => sessionAt(ms) !== "closed";

/** Session and day levels built from bars — no constants, no assumptions about when "yesterday" was. */
export function sessionLevels(bars: Bar[], nowMs: number): Level[] {
  if (!bars.length) return [];
  const dayKey = (ms: number) => NY_DAY_FMT.format(new Date(ms));
  const today = dayKey(nowMs);
  const byDay = new Map<string, Bar[]>();
  for (const b of bars) { const k = dayKey(b.t); const l = byDay.get(k) ?? []; l.push(b); byDay.set(k, l); }
  const days = [...byDay.keys()].sort();
  const prev = days.filter((d) => d < today).pop();
  const out: Level[] = [];

  const push = (kind: Level["kind"], label: string, price: number | undefined) => {
    if (price != null && Number.isFinite(price)) out.push({ price: +price.toFixed(2), kind, label });
  };
  const hi = (bs: Bar[]) => Math.max(...bs.map((b) => b.h));
  const lo = (bs: Bar[]) => Math.min(...bs.map((b) => b.l));

  const todayBars = byDay.get(today) ?? [];
  if (todayBars.length) { push("dh", "today's high", hi(todayBars)); push("dl", "today's low", lo(todayBars)); push("daily_open", "daily open", todayBars[0].o); }
  if (prev) { const p = byDay.get(prev)!; push("pdh", "yesterday's high", hi(p)); push("pdl", "yesterday's low", lo(p)); }

  for (const [name, kindHi, kindLo] of [["asia", "asia_high", "asia_low"], ["london", "london_high", "london_low"], ["new_york", "ny_high", "ny_low"]] as const) {
    const bs = todayBars.filter((b) => sessionAt(b.t) === name);
    if (bs.length) { push(kindHi, `${name.replace("_", " ")} high`, hi(bs)); push(kindLo, `${name.replace("_", " ")} low`, lo(bs)); }
  }
  return out;
}

/** Annotate levels with their distance from price in ATR units, nearest first. */
export function withDistance(levels: Level[], price: number, atr: number): Level[] {
  if (!(atr > 0)) return levels;
  return levels
    .map((l) => ({ ...l, distanceAtr: +(Math.abs(l.price - price) / atr).toFixed(2) }))
    .sort((a, b) => (a.distanceAtr ?? 99) - (b.distanceAtr ?? 99));
}

/**
 * THE LAST THIRTY MINUTES BEFORE THE FRIDAY CLOSE ARE NOT FOR OPENING ANYTHING.
 *
 * Lifted from FLOW's `inWeekendCloseWindow`, which applies it to every automated path on the desk, so
 * the Command Center now closes its entry window at the same moment rather than a different one. A
 * position opened at 4:45pm New York on a Friday has fifteen minutes to work and then carries a
 * two-day gap it cannot be managed through.
 *
 * ENTRIES ONLY. Nothing here stops an open position from being managed, protected or closed — those
 * paths matter most in exactly this window.
 *
 * The UTC fallback exists because some ICU builds report midnight as hour "24"; it is the same window
 * against the 22:00 UTC close.
 */
export function inWeekendCloseWindow(d: Date = new Date()): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    if (get("weekday") !== "Fri") return false;
    const h = Number(get("hour")) % 24;
    const m = Number(get("minute"));
    return h > 16 || (h === 16 && m >= 30);
  } catch {
    return d.getUTCDay() === 5 && (d.getUTCHours() > 21 || (d.getUTCHours() === 21 && d.getUTCMinutes() >= 30));
  }
}
