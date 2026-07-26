import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Global leaderboard, period-aware (all / month / week). Reads via the
 * `get_leaderboard(p_limit, p_period)` SECURITY DEFINER function so it can rank
 * across users without exposing the underlying tables. Degrades to
 * { enabled:false, rows:[] } until the DB is set up.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ enabled: false, rows: [] }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ enabled: false, rows: [] }, 200);

  const sp = req.nextUrl.searchParams;
  const p = sp.get("period") || "all";
  const period = p === "week" || p === "month" ? p : "all";
  const limit = Math.min(100, Math.max(1, Number(sp.get("limit")) || 25));

  const { data, error } = await supabase.rpc("get_leaderboard", { p_limit: limit, p_period: period });
  if (error) return json({ enabled: false, rows: [] }, 200); // function/tables not ready → fall back

  return json({ enabled: true, me: user.id, period, rows: Array.isArray(data) ? data : [] }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
