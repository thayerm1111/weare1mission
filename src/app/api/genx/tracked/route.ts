import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GENX tracked setups — the member's saved setups, synced to their account so
 * they follow them between the phone app and the website (not just one device).
 * Backed by `public.genx_tracked` with RLS, so a member can only ever read or
 * write their own rows. The whole setup object rides in `payload` (jsonb) keyed
 * by the client-generated id, so the shape can evolve without a migration.
 *   GET    -> list the member's tracked setups (newest first)
 *   POST   -> upsert one ({ tracked })
 *   DELETE -> remove one by ?id=<client id>
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ tracked: [] });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const { data, error } = await supabase
    .from("genx_tracked")
    .select("payload, created_at")
    .order("created_at", { ascending: false })
    .limit(24);
  if (error) return json({ tracked: [], detail: error.message }, 200);
  const tracked = (data || []).map((r) => r.payload).filter(Boolean);
  return json({ tracked });
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ ok: false });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { tracked?: { id?: unknown } };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const t = body?.tracked;
  const clientId = t && typeof t.id === "string" ? t.id : null;
  if (!t || !clientId) return json({ error: "bad_request" }, 400);

  const { error } = await supabase
    .from("genx_tracked")
    .upsert({ user_id: user.id, client_id: clientId, payload: t, updated_at: new Date().toISOString() }, { onConflict: "user_id,client_id" });
  if (error) return json({ ok: false, detail: error.message }, 200);
  return json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ ok: false });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return json({ error: "bad_request" }, 400);
  const { error } = await supabase.from("genx_tracked").delete().eq("client_id", id).eq("user_id", user.id);
  if (error) return json({ ok: false, detail: error.message }, 200);
  return json({ ok: true });
}
