import { createClient as adminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { CREDIT_COST, DAILY_FREE } from "@/lib/creditConfig";

/**
 * COMMAND CENTER ACCESS — 5 credits for 30 minutes (owner 09-21).
 *
 * The clock starts the moment the member opens it. There is no separate table: the pass IS the credit
 * transaction. The newest `command_center` spend in the last 30 minutes means the member has an open
 * window until that spend + 30 minutes. That keeps one source of truth (the ledger the member already
 * sees) and makes a double-charge impossible to hide.
 *
 * Nothing renews on its own. When the window ends, the member is asked; nobody is charged for a tab
 * they forgot was open. Admins are not charged.
 */
export const CC_PASS_MS = 30 * 60_000;
export const CC_PASS_COST = CREDIT_COST.command_center;

export type PassState = {
  active: boolean;
  admin: boolean;
  expiresAt: string | null;
  cost: number;
  minutes: number;
  balance: number | null;
};

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && sk ? adminClient(url, sk, { auth: { persistSession: false } }) : null;
}

async function isAdmin(userId: string): Promise<boolean> {
  const c = admin(); if (!c) return false;
  const { data } = await c.from("profiles").select("role").eq("id", userId).maybeSingle();
  return (data as { role?: string } | null)?.role === "admin";
}

/** When does this member's current window end? null = no open window. */
export async function passExpiry(userId: string): Promise<number | null> {
  const c = admin(); if (!c) return null;
  const since = new Date(Date.now() - CC_PASS_MS).toISOString();
  const { data } = await c.from("credit_transactions").select("created_at")
    .eq("user_id", userId).eq("feature", "command_center").eq("kind", "spend")
    .gte("created_at", since).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const at = (data as { created_at?: string } | null)?.created_at;
  return at ? Date.parse(at) + CC_PASS_MS : null;
}

async function balanceOf(supabase: NonNullable<ReturnType<typeof createClient>>): Promise<number | null> {
  const { data, error } = await supabase.rpc("get_credit_balance", { p_daily_allowance: DAILY_FREE });
  if (error || !data) return null;
  const d = data as { daily_left?: number; purchased?: number };
  return (d.daily_left ?? 0) + (d.purchased ?? 0);
}

/** Read-only: is the window open? */
export async function passState(userId: string, supabase: NonNullable<ReturnType<typeof createClient>>): Promise<PassState> {
  const base = { cost: CC_PASS_COST, minutes: CC_PASS_MS / 60_000 };
  if (await isAdmin(userId)) return { ...base, active: true, admin: true, expiresAt: null, balance: null };
  const exp = await passExpiry(userId);
  return { ...base, active: exp != null && exp > Date.now(), admin: false, expiresAt: exp ? new Date(exp).toISOString() : null, balance: await balanceOf(supabase) };
}

/**
 * Open a window. Idempotent while one is open (returns it, charges nothing). Otherwise spends the
 * credits through the same spend_credits function every metered feature uses, and only reports the
 * window open once the spend succeeded.
 */
export async function openPass(userId: string, supabase: NonNullable<ReturnType<typeof createClient>>): Promise<PassState & { error?: "insufficient" | "charge_failed" }> {
  const cur = await passState(userId, supabase);
  if (cur.active) return cur;
  const { data, error } = await supabase.rpc("spend_credits", { p_cost: CC_PASS_COST, p_daily_allowance: DAILY_FREE, p_feature: "command_center" });
  const d = (data ?? {}) as { ok?: boolean; daily_left?: number; purchased?: number };
  if (error || !d.ok) {
    const bal = await balanceOf(supabase);
    return { ...cur, balance: bal, error: bal != null && bal < CC_PASS_COST ? "insufficient" : "charge_failed" };
  }
  const exp = Date.now() + CC_PASS_MS;
  return { ...cur, active: true, expiresAt: new Date(exp).toISOString(), balance: (d.daily_left ?? 0) + (d.purchased ?? 0) };
}

/** For data routes: true when this member may be served Command Center data right now. */
export async function hasPass(userId: string): Promise<boolean> {
  if (await isAdmin(userId)) return true;
  const exp = await passExpiry(userId);
  return exp != null && exp > Date.now();
}
