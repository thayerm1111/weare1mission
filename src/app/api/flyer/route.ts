import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One-time Trading Suite welcome flyer — per-ACCOUNT seen state (works across all
 * of a member's devices). GET returns whether they've seen it; POST marks it seen.
 * `createClient()` authenticates the web (cookie) and the native app (Bearer)
 * alike, so both front-ends share the same flag.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ ok: true, seen: true }); // not configured → don't nag
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: true, seen: true });
  const { data } = await supabase.from("profiles").select("suite_flyer_seen").eq("id", user.id).maybeSingle();
  return json({ ok: true, seen: !!(data as { suite_flyer_seen?: boolean } | null)?.suite_flyer_seen });
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ ok: true });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: true });
  const admin = createAdminClient();
  if (admin) await admin.from("profiles").update({ suite_flyer_seen: true }).eq("id", user.id);
  return json({ ok: true, seen: true });
}
