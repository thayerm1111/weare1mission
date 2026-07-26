import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wins Wall feed — the community's shared wins. GET returns the latest posts
 * with reaction counts (and whether you've cheered each), POST creates one from
 * the signed-in member, DELETE removes your own. Backed by the `wins` +
 * `win_reactions` tables with RLS, so members can only write as themselves.
 */
const KINDS = ["general", "trade", "milestone", "rankup"];

function authorName(user: { email?: string | null; user_metadata?: Record<string, unknown> | null }): string {
  const m = user.user_metadata || {};
  const full = (m.full_name || m.name || m.display_name) as string | undefined;
  if (full && full.trim()) return full.trim().slice(0, 60);
  if (user.email) return user.email.split("@")[0];
  return "Member";
}

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { data: wins, error } = await supabase
    .from("wins")
    .select("id, author_name, kind, body, created_at, user_id")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return json({ error: "load_failed", detail: error.message }, 200);

  const ids = (wins || []).map((w) => w.id);
  const counts: Record<string, number> = {};
  const mine: Record<string, boolean> = {};
  if (ids.length) {
    const { data: reacts } = await supabase.from("win_reactions").select("win_id, user_id").in("win_id", ids);
    for (const r of reacts || []) {
      counts[r.win_id] = (counts[r.win_id] || 0) + 1;
      if (r.user_id === user.id) mine[r.win_id] = true;
    }
  }

  const feed = (wins || []).map((w) => ({
    id: w.id,
    author: w.author_name,
    kind: w.kind,
    body: w.body,
    createdAt: w.created_at,
    cheers: counts[w.id] || 0,
    cheered: !!mine[w.id],
    mine: w.user_id === user.id,
  }));
  return json({ feed }, 200);
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let b: { body?: string; kind?: string } = {};
  try { b = await req.json(); } catch { /* empty */ }
  const body = String(b.body || "").trim();
  if (!body) return json({ error: "empty" }, 400);
  if (body.length > 500) return json({ error: "too_long" }, 400);
  const kind = KINDS.includes(String(b.kind)) ? String(b.kind) : "general";

  const { data, error } = await supabase
    .from("wins")
    .insert({ user_id: user.id, author_name: authorName(user), kind, body })
    .select("id, author_name, kind, body, created_at, user_id")
    .single();
  if (error) return json({ error: "post_failed", detail: error.message }, 200);

  return json({
    win: { id: data.id, author: data.author_name, kind: data.kind, body: data.body, createdAt: data.created_at, cheers: 0, cheered: false, mine: true },
  }, 200);
}

export async function DELETE(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return json({ error: "bad_request" }, 400);
  // RLS also enforces ownership; the explicit filter keeps it clear.
  const { error } = await supabase.from("wins").delete().eq("id", id).eq("user_id", user.id);
  if (error) return json({ error: "delete_failed", detail: error.message }, 200);
  return json({ ok: true }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
