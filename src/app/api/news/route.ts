import { createClient } from "@/lib/supabase/server";
import { fetchCalendar, newsHold, OUR_CCY } from "@/lib/news/calendar";
import { fetchHeadlines } from "@/lib/news/headlines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Market news / economic-calendar feed for the dashboard, plus the desk's current
 * "news hold" state. Read straight from the keyless calendar feed (see calendar.ts).
 * Filtered to the currencies the desk trades (USD/EUR/GBP/JPY + gold→USD) and to the
 * High/Medium events that actually matter. Any signed-in member can read it.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }

  const [events, headlines] = await Promise.all([fetchCalendar(), fetchHeadlines()]);
  const now = Date.now();

  const relevant = events
    .filter((e) => OUR_CCY.includes(e.country) && (e.impact === "High" || e.impact === "Medium"))
    .filter((e) => e.ts >= now - 60 * 60 * 1000) // from the last hour onward
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 30)
    .map((e) => ({
      title: e.title,
      currency: e.country,
      impact: e.impact,
      at: e.date,
      minsAway: Math.round((e.ts - now) / 60000),
      forecast: e.forecast || null,
      previous: e.previous || null,
    }));

  // Desk-wide hold state (gold reacts to USD, so XAUUSD covers the USD case too).
  const [gold, eur, gbp, jpy] = await Promise.all([
    newsHold("XAUUSD"), newsHold("EURUSD"), newsHold("GBPUSD"), newsHold("USDJPY"),
  ]);
  const active = [gold, eur, gbp, jpy].find((h) => h.hold) || null;

  const news = headlines.slice(0, 20).map((h) => ({
    title: h.title,
    url: h.url,
    source: h.source,
    at: h.at,
    minsAgo: Math.max(0, Math.round((now - h.ts) / 60000)),
  }));

  return json({
    events: relevant,
    headlines: news,
    holdNow: !!active,
    holdEvent: active?.event ? { title: active.event.title, currency: active.event.country, at: active.event.date } : null,
  }, 200);
}
