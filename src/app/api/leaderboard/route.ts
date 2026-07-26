import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Global leaderboard (top members by XP). Reads via the `get_leaderboard`
 * SECURITY DEFINER function so it can rank across users without exposing the
 * game_state table. Degrades to { enabled:false, rows:[] } until the DB is set up.
 */
export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ enabled: false, rows: [] }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ enabled: false, rows: [] }, 200);

  const { data, error } = await supabase.rpc("get_leaderboard", { p_limit: 25 });
  if (error) return json({ enabled: false, rows: [] }, 200); // function not created yet → fall back

  return json({ enabled: true, me: user.id, rows: Array.isArray(data) ? data : [] }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
