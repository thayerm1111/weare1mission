import { createClient } from "@/lib/supabase/server";
import { hasPassOrPreview } from "@/lib/ccPass";
import { latestTick } from "../../../../../command-center/adapters/db";
import { GOLD } from "../../../../../command-center/adapters/twelvedata";
import { tickPayload } from "../../../../../command-center/core/feed";
import { marketOpen } from "../../../../../command-center/core/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * COMMAND CENTER XAUUSD — THE NEWEST GOLD TICK.
 *
 * The one row the worker's price stream keeps current (market_live_ticks, about once a second), plus this
 * server's clock so the browser can judge the tick's age on the same clock, plus the feed state of that price AS
 * A POLL — which it is: the screen asks for this when Supabase Realtime is not delivering (hud/useLiveFeed.ts),
 * and once when it opens. A poll is never LIVE, however fresh the tick (core/feed.ts computeFeedState).
 *
 * It never calls the market-data provider: one WebSocket in the worker serves every viewer.
 *
 * Same access rule as /api/command-center/live, check for check: signed in, and an open Command Center pass
 * (or the entrance's free preview).
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The row changes at most once a second; one read per instance per half second serves every poller on it. */
const CACHE_MS = 500;
let cached: { at: number; row: Awaited<ReturnType<typeof latestTick>> } | null = null;

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ ok: false, error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  // 5 credits per 30 minutes (owner 09-21). No open window, no data.
  // The free preview may read the live gold update for the entrance, and nothing else.
  if (!(await hasPassOrPreview(user.id)).ok) {
    return json({ ok: false, error: "pass_required" }, 402);
  }

  try {
    const readAt = Date.now();
    if (!cached || readAt - cached.at >= CACHE_MS) cached = { at: readAt, row: await latestTick(GOLD) };
    const now = Date.now();
    return json(tickPayload(cached.row, { now, marketOpen: marketOpen(now), symbol: GOLD }));
  } catch (e) {
    return json({ ok: false, error: "read_failed", detail: e instanceof Error ? e.message.slice(0, 200) : "unknown" }, 500);
  }
}
