import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MY LEVELS admin API (owner 09-07). Admin-only CRUD for genx_owner_levels — the
 * owner's drawn support/resistance lines that the GENX scanner trades on confirmed
 * 5-minute rejections. GET lists; POST adds {price, label?}; PATCH toggles
 * {id, active}; DELETE removes {id}.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function requireAdmin(): Promise<{ admin: NonNullable<ReturnType<typeof createAdminClient>>; userId: string } | Response> {
  const supabase = createClient();
  if (!supabase) return json({ ok: false, error: "not_configured" }, 500);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return json({ ok: false, error: "forbidden" }, 403);
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "service_unavailable" }, 500);
  return { admin, userId: user.id };
}

export async function GET() {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;
  const { data, error } = await ctx.admin
    .from("genx_owner_levels")
    .select("id, price, label, active, triggered_at, created_at")
    .order("price", { ascending: false })
    .limit(100);
  if (error) return json({ ok: false, error: error.message }, 200);
  return json({ ok: true, levels: data ?? [] }, 200);
}

export async function POST(req: NextRequest) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;
  let body: { price?: unknown; label?: unknown } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
  const price = Number(body.price);
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : null;
  // Sanity: a gold level must be a positive price in a plausible band, one decimal step fine.
  if (!Number.isFinite(price) || price < 500 || price > 20000) return json({ ok: false, error: "Enter a valid gold price for the level." }, 200);
  const { data, error } = await ctx.admin
    .from("genx_owner_levels")
    .insert({ price: +price.toFixed(2), label: label || null, active: true, created_by: ctx.userId })
    .select("id, price, label, active, triggered_at, created_at")
    .single();
  if (error) return json({ ok: false, error: error.message }, 200);
  return json({ ok: true, level: data }, 200);
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;
  let body: { id?: unknown; active?: unknown } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id || typeof body.active !== "boolean") return json({ ok: false, error: "bad_request" }, 400);
  const { error } = await ctx.admin.from("genx_owner_levels").update({ active: body.active }).eq("id", id);
  if (error) return json({ ok: false, error: error.message }, 200);
  return json({ ok: true }, 200);
}

export async function DELETE(req: NextRequest) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;
  let body: { id?: unknown } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return json({ ok: false, error: "bad_request" }, 400);
  const { error } = await ctx.admin.from("genx_owner_levels").delete().eq("id", id);
  if (error) return json({ ok: false, error: error.message }, 200);
  return json({ ok: true }, 200);
}
