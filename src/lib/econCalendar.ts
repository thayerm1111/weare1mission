// Economic-calendar news gate (Financial Modeling Prep).
//
// Given an instrument, returns the news-risk read for the currencies whose
// releases move it, over a short look-ahead window. A high-impact release
// inside the blackout window (30m before → 15m after) vetoes new setups.
//
// Design rule: this FAILS OPEN. If no key is set or the provider is
// unreachable, it never blocks a trade — it just reports that news wasn't
// screened, so a calendar hiccup can never take a trading tool down.

export type NewsRisk = {
  level: "high" | "medium" | "low" | "clear" | "unknown";
  next_event: string;
  event_time: string; // ISO, "" when none
  minutes_to: number | null;
  blackout: boolean; // true → caller should return NO TRADE
  note: string;
  screened: boolean; // whether the calendar was actually consulted
};

type Impact = "high" | "medium" | "low" | "none";
type CalEvent = { time: number; event: string; impact: Impact; ccy: string };

const BLACKOUT_BEFORE_MIN = 30; // hold new trades within 30m before a high-impact print
const BLACKOUT_AFTER_MIN = 15; //  ...and 15m after (whipsaw)
const LOOKAHEAD_HOURS = 8;
const CACHE_TTL_MS = 10 * 60 * 1000; // calendar changes slowly; cache 10 min

// Warm-instance cache (Market Command is admin-only + low volume).
let cache: { at: number; events: CalEvent[] } | null = null;

/** Currencies whose scheduled news moves this instrument. */
export function instrumentCurrencies(td: string): string[] {
  const s = (td || "").toUpperCase();
  const out = new Set<string>();
  const pair = s.match(/^([A-Z]{3})\/([A-Z]{3})$/);
  if (pair) { out.add(pair[1]); out.add(pair[2]); }
  if (/XAU|XAG|GOLD|SILVER|WTI|BRENT|OIL/.test(s)) out.add("USD");
  if (/NAS100|US100|NDX|QQQ|SPX|US500|SPY|DJI|US30|DIA/.test(s)) out.add("USD");
  if (/GER|DAX|DE40|EU50|STOXX/.test(s)) out.add("EUR");
  if (/UK100|FTSE/.test(s)) out.add("GBP");
  if (/JP225|NIK|NKY|JPN/.test(s)) out.add("JPY");
  if (/BTC|ETH|SOL|XRP|DOGE|USDT|USDC/.test(s)) out.add("USD");
  if (out.size === 0) out.add("USD");
  return [...out];
}

const COUNTRY_TO_CCY: Record<string, string> = {
  US: "USD", USA: "USD", "UNITED STATES": "USD",
  EU: "EUR", EA: "EUR", "EURO ZONE": "EUR", EUROZONE: "EUR", "EUROPEAN UNION": "EUR",
  GERMANY: "EUR", FRANCE: "EUR", ITALY: "EUR", SPAIN: "EUR",
  GB: "GBP", UK: "GBP", "UNITED KINGDOM": "GBP",
  JP: "JPY", JAPAN: "JPY",
  CA: "CAD", CANADA: "CAD",
  AU: "AUD", AUSTRALIA: "AUD",
  NZ: "NZD", "NEW ZEALAND": "NZD",
  CH: "CHF", SWITZERLAND: "CHF",
  CN: "CNY", CHINA: "CNY",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function normImpact(v: unknown): Impact {
  const s = str(v).toLowerCase();
  if (s.startsWith("high") || s === "3") return "high";
  if (s.startsWith("med") || s === "2") return "medium";
  if (s.startsWith("low") || s === "1") return "low";
  return "none";
}
function parseUtc(s: string): number {
  if (!s) return NaN;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : iso + "Z";
  return Date.parse(withZ);
}
function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function fetchCalendar(key: string, nowMs: number): Promise<CalEvent[]> {
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.events;
  const from = ymd(nowMs - 3600_000);
  const to = ymd(nowMs + LOOKAHEAD_HOURS * 3600_000 + 86400_000);
  const k = encodeURIComponent(key);
  // Try the current "stable" endpoint, fall back to legacy v3 if it 404/403s.
  const endpoints = [
    `https://financialmodelingprep.com/stable/economic-calendar?from=${from}&to=${to}&apikey=${k}`,
    `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${k}`,
  ];
  let arr: unknown = null;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const j: unknown = await res.json();
      if (Array.isArray(j)) { arr = j; break; }
    } catch { /* try next */ }
  }
  if (!Array.isArray(arr)) throw new Error("calendar unavailable");

  const events: CalEvent[] = (arr as Record<string, unknown>[])
    .map((e) => {
      const ccy = (str(e.currency) || COUNTRY_TO_CCY[str(e.country).toUpperCase()] || str(e.country)).toUpperCase();
      return { time: parseUtc(str(e.date)), event: str(e.event).slice(0, 120), impact: normImpact(e.impact ?? e.importance), ccy };
    })
    .filter((e) => Number.isFinite(e.time) && e.ccy.length > 0);
  cache = { at: nowMs, events };
  return events;
}

const NOT_CONNECTED =
  "Economic calendar not connected — set ECON_CALENDAR_API_KEY to enable news blackout filtering. News risk is NOT being screened right now.";

/** Assess scheduled-news risk for an instrument. Never throws. */
export async function assessNews(td: string, nowMs: number): Promise<NewsRisk> {
  const key = process.env.ECON_CALENDAR_API_KEY;
  if (!key) {
    return { level: "unknown", next_event: "", event_time: "", minutes_to: null, blackout: false, note: NOT_CONNECTED, screened: false };
  }
  const ccys = instrumentCurrencies(td);
  let events: CalEvent[];
  try {
    events = await fetchCalendar(key, nowMs);
  } catch {
    return { level: "unknown", next_event: "", event_time: "", minutes_to: null, blackout: false, note: "Economic calendar temporarily unavailable — news risk not screened for this read.", screened: false };
  }

  const upcoming = events
    .filter((e) => ccys.includes(e.ccy) && (e.impact === "high" || e.impact === "medium"))
    .map((e) => ({ ...e, mins: (e.time - nowMs) / 60000 }))
    .filter((e) => e.mins <= LOOKAHEAD_HOURS * 60 && e.mins >= -BLACKOUT_AFTER_MIN)
    .sort((a, b) => a.time - b.time);

  if (upcoming.length === 0) {
    return { level: "clear", next_event: "", event_time: "", minutes_to: null, blackout: false, note: `No high-impact ${ccys.join("/")} news on the calendar in the next ${LOOKAHEAD_HOURS}h — clear to trade.`, screened: true };
  }

  const next = upcoming[0];
  const mins = Math.round(next.mins);
  const when = new Date(next.time).toISOString();
  const rel = next.mins >= 0 ? `in ${mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`}` : `${Math.abs(mins)}m ago`;

  if (next.impact === "high" && next.mins <= BLACKOUT_BEFORE_MIN && next.mins >= -BLACKOUT_AFTER_MIN) {
    return { level: "high", next_event: next.event, event_time: when, minutes_to: mins, blackout: true, note: `NEWS BLACKOUT — high-impact ${next.ccy} "${next.event}" ${rel}. Holding new setups through the release to avoid the whipsaw.`, screened: true };
  }

  const level: NewsRisk["level"] = next.impact === "high" ? "medium" : "low";
  return { level, next_event: next.event, event_time: when, minutes_to: mins, blackout: false, note: `Heads-up: ${next.impact}-impact ${next.ccy} "${next.event}" ${rel}. Outside the blackout window — trading allowed; manage around the release.`, screened: true };
}
