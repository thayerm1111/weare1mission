/**
 * Timezone helpers for the weekly schedule.
 * Converts a recurring "HH:MM" time in a source IANA timezone into the
 * visitor's local time using the browser Internationalization API.
 */
const DAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
};

/** Get the visitor's IANA timezone, e.g. "America/Los_Angeles". */
export function getLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Given a day + "HH:MM" in `sourceTimeZone`, return the visitor's local
 * day + formatted time. Uses the current week for an accurate DST-aware offset.
 */
export function convertToLocal(
  day: string,
  time: string,
  sourceTimeZone: string
): { localDay: string; localTime: string; sourceTime: string } {
  const [h, m] = time.split(":").map(Number);
  const now = new Date();

  // Build a date for the requested day in the current week.
  const target = new Date(now);
  const currentDow = now.getDay();
  const desiredDow = DAY_INDEX[day] ?? 0;
  target.setDate(now.getDate() + ((desiredDow - currentDow + 7) % 7));

  // Interpret h:m as a wall-clock time in the source timezone by computing
  // the source zone's offset for that date, then constructing a UTC instant.
  const iso = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
  const utcGuess = new Date(`${iso}T${pad(h)}:${pad(m)}:00Z`);
  const offsetMin = tzOffsetMinutes(utcGuess, sourceTimeZone);
  const instant = new Date(utcGuess.getTime() - offsetMin * 60000);

  const localTime = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);

  const localDay = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(instant);

  const sourceTime = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: sourceTimeZone,
    timeZoneName: "short",
  }).format(instant);

  return { localDay, localTime, sourceTime };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Offset (in minutes) of `timeZone` at the given instant. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
  const asUTC = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return (asUTC - date.getTime()) / 60000;
}

/** Build a Google Calendar "add event" URL for a schedule item (next occurrence). */
export function googleCalendarUrl(title: string, details: string, day: string, time: string): string {
  const [h, m] = time.split(":").map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setDate(now.getDate() + ((DAY_INDEX[day] - now.getDay() + 7) % 7));
  target.setHours(h, m, 0, 0);
  const end = new Date(target.getTime() + 60 * 60000);
  const fmt = (d: Date) =>
    d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    details,
    dates: `${fmt(target)}/${fmt(end)}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
