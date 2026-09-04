import { type NextRequest } from "next/server";
import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { listMemberAccounts } from "@/lib/matty-pips/broker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * MATTY PIPS AUTO — per-account settings. Members opt their OWN accounts in
 * (default OFF) and choose risk %, BE and partials. Stored ONLY in
 * matty_pips_accounts; FLOW's tables and behavior are untouched — this is the
 * backend for both the Matty Pips auto panel AND the Matty Pips toggle shown
 * on Flow's account cards.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const profile = await getProfile();
  if (!profile) return json({ ok: false, error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "not_configured" }, 500);
  const accounts = await listMemberAccounts(admin, profile.id);
  return json({ ok: true, accounts });
}

export async function POST(req: NextRequest) {
  const profile = await getProfile();
  if (!profile) return json({ ok: false, error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "not_configured" }, 500);
  let body: { accountId?: string; connectionId?: string; accNum?: string; enabled?: boolean; riskPct?: number; beEnabled?: boolean; partialsEnabled?: boolean; mode?: string } = {};
  try { body = await req.json(); } catch { /* */ }
  if (!body.accountId || !body.connectionId || !body.accNum) return json({ ok: false, error: "missing_account" }, 400);

  // The account must actually belong to one of THIS member's connections.
  const mine = await listMemberAccounts(admin, profile.id);
  const target = mine.find((a) => a.account_id === String(body.accountId) && a.connection_id === String(body.connectionId));
  if (!target) return json({ ok: false, error: "account_not_yours" }, 403);

  const riskPct = body.riskPct != null ? Math.max(0.1, Math.min(3, Number(body.riskPct))) : undefined;
  const patch: Record<string, unknown> = {
    user_id: profile.id, connection_id: target.connection_id, account_id: target.account_id, acc_num: target.acc_num,
    name: target.name, currency: target.currency, updated_at: new Date().toISOString(),
  };
  if (body.enabled != null) patch.enabled = body.enabled === true;
  if (riskPct != null && Number.isFinite(riskPct)) patch.risk_pct = riskPct;
  if (body.beEnabled != null) patch.be_enabled = body.beEnabled !== false;
  if (body.partialsEnabled != null) patch.partials_enabled = body.partialsEnabled !== false;
  if (body.mode) patch.mode = body.mode === "aggressive" ? "aggressive" : "conservative";

  const { error } = await admin.from("matty_pips_accounts").upsert(patch, { onConflict: "user_id,account_id" });
  if (error) return json({ ok: false, error: error.message.slice(0, 140) }, 500);
  const accounts = await listMemberAccounts(admin, profile.id);
  return json({ ok: true, accounts });
}
