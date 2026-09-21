/**
 * THE ECONOMIC CALENDAR.
 *
 * Gold trades on rate expectations, and rate expectations move on scheduled releases. Without a
 * calendar ATLAS could explain how CPI affects gold and had no idea when CPI was — which is the
 * difference between a textbook and a trading desk. Worse, the snapshot has always carried a `news`
 * field that nothing ever populated, so the news lockout that is supposed to keep the system out of
 * the market around a release has never once fired.
 *
 * IT READS THE PRIMARY SOURCES. The Federal Reserve publishes its own meeting calendar; the Bureau of
 * Labor Statistics publishes the date and time of every CPI, PPI and payrolls print. These are the
 * organisations that create the events — nothing is closer to the truth, it is public domain, it needs
 * no key, and no vendor can withdraw it. The first version of this called a commercial API and came
 * back 403 on a free key, which was the right failure to have early: a control that stops real money
 * should never have sat behind somebody's free tier.
 *
 * WHAT IS STILL MISSING, and the packet says so rather than implying otherwise: the street's CONSENSUS
 * forecast. The move on a release is driven by the surprise against consensus, and no official source
 * publishes what economists expected. That is the one thing here worth paying a vendor for.
 */

import { fedEvents, blsEvents, type EconEvent } from "./econCalendar";

export type { EconEvent };

/** Releases that actually move gold. Everything else is noise on this instrument. */
const MATTERS = /\b(fomc|federal funds|interest rate decision|fed chair|powell|cpi|consumer price|core pce|pce price|ppi|producer price|non[- ]?farm|nfp|unemployment rate|average hourly|jolts|gdp|retail sales|ism|michigan|jackson hole|beige book|treasury (auction|yield))\b/i;

/* ── the derived one ──────────────────────────────────────────────────── */

/**
 * Non-farm payrolls: first Friday of each month, 08:30 US Eastern.
 *
 * The rule is stable and published, so this is computed rather than guessed. The Eastern offset is
 * handled by finding the UTC instant whose Eastern wall-clock time is 08:30, which is the only way to
 * be right on both sides of a daylight-saving change without a timezone database.
 */
export function nextNfp(fromMs = Date.now()): EconEvent {
  const firstFridayOf = (year: number, month: number): Date => {
    const d = new Date(Date.UTC(year, month, 1));
    while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  };
  const at0830Eastern = (day: Date): number => {
    // Try both plausible offsets and keep the one that reads 08:30 in New York.
    for (const offset of [4, 5]) {
      const guess = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8 + offset, 30);
      const hhmm = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(guess));
      if (hhmm === "08:30") return guess;
    }
    return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12, 30);
  };

  const now = new Date(fromMs);
  let y = now.getUTCFullYear(), m = now.getUTCMonth();
  let at = at0830Eastern(firstFridayOf(y, m));
  if (at <= fromMs) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    at = at0830Eastern(firstFridayOf(y, m));
  }
  return { at, name: "US Non-Farm Payrolls", importance: "high", country: "US", source: "derived", timeKnown: true };
}

/* ── the published ones ───────────────────────────────────────────────── */

/*
 * OFFICIAL SOURCES, NOT A VENDOR.
 *
 * The first version of this called a commercial calendar API and came back 403 — the endpoint was
 * premium on a free key. That was the wrong shape of dependency regardless of price: this calendar
 * drives a LOCKOUT, and a control that stops real money should not sit behind a free tier, a rate
 * limit or a pricing change.
 *
 * The Federal Reserve and the Bureau of Labor Statistics publish the events they themselves create.
 * Public domain, no key, nothing a vendor can withdraw. A commercial feed can still be layered on
 * top for the one thing they do not publish — the street's consensus forecast — but nothing depends
 * on one being there.
 */
export type CalendarView = {
  events: EconEvent[];
  /** What the calendar actually knows, so an answer can be honest about its own blind spot. */
  source: "published" | "derived_only";
  next: EconEvent | null;
  minutesToNext: number | null;
  /** True inside the window where liquidity thins and the system refuses new entries. */
  inLockout: boolean;
};

/** Minutes either side of a high-impact release that count as the news window. */
export const LOCKOUT_BEFORE_MIN = 15;
export const LOCKOUT_AFTER_MIN = 10;

