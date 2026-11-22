import { createClient } from "@/lib/supabase/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Announcement keys that exist. Adding one here is how a new pop-up is introduced. */
const KEYS = new Set(["atlas_command_center_2026_09", "flow_pass_2026_11", "one_mission_welcome_v1"]);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });

/** GET ?key= → { seen } · POST { key } → marks it seen for this member (once per member, any device). */
export async function GET(req: Request) {
  try {
    const sb = createClient(); if (!sb) return json({ ok: false, error: "not_configured", seen: null }, 503);
    const { data: { user }, error: authError } = await sb.auth.getUser();
    if (authError || !user) return json({ ok: false, error: "unauthorized", seen: null }, 401);
    const expected = req.headers.get("x-portal-member");
    if (expected && expected !== user.id) return json({ ok: false, error: "member_changed", seen: null }, 409);
    const key = new URL(req.url).searchParams.get("key") ?? "";
    if (!KEYS.has(key)) return json({ ok: false, error: "unknown_key", seen: null }, 400);
    const { data, error } = await sb.from("portal_announcements_seen").select("key").eq("user_id", user.id).eq("key", key).maybeSingle();
    if (error) return json({ ok: false, error: "read_failed", seen: null }, 503);
    return json({ ok: true, seen: !!data, memberId: user.id });
  } catch { return json({ ok: false, error: "unavailable", seen: null }, 503); }
}
export async function POST(req: Request) {
  try {
    const sb = createClient(); if (!sb) return json({ ok: false, error: "not_configured" }, 503);
    const { data: { user }, error: authError } = await sb.auth.getUser();
    if (authError || !user) return json({ ok: false, error: "unauthorized" }, 401);
    let b: { key?: unknown; expectedMemberId?: unknown };
    try { b = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
    if (!b || typeof b !== "object" || Array.isArray(b)) return json({ ok: false, error: "bad_request" }, 400);
    if (b.expectedMemberId !== undefined && b.expectedMemberId !== user.id) return json({ ok: false, error: "member_changed" }, 409);
    const key = typeof b.key === "string" ? b.key : "";
    if (!KEYS.has(key)) return json({ ok: false, error: "unknown_key" }, 400);
    const { error } = await sb.from("portal_announcements_seen").upsert({ user_id: user.id, key }, { onConflict: "user_id,key", ignoreDuplicates: true });
    if (error) return json({ ok: false, error: "save_failed" }, 503);
    return json({ ok: true, memberId: user.id });
  } catch { return json({ ok: false, error: "unavailable" }, 503); }
}
