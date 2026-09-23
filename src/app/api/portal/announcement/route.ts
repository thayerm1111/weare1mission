import { createClient } from "@/lib/supabase/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Announcement keys that exist. Adding one here is how a new pop-up is introduced. */
const KEYS = new Set(["atlas_command_center_2026_09"]);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

/** GET ?key= → { seen } · POST { key } → marks it seen for this member (once per member, any device). */
export async function GET(req: Request) {
  const sb = createClient(); if (!sb) return json({ seen: true });
  const { data: { user } } = await sb.auth.getUser(); if (!user) return json({ seen: true });
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!KEYS.has(key)) return json({ seen: true });
  const { data } = await sb.from("portal_announcements_seen").select("key").eq("user_id", user.id).eq("key", key).maybeSingle();
  return json({ seen: !!data });
}
export async function POST(req: Request) {
  const sb = createClient(); if (!sb) return json({ ok: false }, 200);
  const { data: { user } } = await sb.auth.getUser(); if (!user) return json({ error: "unauthorized" }, 401);
  let b: { key?: string } = {}; try { b = await req.json(); } catch { /* empty */ }
  const key = String(b.key ?? ""); if (!KEYS.has(key)) return json({ error: "unknown_key" }, 400);
  await sb.from("portal_announcements_seen").upsert({ user_id: user.id, key }, { onConflict: "user_id,key", ignoreDuplicates: true });
  return json({ ok: true });
}