/**
 * What is coming, and whether we are inside a release window right now.
 *
 * Cached for five minutes: a calendar changes daily, not per tick, and burning a rate limit on
 * something this static would be the fastest way to lose the feed when it matters.
 */
let cache: { at: number; view: CalendarView } | null = null;

/*
 * THREE WEEKS, NOT ONE.
 *
 * The first window was eight days, and on a quiet stretch it returned nothing at all — technically
 * correct and useless, because "there is nothing scheduled" reads as "there is nothing coming" when
 * the real answer is that CPI is three weeks out and worth planning around. A trader holding a SWING
 * position needs to know what is between here and the exit, not only what is between here and Friday.
 */
export async function upcoming(nowMs = Date.now(), days = 21): Promise<CalendarView> {
  if (cache && nowMs - cache.at < 5 * 60_000) return cache.view;

  const toMs = nowMs + days * 86_400_000;
  let events: EconEvent[] = [];
  let source: CalendarView["source"] = "derived_only";

  /*
   * Both sources are asked in parallel and failure is per-source.
   *
   * If the Fed's file moves, payrolls and CPI still gate the lockout; if the BLS pages change shape,
   * the FOMC dates survive. Partial is much better than nothing for a control that blocks entries —
   * but a total failure must NOT silently look like a quiet week, which is why the derived payroll
   * date remains as the floor.
   */
  const [fed, bls] = await Promise.all([
    fedEvents().catch(() => [] as EconEvent[]),
    blsEvents().catch(() => [] as EconEvent[]),
  ]);

  if (fed.length || bls.length) {
    events = [...fed, ...bls].filter((e) => e.at >= nowMs - 86_400_000 && e.at <= toMs);
    source = "published";
  }

  if (source === "derived_only") {
    const nfp = nextNfp(nowMs);
    events = nfp.at <= toMs ? [nfp] : [];
  }

  events.sort((a, b) => a.at - b.at);
  const ahead = events.filter((e) => e.at >= nowMs);
  const next = ahead[0] ?? null;

  const inLockout = events.some((e) =>
    e.importance === "high" &&
    nowMs >= e.at - LOCKOUT_BEFORE_MIN * 60_000 &&
    nowMs <= e.at + LOCKOUT_AFTER_MIN * 60_000);

  const view: CalendarView = {
    events: ahead.slice(0, 12), source, next,
    minutesToNext: next ? Math.round((next.at - nowMs) / 60_000) : null,
    inLockout,
  };
  cache = { at: nowMs, view };
  return view;
}

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

/** The calendar as lines for the context packet, including what it does not know. */
export function calendarLines(v: CalendarView): string[] {
  const L = ["=== ECONOMIC CALENDAR ==="];
  if (v.source === "derived_only") {
    L.push("THE CALENDAR SOURCES ARE UNREACHABLE right now. The only event below is computed from a fixed published rule (payrolls is the first Friday of the month).");
    L.push("You do NOT know this week's FOMC, CPI or PPI dates. Say plainly that the calendar is not loading — never guess a date.");
  } else {
    L.push("Dates and times below are from the Federal Reserve and the Bureau of Labor Statistics themselves.");
    L.push("NOTE: you do NOT have the market's consensus forecast for any of these. A release moves gold through the SURPRISE against consensus, so you can say when a number lands and what it usually does, but never what it is expected to be.");
  }
  if (!v.events.length) {
    L.push(v.source === "published"
      ? "The calendar loaded and there is genuinely nothing scheduled in the next three weeks. That is a quiet run, not a missing feed — say it that way."
      : "nothing known.");
    return L;
  }
  for (const e of v.events) {
    L.push(`${when(e.at)} — ${e.name} (${e.importance}${e.country ? `, ${e.country}` : ""})${e.timeKnown ? "" : " — time not published, assumed"}`);
  }
  if (v.inLockout) L.push("RIGHT NOW you are inside a high-impact release window: liquidity is thin, spreads are wide, and new entries are refused.");
  else if (v.minutesToNext != null && v.minutesToNext <= 60) L.push(`next release in about ${v.minutesToNext} minutes.`);
  return L;
}
