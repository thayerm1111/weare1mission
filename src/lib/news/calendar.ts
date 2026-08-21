/**
 * Economic-calendar + news awareness (server-only, keyless).
 *
 * Source: the public ForexFactory-derived weekly calendar JSON published by
 * faireconomy (no API key). Each event: { title, country (currency), date (ISO),
 * impact: "High"|"Medium"|"Low"|"Holiday", forecast, previous }.
 *
 * Two jobs:
 *   1) `fetchCalendar()` — cached feed (10-min TTL) for the dashboard news/calendar.
 *   2) `newsHold(symbol)` — the FALLING-KNIFE guard: is a HIGH-impact event for this
 *      instrument's currency inside the blackout window right now? If so the desk
 *      holds the entry instead of blindly buying into the release.
 */

export type CalEvent = {
  title: string; country: string; date: string;
  impact: string; forecast: string; previous: string; ts: number;
};

const FEED = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const TTL_MS = 10 * 60 * 1000;

// Blackout window around a HIGH-impact release: hold entries from this long BEFORE
// until this long AFTER. The desk can still trade news generally — this only blocks
// blind entries in the immediate volatility spike (the falling knife).
export const NEWS_BEFORE_MS = 15 * 60 * 1000;
export const NEWS_AFTER_MS = 15 * 60 * 1000;

// The currencies the desk actually trades (plus gold, which reacts to USD).
export const OUR_CCY = ["USD", "EUR", "GBP", "JPY"];

// module-level cache (persists within a warm serverless instance)
let cache: { at: number; events: CalEvent[] } | null = null;

/** Map an instrument to the currencies whose news moves it. */
export function symbolCurrencies(symbol: string): string[] {
  const s = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("XAU") || s.startsWith("GOLD") || s.startsWith("XAG")) return ["USD"];
  const map: Record<string, string[]> = {
    EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], USDJPY: ["USD", "JPY"],
    NAS100: ["USD"], US30: ["USD"], USOIL: ["USD"],
  };
  if (map[s]) return map[s];
  if (/^[A-Z]{6}$/.test(s)) return [s.slice(0, 3), s.slice(3, 6)];
  return ["USD"];
}

/** Fetch + cache the week's calendar. Falls back to the last good cache on error. */
export async function fetchCalendar(): Promise<CalEvent[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.events;
  try {
    const r = await fetch(FEED, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; OneMissionDesk/1.0)", accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) throw new Error("feed_" + r.status);
    const raw = (await r.json()) as unknown;
    const events: CalEvent[] = (Array.isArray(raw) ? raw : [])
      .map((e) => {
        const o = e as Record<string, unknown>;
        const date = String(o.date ?? "");
        return {
          title: String(o.title ?? ""),
          country: String(o.country ?? "").toUpperCase(),
          date,
          impact: String(o.impact ?? ""),
          forecast: String(o.forecast ?? ""),
          previous: String(o.previous ?? ""),
          ts: Date.parse(date) || 0,
        };
      })
      .filter((e) => e.ts > 0 && e.title);
    cache = { at: now, events };
    return events;
  } catch {
    return cache ? cache.events : [];
  }
}

/**
 * FALLING-KNIFE GUARD. True if a HIGH-impact event for one of this symbol's currencies
 * is inside the blackout window right now (about to drop, or just dropped).
 */
export async function newsHold(
  symbol: string,
  beforeMs: number = NEWS_BEFORE_MS,
  afterMs: number = NEWS_AFTER_MS,
): Promise<{ hold: boolean; event: CalEvent | null; minsToEvent: number | null }> {
  const ccy = symbolCurrencies(symbol);
  const events = await fetchCalendar();
  const now = Date.now();
  for (const e of events) {
    if (e.impact !== "High") continue;
    if (!ccy.includes(e.country)) continue;
    if (e.ts >= now - afterMs && e.ts <= now + beforeMs) {
      return { hold: true, event: e, minsToEvent: Math.round((e.ts - now) / 60000) };
    }
  }
  return { hold: false, event: null, minsToEvent: null };
}
