import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { statsSince } from "@/lib/statsClock";
import { communityStats, type PlayRow } from "@/lib/communityStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * COMMUNITY RESULTS for the site (/portal/community) and the phone app's dashboard — the OM AI Plays
 * members ran, as anonymized aggregates, counted from the record reset (owner 10-11: "please reset all
 * the stats on the platform"). Replaces the community_signal_stats() database function, which counted
 * from a date written into it (lib/communityStats.ts). Signed-in members only, as the function was.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const COLS = "id, engine, user_id, instrument, direction, status, confidence, rr_planned, realized_r, hit_tp, created_at, resolved_at";
const PAGE = 1000;          // the most rows the API hands back to one request
const MAX_PAGES = 100;      // a guard, far past any real count

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 200);

  // Every play since the reset, a page at a time: the database function added them all up in one go,
  // and a single request here would stop at the API's page size without saying so.
  const since = statsSince();
  const rows: PlayRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await admin.from("signal_log").select(COLS)
      .eq("engine", "plays")
      .gte("created_at", since)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return json({ error: "load_failed" }, 200);
    const got = (data ?? []) as PlayRow[];
    rows.push(...got);
    if (got.length < PAGE) break;
  }

  return json(communityStats(rows));
}
