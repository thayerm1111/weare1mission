import { type NextRequest } from "next/server";
import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MATTY PIPS — saved reads. Every FIND ME A TRADE run is archived; SAVE pins
 * one so the member can come back, hit UPDATE, and watch whether the picture
 * is playing out. Members only ever see their own rows (service-role reads
 * filtered by the authenticated user id — matty_pips_* tables are RLS-locked).
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const profile = await getProfile();
  if (!profile) return json({ ok: false, error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "not_configured" }, 500);
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const { data } = await admin.from("matty_pips_analysis")
      .select("id, symbol, mode, status, verdict, score, price, created_at, decision")
      .eq("user_id", profile.id).eq("id", id).maybeSingle();
    if (!data) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, item: data });
  }
  const { data } = await admin.from("matty_pips_analysis")
    .select("id, symbol, mode, status, verdict, score, price, created_at")
    .eq("user_id", profile.id).eq("saved", true)
    .order("created_at", { ascending: false }).limit(20);
  return json({ ok: true, items: data ?? [] });
}

export async function POST(req: NextRequest) {
  const profile = await getProfile();
  if (!profile) return json({ ok: false, error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "not_configured" }, 500);
  let body: { id?: string; unsave?: boolean } = {};
  try { body = await req.json(); } catch { /* */ }
  if (!body.id) return json({ ok: false, error: "missing_id" }, 400);
  const { error } = await admin.from("matty_pips_analysis")
    .update({ saved: body.unsave !== true })
    .eq("user_id", profile.id).eq("id", body.id);
  if (error) return json({ ok: false, error: error.message.slice(0, 120) }, 500);
  return json({ ok: true, saved: body.unsave !== true });
}
