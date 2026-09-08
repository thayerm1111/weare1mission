import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only credit grants (owner 09-08: "make it so on the admin side I can add
 * credits to peoples accounts").
 *   GET  ?id=<userId>          → that member's current credit balance.
 *   POST { id, amount }        → grant `amount` credits (1–100,000) to the member,
 *                                through the same add_purchased_credits RPC every
 *                                other grant path uses (bumps user_credits.balance
 *                                AND writes the credit_transactions ledger row,
 *                                feature 'owner_grant'), then returns the new balance.
 * Grants only — this route never deducts, so a typo can't wipe someone's credits.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const MAX_GRANT = 100_000;

async function requireAdmin(): Promise<{ ok: true } | { ok: false; res: Response }> {
  const supabase = createClient();
  if (!supabase) return { ok: false, res: json({ ok: false, error: "not_configured" }, 500) };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, res: json({ ok: false, error: "unauthorized" }, 401) };
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return { ok: false, res: json({ ok: false, error: "forbidden" }, 403) };
  return { ok: true };
}

async function balanceOf(admin: NonNullable<ReturnType<typeof createAdminClient>>, id: string): Promise<number> {
  const { data } = await admin.from("user_credits").select("balance").eq("user_id", id).maybeSingle();
  const b = Number((data as { balance?: unknown } | null)?.balance);
  return Number.isFinite(b) ? b : 0;
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.res;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return json({ ok: false, error: "missing_id" }, 400);
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "service_unavailable" }, 500);
  return json({ ok: true, balance: await balanceOf(admin, id) });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.res;

  let body: { id?: unknown; amount?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
  const id = typeof body?.id === "string" ? body.id : "";
  const amount = Math.floor(Number(body?.amount));
  if (!id) return json({ ok: false, error: "missing_id" }, 400);
  if (!Number.isFinite(amount) || amount < 1 || amount > MAX_GRANT) {
    return json({ ok: false, error: "bad_amount", detail: `Amount must be a whole number from 1 to ${MAX_GRANT.toLocaleString()}.` }, 400);
  }

  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "service_unavailable" }, 500);

  // The member must actually exist (a bad paste shouldn't mint credits into the void).
  const { data: prof } = await admin.from("profiles").select("id, email").eq("id", id).maybeSingle();
  if (!prof) return json({ ok: false, error: "member_not_found" }, 404);

  const { error } = await admin.rpc("add_purchased_credits", { p_user: id, p_amount: amount, p_feature: "owner_grant" });
  if (error) return json({ ok: false, error: "grant_failed", detail: error.message.slice(0, 160) }, 500);

  return json({ ok: true, granted: amount, balance: await balanceOf(admin, id) });
}
