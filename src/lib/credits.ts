import { createClient } from "@/lib/supabase/server";
import { DAILY_FREE, CREDIT_COST, type Feature } from "@/lib/creditConfig";

/**
 * Server-side credit helpers. The pattern in the metered routes is:
 *   1) `gateCredits(feature)` BEFORE the expensive work — reject if the member
 *      is out of credits (so we never do paid work for free).
 *   2) `chargeCredit(feature)` AFTER the work SUCCEEDS — so a member is never
 *      charged for a call that failed (e.g. a data rate-limit).
 * If Supabase or the credit tables aren't available, everything fails OPEN so
 * the product never breaks because of the billing layer.
 */

export type Balance = { dailyLeft: number; purchased: number; dailyAllowance: number };

type Gate =
  | { ok: true; balance: Balance }
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "insufficient"; balance: Balance };

export async function gateCredits(feature: Feature, client?: ReturnType<typeof createClient>): Promise<Gate> {
  const supabase = client ?? createClient();
  const fallback: Balance = { dailyLeft: DAILY_FREE, purchased: 0, dailyAllowance: DAILY_FREE };
  if (!supabase) return { ok: true, balance: fallback };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: "unauthorized" };
  const cost = CREDIT_COST[feature] ?? 1;
  const { data, error } = await supabase.rpc("get_credit_balance", { p_daily_allowance: DAILY_FREE });
  if (error || !data) return { ok: true, balance: fallback }; // fail open (not migrated / transient)
  const d = data as { daily_left?: number; purchased?: number; daily_allowance?: number };
  const balance: Balance = {
    dailyLeft: d.daily_left ?? DAILY_FREE,
    purchased: d.purchased ?? 0,
    dailyAllowance: d.daily_allowance ?? DAILY_FREE,
  };
  if (balance.dailyLeft + balance.purchased < cost) return { ok: false, reason: "insufficient", balance };
  return { ok: true, balance };
}

/** Spend the credit after the work succeeded. Best-effort: never throws. */
export async function chargeCredit(feature: Feature, client?: ReturnType<typeof createClient>): Promise<Balance | null> {
  try {
    const supabase = client ?? createClient();
    if (!supabase) return null;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const cost = CREDIT_COST[feature] ?? 1;
    const { data, error } = await supabase.rpc("spend_credits", { p_cost: cost, p_daily_allowance: DAILY_FREE, p_feature: feature });
    if (error || !data) return null;
    const d = data as { ok?: boolean; daily_left?: number; purchased?: number; daily_allowance?: number };
    if (!d.ok) return null;
    return { dailyLeft: d.daily_left ?? 0, purchased: d.purchased ?? 0, dailyAllowance: d.daily_allowance ?? DAILY_FREE };
  } catch { return null; }
}

export async function readBalance(): Promise<Balance | null> {
  const supabase = createClient();
  if (!supabase) return { dailyLeft: DAILY_FREE, purchased: 0, dailyAllowance: DAILY_FREE };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.rpc("get_credit_balance", { p_daily_allowance: DAILY_FREE });
  if (error || !data) return { dailyLeft: DAILY_FREE, purchased: 0, dailyAllowance: DAILY_FREE };
  const d = data as { daily_left?: number; purchased?: number; daily_allowance?: number };
  return { dailyLeft: d.daily_left ?? DAILY_FREE, purchased: d.purchased ?? 0, dailyAllowance: d.daily_allowance ?? DAILY_FREE };
}
