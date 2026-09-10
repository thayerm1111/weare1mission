import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only member password set (owner 09-10: "make me a admin spot on the approvals
 * where i can change their password to what i want").
 *
 *   POST { id, password } → set that member's login password to exactly `password`
 *   (6–72 chars, Supabase's own bounds), via the Auth admin API — the same mechanism
 *   Supabase's dashboard uses. The member's sessions stay valid; they simply sign in
 *   with the new password from now on.
 *
 * Guardrails: admin-gated like every /api/admin route; an admin account can NOT have
 * its password changed from here (so a compromised admin UI can't lock out the owner);
 * the password itself is never logged or echoed back.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function requireAdmin(): Promise<{ ok: true } | { ok: false; res: Response }> {
  const supabase = createClient();
  if (!supabase) return { ok: false, res: json({ ok: false, error: "not_configured" }, 500) };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, res: json({ ok: false, error: "unauthorized" }, 401) };
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return { ok: false, res: json({ ok: false, error: "forbidden" }, 403) };
  return { ok: true };
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.res;

  let body: { id?: unknown; password?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
  const id = typeof body?.id === "string" ? body.id : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!id) return json({ ok: false, error: "missing_id" }, 400);
  if (password.length < 6 || password.length > 72) {
    return json({ ok: false, error: "bad_password", detail: "Password must be 6–72 characters." }, 400);
  }

  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "service_unavailable" }, 500);

  // The member must exist, and must NOT be an admin (owner accounts are changed
  // through Supabase directly, never through the member panel).
  const { data: prof } = await admin.from("profiles").select("id, email, role").eq("id", id).maybeSingle();
  if (!prof) return json({ ok: false, error: "member_not_found" }, 404);
  if ((prof as { role?: string | null }).role === "admin") {
    return json({ ok: false, error: "admin_protected", detail: "Admin passwords can't be changed from this panel." }, 403);
  }

  const { error } = await admin.auth.admin.updateUserById(id, { password });
  if (error) return json({ ok: false, error: "update_failed", detail: error.message.slice(0, 160) }, 500);

  return json({ ok: true, email: (prof as { email?: string | null }).email ?? null });
}
