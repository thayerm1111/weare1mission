import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cheer / un-cheer a win. Toggles the current member's reaction on a post and
 * returns the fresh count. One reaction per member per win (enforced by the
 * table's composite primary key + RLS).
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let b: { winId?: string } = {};
  try { b = await req.json(); } catch { /* empty */ }
  const winId = String(b.winId || "");
  if (!winId) return json({ error: "bad_request" }, 400);

  const { data: existing } = await supabase
    .from("win_reactions")
    .select("win_id")
    .eq("win_id", winId)
    .eq("user_id", user.id)
    .maybeSingle();

  let cheered: boolean;
  if (existing) {
    await supabase.from("win_reactions").delete().eq("win_id", winId).eq("user_id", user.id);
    cheered = false;
  } else {
    const { error } = await supabase.from("win_reactions").insert({ win_id: winId, user_id: user.id });
    if (error) return json({ error: "react_failed", detail: error.message }, 200);
    cheered = true;
  }

  const { count } = await supabase
    .from("win_reactions")
    .select("win_id", { count: "exact", head: true })
    .eq("win_id", winId);

  return json({ cheered, cheers: count || 0 }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
