/**
 * THE ECONOMIC CALENDAR, FROM THE PEOPLE WHO PUBLISH THE NUMBERS.
 *
 * The first attempt at this went to a commercial vendor and came back 403: the calendar was a paid
 * endpoint on a free key. That was the wrong shape of dependency anyway. This calendar drives a
 * LOCKOUT — it decides when the system refuses to open a position — and a control that stops real
 * money should not sit behind somebody's free tier, a rate limit, or a pricing change.
 *
 * So it reads the primary sources. The Federal Reserve publishes its own meeting calendar as JSON.
 * The Bureau of Labor Statistics publishes the release date and time of every CPI, PPI and payrolls
 * print. These are the organisations that create the events. Nothing is closer to the truth, it is
 * all public domain, none of it needs a key, and none of it can be withdrawn by a vendor.
 *
 * WHAT THIS DOES NOT HAVE, and it matters: the street's CONSENSUS forecast. Governments publish what
 * happened and what happened last time; nobody official publishes what economists expected. Since the
 * move on a release is driven by the SURPRISE against consensus, an answer about "what will this do"
 * is limited without it — and the packet says so rather than letting the model imply otherwise. That
 * is the one thing here genuinely worth paying a vendor for.
 *
 * IMPACT RATINGS ARE OURS. No government feed rates its own releases, and a generic three-star scale
 * would be worse than a judgement made specifically for gold — for this instrument a Fed decision and
 * a CPI print are in a different league to retail sales, and that is a view worth holding explicitly.
 */

export type EconEvent = {
  at: number;
  name: string;
  importance: "high" | "medium" | "low";
  country: string;
  source: "federalreserve" | "bls" | "derived";
  /** True when the time is published rather than assumed. A lockout built on a guess is not a lockout. */
  timeKnown: boolean;
};

/*
 * WHAT MATTERS TO GOLD, and how much.
 *
 * Ordered deliberately. A rate decision and an inflation print move gold through the same channel —
 * real yields — and they move it hardest. Payrolls is next because it moves rate expectations. The
 * rest set the tone without usually setting the day.
 */
const IMPACT: [RegExp, EconEvent["importance"]][] = [
  [/fomc (meeting|statement)|federal open market committee|interest rate decision/i, "high"],
  [/consumer price index|^cpi\b/i, "high"],
  [/employment situation|non[- ]?farm|payroll/i, "high"],
  [/fomc (minutes|press conference)|personal income and outlays|pce/i, "high"],
  [/producer price index|^ppi\b/i, "medium"],
  [/retail sales|gross domestic product|gdp|jolts|job openings|employment cost/i, "medium"],
  [/jackson hole|beige book|testimony|semiannual/i, "medium"],
  [/speech|speaks|remarks/i, "low"],
];

function rate(name: string): EconEvent["importance"] | null {
  for (const [re, imp] of IMPACT) if (re.test(name)) return imp;
  return null;
}

/* ── the Federal Reserve's own calendar ───────────────────────────────── */

const FED_CALENDAR = "https://www.federalreserve.gov/json/calendar.json";

type FedEvent = { title?: string; time?: string; month?: string; days?: string; type?: string; description?: string };

/**
 * "2:00 p.m." on a given day in Washington, as a UTC instant.
 *
 * The Fed publishes wall-clock Eastern time with no offset, so the offset has to be recovered. Trying
 * both candidates and keeping the one that reads back correctly in New York is the only approach that
 * stays right across a daylight-saving change without shipping a timezone database.
 */
function easternInstant(y: number, m: number, d: number, hhmm: string): number | null {
  const t = hhmm.toLowerCase().replace(/\s|\./g, "");
  const match = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3] === "pm") hour += 12;
  const minute = Number(match[2] ?? 0);

  for (const offset of [4, 5]) {
    const guess = Date.UTC(y, m - 1, d, hour + offset, minute);
    const back = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(guess));
    if (back === `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`) return guess;
  }
  return null;
}

export async function fedEvents(): Promise<EconEvent[]> {
  const r = await fetch(FED_CALENDAR, { cache: "no-store" });
  if (!r.ok) return [];
  return mapFedEvents((await r.json()) as { events?: FedEvent[] });
}

/** Separated from the fetch so the two-day-meeting rule can actually be tested. */
export function mapFedEvents(j: { events?: FedEvent[] }): EconEvent[] {
  const out: EconEvent[] = [];

  for (const e of j.events ?? []) {
    const name = String(e.title ?? "").trim();
    if (!name || !e.month) continue;
    const importance = rate(name);
    if (!importance || importance === "low") continue;         // speeches are noise on this instrument

    const [ys, ms] = e.month.split("-");
    const y = Number(ys), mo = Number(ms);
    if (!Number.isFinite(y) || !Number.isFinite(mo)) continue;

    /*
     * `days` is a string and can be a range: a two-day meeting reads "9-10". The decision lands on the
     * SECOND day, which is the one that moves the market, so the last number is the one taken.
     */
    const day = Number(String(e.days ?? "").split(/[^\d]+/).filter(Boolean).pop());
    if (!Number.isFinite(day)) continue;

    const at = e.time ? easternInstant(y, mo, day, e.time) : null;
    out.push({
      at: at ?? Date.UTC(y, mo - 1, day, 18, 0),                // no published time: assume the usual 2pm ET
      name, importance, country: "US", source: "federalreserve",
      timeKnown: at != null,
    });
  }
  return out;
}

/* ── the Bureau of Labor Statistics schedule pages ────────────────────── */

/*
 * The HTML schedule pages rather than the .ics feed.
 *
 * The published .ics was verified and is STALE — its last event is in the past while the per-release
 * pages carry dates months ahead. A calendar that silently stops is worse than one that is absent,
 * because nothing looks wrong: the lockout simply never fires again.
 */
const BLS_PAGES: { url: string; name: string }[] = [
  { url: "https://www.bls.gov/schedule/news_release/cpi.htm", name: "US Consumer Price Index" },
  { url: "https://www.bls.gov/schedule/news_release/empsit.htm", name: "US Employment Situation (Non-Farm Payrolls)" },
  { url: "https://www.bls.gov/schedule/news_release/ppi.htm", name: "US Producer Price Index" },
];

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Pull "Oct. 14, 2026 | 08:30 AM" style rows out of a schedule page. */
export function parseBlsPage(html: string, name: string): EconEvent[] {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;?/gi, " ");
  const re = /\b([A-Z][a-z]{2})\.?\s+(\d{1,2}),\s+(\d{4})\b[\s|]*?(\d{1,2}):(\d{2})\s*(AM|PM)/gi;
  const out: EconEvent[] = [];
  for (const m of text.matchAll(re)) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (!mo) continue;
    let hour = Number(m[4]) % 12;
    if (m[6].toUpperCase() === "PM") hour += 12;
    const at = easternInstant(Number(m[3]), mo, Number(m[2]), `${hour === 0 ? 12 : hour > 12 ? hour - 12 : hour}:${m[5]}${m[6].toLowerCase()}`);
    if (at == null) continue;
    out.push({
      at, name, importance: rate(name) ?? "medium",
      country: "US", source: "bls", timeKnown: true,
    });
  }
  return out;
}

export async function blsEvents(): Promise<EconEvent[]> {
  const pages = await Promise.all(BLS_PAGES.map(async (p) => {
    try {
      const r = await fetch(p.url, { cache: "no-store" });
      if (!r.ok) return [];
      return parseBlsPage(await r.text(), p.name);
    } catch { return []; }
  }));
  return pages.flat();
}
