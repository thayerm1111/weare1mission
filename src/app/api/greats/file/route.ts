import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Learn From the Greats — signed download URL for a private media object.
 * The member's own Supabase client is used, so Storage RLS (active member may
 * read the 'greats' bucket) is enforced. Returns a short-lived signed URL the
 * player / PDF viewer can use.
 *
 *   GET /api/greats/file?path=<storage_path>
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 500);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const path = (req.nextUrl.searchParams.get("path") || "").replace(/^\/+/, "").slice(0, 400);
  if (!path) return json({ error: "missing_path" }, 400);

  const { data, error } = await supabase.storage.from("greats").createSignedUrl(path, 60 * 60);
  if (error || !data?.signedUrl) return json({ error: "sign_failed", detail: error?.message?.slice(0, 200) }, 404);
  return json({ ok: true, url: data.signedUrl }, 200);
}
