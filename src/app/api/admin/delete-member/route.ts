import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only: permanently remove a member. Deletes the auth user, which cascades
 * to their profile and related rows. Requires the caller to be a signed-in admin
 * and the service-role key to be configured.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ ok: false, error: "not_configured" }, 500);

  // Caller must be a signed-in admin.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return json({ ok: false, error: "forbidden" }, 403);

  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return json({ ok: false, error: "missing_id" }, 400);
  if (id === user.id) return json({ ok: false, error: "cannot_delete_self" }, 400);

  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "service_unavailable" }, 500);

  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true });
}
