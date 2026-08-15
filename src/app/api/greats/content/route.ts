import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { MASTERCLASSES, TRACKS } from "@/data/greats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Learn From the Greats — the One Mission Personal Development Library curriculum,
 * served as JSON so the mobile PWA renders the exact same content as the desktop
 * portal (one source of truth: src/data/greats.ts). Also returns any admin-uploaded
 * media resources the member is allowed to see (published + active), so audio/PDF
 * libraries stay in sync across surfaces.
 *
 * Signed-in members only.
 */
export async function GET(_req: NextRequest) {
  const supabase = createClient();
  let resources: unknown[] = [];
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    // RLS returns only published resources to active members (admins see all).
    const { data } = await supabase
      .from("greats_resources")
      .select("id, masterclass_id, lesson_id, kind, title, description, storage_path, external_url, sort, published")
      .order("sort", { ascending: true });
    resources = data ?? [];
  }
  return new Response(
    JSON.stringify({ ok: true, masterclasses: MASTERCLASSES, tracks: TRACKS, resources }),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
}
