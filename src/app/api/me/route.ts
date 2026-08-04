import { type NextRequest } from "next/server";
import { DAILY_FREE } from "@/lib/creditConfig";
import { bearerClient, bearerFromReq } from "@/lib/supabase/bearer";

/**
 * GET /api/me — launch-hydration for the native app.
 * Returns { name, email, credits, membership } in one call. Authenticates with a
 * Supabase access token in the Authorization header (native apps have no
 * cookies). New, additive route — nothing else in the app imports it, and the
 * web app's cookie auth is unaffected.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, OPTIONS",
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest) {
  const supabase = bearerClient(bearerFromReq(req));
  if (!supabase) return json({ error: "unauthorized" }, 401);

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);

  // Credits — same RPC + shape the web uses (daily_left + purchased).
  let credits = DAILY_FREE;
  try {
    const { data } = await supabase.rpc("get_credit_balance", { p_daily_allowance: DAILY_FREE });
    const d = data as { daily_left?: number; purchased?: number } | null;
    if (d) credits = (Number(d.daily_left) || 0) + (Number(d.purchased) || 0);
  } catch { /* leave the free-floor default */ }

  // Profile — name + membership gate + role from the profiles table.
  let name = user.email?.split("@")[0] ?? "Member";
  let membership: "active" | "pending" | "none" = "active";
  let role = "member";
  try {
    const { data: p } = await supabase.from("profiles").select("full_name, status, role").eq("id", user.id).single();
    if (p?.full_name) name = p.full_name as string;
    if (p?.status && p.status !== "active") membership = "pending";
    if (p?.role) role = String(p.role);
  } catch { /* fall back to defaults */ }

  return json({ name, email: user.email ?? "", credits, membership, role });
}
