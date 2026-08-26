import { createClient } from "@/lib/supabase/server";
import { fetchCalendar } from "@/lib/news/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * THE FLOOR — "Market Intelligence" feed (economic side).
 *
 * Real, upcoming/recent HIGH & MEDIUM-impact economic events from the shared
 * 10-min-cached calendar feed. The client merges these with live GENX/FLOW desk
 * activity (from /api/flow/stats) into the combined intelligence feed, so this
 * endpoint stays a thin, cached read. Nothing here is fabricated: if the feed is
 * unavailable it returns an empty list and the panel falls back to desk activity.
 */

type IntelEvent = { time: string; ts: number; headline: string; impact: "HIGH" | "MED" | "LOW"; assets: string[]; when: string };

let CACHE: { at: number; featured: IntelEvent | null; events: IntelEvent[] } | null = null;
const TTL_MS = 5 * 60_000;

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function impactTag(s: string): "HIGH" | "MED" | "LOW" {
  const v = String(s).toLowerCase();
  if (/high|3/.test(v)) return "HIGH";
  if (/med|2/.test(v)) return "MED";
  return "LOW";
}

function assetsFor(ccy: string): string[] {
  const c = String(ccy).toUpperCase();
  const map: Record<string, string[]> = {
    USD: ["USD", "XAUUSD", "NAS100"], EUR: ["EURUSD", "EURGBP"], GBP: ["GBPUSD", "FTSE100"],
    JPY: ["USDJPY"], CAD: ["USDCAD", "USOIL"], AUD: ["AUDUSD"], CHF: ["USDCHF"], NZD: ["NZDUSD"], CNY: ["USD", "AUDUSD"],
  };
  return map[c] ?? [c];
}

function timeLabel(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true });
  } catch { return ""; }
}

function whenLabel(ts: number, now: number): string {
  const m = Math.round((ts - now) / 60000);
  if (m <= -120) return `${Math.round(-m / 60)}h ago`;
  if (m < 0) return `${-m}m ago`;
  if (m === 0) return "now";
  if (m < 60) return `in ${m}m`;
  return `in ${Math.round(m / 60)}h`;
}

export async function GET() {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  if (CACHE && Date.now() - CACHE.at < TTL_MS) return json({ featured: CACHE.featured, events: CACHE.events, cached: true });

  const now = Date.now();
  let events: IntelEvent[] = [];
  let featured: IntelEvent | null = null;
  try {
    const cal = await fetchCalendar();
    const windowed = cal
      .filter((e) => Number.isFinite(e.ts) && e.ts >= now - 6 * 3600_000 && e.ts <= now + 24 * 3600_000)
      .map((e) => ({
        time: timeLabel(e.ts), ts: e.ts, headline: e.title,
        impact: impactTag(e.impact), assets: assetsFor(e.country), when: whenLabel(e.ts, now),
      }))
      .filter((e) => e.impact === "HIGH" || e.impact === "MED");

    // Feed: newest/soonest first (matches the mockup's descending list).
    events = [...windowed].sort((a, b) => b.ts - a.ts).slice(0, 14);

    // Featured banner: the soonest UPCOMING high-impact release (or medium if none).
    const future = windowed.filter((e) => e.ts >= now).sort((a, b) => a.ts - b.ts);
    featured = future.find((e) => e.impact === "HIGH") ?? future.find((e) => e.impact === "MED") ?? null;
  } catch { /* feed down → empty; client falls back to desk activity */ }

  CACHE = { at: now, featured, events };
  return json({ featured, events });
}
