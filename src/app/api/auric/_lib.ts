import { authedContext } from "@/lib/supabase/bearer";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export type Ctx = { user: { id: string; email?: string }; supabase: SupabaseClient; admin: SupabaseClient; isAdmin: boolean };

/** Every AURIC route: authenticated user + service client; admin flag from profiles.role (never from user-editable metadata). */
export async function ctx(req: Request): Promise<{ ok: true; c: Ctx } | { ok: false; res: Response }> {
  const a = await authedContext(req);
  if (!a.configured) return { ok: false, res: json({ error: "not_configured" }, 503) };
  if (!a.user) return { ok: false, res: json({ error: "unauthorized" }, 401) };
  const admin = createAdminClient();
  if (!admin) return { ok: false, res: json({ error: "not_configured" }, 503) };
  const { data: me } = await admin.from("profiles").select("role, status").eq("id", a.user.id).maybeSingle();
  if (me?.status === "suspended") return { ok: false, res: json({ error: "suspended" }, 403) };
  return { ok: true, c: { user: { id: a.user.id, email: a.user.email }, supabase: a.supabase as unknown as SupabaseClient, admin, isAdmin: me?.role === "admin" } };
}

/** Account-scoped authorization: the row must belong to the caller. */
export async function ownedAccount(c: Ctx, accountId: string) {
  if (!accountId || !/^[0-9a-f-]{36}$/i.test(accountId)) return null;
  const { data } = await c.admin.from("auric_accounts").select("*").eq("id", accountId).eq("user_id", c.user.id).maybeSingle();
  return data;
}

export async function readSettings(c: Ctx) {
  const { data } = await c.admin.from("auric_settings").select("key, value");
  const s: Record<string, unknown> = {}; for (const r of data ?? []) s[r.key] = r.value; return s;
}

export const CONSENT_VERSION = "auric-consent-2026-09-22";
export const CONSENT_TEXT = `AURIC is an automated XAUUSD CFD trading engine. By enabling it on the selected broker account you authorize AURIC to place, protect, modify and close positions on that account according to its published rules and your selected risk fraction, without asking before each trade during an active session. Trading CFDs on gold is high risk; losses can exceed the estimated risk during gaps or slippage, and stop-loss orders are execution instructions, not guarantees. AURIC targets $5–$10 movements in the quoted gold price; that is a price objective, not a promised return. Credits purchase monitoring and automation access for a time-limited session; a session may produce no trades and does not guarantee profit. AURIC has no established track record of profitability; historical evaluation results are shown with their limitations. Consent applies only to AURIC and only to this account; it does not enable any other One Mission product and can be revoked at any time (open positions remain yours and stay protected).`;
