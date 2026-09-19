/**
 * THE ECONOMIC CALENDAR.
 *
 * Gold trades on rate expectations, and rate expectations move on scheduled releases. Without a
 * calendar THE BRAIN could explain how CPI affects gold and had no idea when CPI was — which is the
 * difference between a textbook and a trading desk. Worse, the snapshot has always carried a `news`
 * field that nothing ever populated, so the news lockout that is supposed to keep the system out of
 * the market around a release has never once fired.
 *
 * PROVIDER-AGNOSTIC ON PURPOSE. Calendar vendors change terms, rate limits and field names more often
 * than market-data vendors do, and the system must not acquire a second hard dependency on one. The
 * shape below is ours; each provider is a small function that maps into it.
 *
 * WHAT HAPPENS WITH NO KEY, which is the state today: `upcoming()` returns what can be DERIVED and
 * nothing else, and the absence is reported rather than hidden. Non-farm payrolls is the first Friday
 * of the month at a fixed time — a published, stable rule, safe to compute. FOMC and CPI dates are
 * not derivable from a rule; they are published annually and change. Guessing them would put a wrong
 * date in front of a trader, which is worse than an empty calendar.
 */

export type EconEvent = {
  at: number;
  name: string;
  importance: "high" | "medium" | "low";
  country: string;
  /** Where this came from, because a derived event and a published one deserve different trust. */
  source: "derived" | "finnhub" | "tradingeconomics" | "fmp";
  actual?: number | null;
  forecast?: number | null;
  previous?: number | null;
};

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
  return { at, name: "US Non-Farm Payrolls", importance: "high", country: "US", source: "derived" };
}

/* ── the published ones ───────────────────────────────────────────────── */

type Provider = { name: EconEvent["source"]; key: string | undefined; fetch: (key: string, fromMs: number, toMs: number) => Promise<EconEvent[]> };

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function finnhub(key: string, fromMs: number, toMs: number): Promise<EconEvent[]> {
  const r = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${iso(fromMs)}&to=${iso(toMs)}&token=${encodeURIComponent(key)}`, { cache: "no-store" });
  if (!r.ok) return [];
  const j = (await r.json()) as { economicCalendar?: { time?: string; event?: string; country?: string; impact?: string; actual?: number; estimate?: number; prev?: number }[] };
  return (j.economicCalendar ?? []).flatMap((e) => {
    const at = Date.parse(String(e.time ?? "").replace(" ", "T") + "Z");
    if (!Number.isFinite(at) || !e.event) return [];
    return [{
      at, name: e.event, country: e.country ?? "",
      importance: (String(e.impact).toLowerCase() === "high" ? "high" : String(e.impact).toLowerCase() === "medium" ? "medium" : "low") as EconEvent["importance"],
      source: "finnhub" as const, actual: e.actual ?? null, forecast: e.estimate ?? null, previous: e.prev ?? null,
    }];
  });
}

async function tradingEconomics(key: string, fromMs: number, toMs: number): Promise<EconEvent[]> {
  const r = await fetch(`https://api.tradingeconomics.com/calendar/country/united%20states/${iso(fromMs)}/${iso(toMs)}?c=${encodeURIComponent(key)}&f=json`, { cache: "no-store" });
  if (!r.ok) return [];
  const j = (await r.json()) as { Date?: string; Event?: string; Country?: string; Importance?: number; Actual?: number; Forecast?: number; Previous?: number }[];
  return (Array.isArray(j) ? j : []).flatMap((e) => {
    const at = Date.parse(String(e.Date ?? ""));
    if (!Number.isFinite(at) || !e.Event) return [];
    return [{
      at, name: e.Event, country: e.Country ?? "US",
      importance: (e.Importance === 3 ? "high" : e.Importance === 2 ? "medium" : "low") as EconEvent["importance"],
      source: "tradingeconomics" as const, actual: e.Actual ?? null, forecast: e.Forecast ?? null, previous: e.Previous ?? null,
    }];
  });
}

const PROVIDERS = (): Provider[] => [
  { name: "finnhub", key: process.env.FINNHUB_API_KEY, fetch: finnhub },
  { name: "tradingeconomics", key: process.env.TRADINGECONOMICS_API_KEY, fetch: tradingEconomics },
];

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

export async function upcoming(nowMs = Date.now(), days = 8): Promise<CalendarView> {
  if (cache && nowMs - cache.at < 5 * 60_000) return cache.view;

  const toMs = nowMs + days * 86_400_000;
  let events: EconEvent[] = [];
  let source: CalendarView["source"] = "derived_only";

  for (const p of PROVIDERS()) {
    if (!p.key) continue;
    try {
      const got = await p.fetch(p.key, nowMs - 86_400_000, toMs);
      if (got.length) { events = got.filter((e) => MATTERS.test(e.name)); source = "published"; break; }
    } catch { /* try the next provider rather than failing the whole read */ }
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
    L.push("NO CALENDAR FEED IS CONFIGURED. The only event below is computed from a fixed published rule (payrolls is the first Friday of the month).");
    L.push("You do NOT know this week's FOMC, CPI or PPI dates. If asked what is scheduled, say plainly that the calendar feed is not connected — never guess a date.");
  }
  if (!v.events.length) { L.push("nothing known in the next week."); return L; }
  for (const e of v.events) {
    const bits = [e.forecast != null ? `forecast ${e.forecast}` : "", e.previous != null ? `previous ${e.previous}` : ""].filter(Boolean).join(", ");
    L.push(`${when(e.at)} — ${e.name} (${e.importance}${e.country ? `, ${e.country}` : ""})${bits ? ` — ${bits}` : ""}`);
  }
  if (v.inLockout) L.push("RIGHT NOW you are inside a high-impact release window: liquidity is thin, spreads are wide, and new entries are refused.");
  else if (v.minutesToNext != null && v.minutesToNext <= 60) L.push(`next release in about ${v.minutesToNext} minutes.`);
  return L;
}
