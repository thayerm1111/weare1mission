import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { accountEquity } from "@/lib/flow/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Member risk preferences for semi-auto play execution.
 *   GET  → saved account size + default risk %, plus LIVE broker equity when a
 *          TradeLocker account is connected (so the UI can size off the real
 *          balance and only fall back to the saved number when offline).
 *   POST → save { accountSize?, riskPct? }.
 * Member-auth only; a member only ever reads/writes their own row.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

async function getUser() {
  const supabase = createClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function GET() {
  const user = await getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  type Saved = { account_size?: number | null; risk_pct?: number | null };
  let saved: Saved | null = null;
  if (admin) {
    const { data } = await admin.from("flow_trade_prefs").select("account_size, risk_pct").eq("user_id", user.id).maybeSingle();
    saved = (data as Saved | null) ?? null;
  }
  const eq = await accountEquity(user.id);
  return json({
    accountSize: saved && num(saved.account_size) != null ? num(saved.account_size) : null,
    riskPct: saved && num(saved.risk_pct) != null ? num(saved.risk_pct) : 1,
    liveEquity: eq.ok ? eq.equity : null,
    liveCurrency: eq.ok ? eq.currency : null,
    connected: eq.ok,
  });
}

export async function POST(req: NextRequest) {
  const user = await getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ error: "server_not_configured" }, 500);

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* */ }
  const accountSize = num(body.accountSize);
  const riskPct = num(body.riskPct);

  const row: Record<string, unknown> = { user_id: user.id, updated_at: new Date().toISOString() };
  if (accountSize != null) row.account_size = Math.max(0, accountSize);
  if (riskPct != null) row.risk_pct = Math.min(100, Math.max(0.01, riskPct));

  const { error } = await admin.from("flow_trade_prefs").upsert(row, { onConflict: "user_id" });
  if (error) return json({ ok: false, error: error.message }, 200);
  return json({ ok: true, accountSize: accountSize ?? null, riskPct: riskPct ?? null });
}
