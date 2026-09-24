import { createClient } from "@/lib/supabase/server";
import { DAILY_FREE, CREDIT_COST, GENX_FAIR_USE_PER_DAY, isPassCovered, type Feature } from "@/lib/creditConfig";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasFlowPass } from "@/lib/subscription";

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

/**
 * THE FLOW PASS CHOKEPOINT.
 *
 * Every metered route already funnels through gateCredits() + chargeCredit(), so the Pass is honoured
 * HERE, once, rather than by editing each route and eventually missing one. While a member's Pass is
 * active, a PASS_COVERED feature (flow_autorun, genx) is free: the gate always opens and the charge is
 * a no-op.
 *
 * Two deliberate choices:
 *  - FAILS CLOSED. Any error looking up the Pass means "no Pass", so the member is metered normally.
 *    A wrong charge is refundable; handing every feature to everyone on a transient DB error is not.
 *  - STILL LOGGED. Covered use writes a ZERO-amount ledger row (kind "pass"), so Pass usage is visible
 *    in the same place as everything else and the fair-use counter has something to count. Zero rows
 *    are invisible to the existing spend/revenue queries, which all filter on amount <> 0.
 */
type PassCheck = { covered: boolean; reason?: "fair_use" };
async function passCovers(feature: Feature, userId: string): Promise<PassCheck> {
  try {
    if (!isPassCovered(feature)) return { covered: false };
    const admin = createAdminClient();
    if (!admin) return { covered: false };
    if (!(await hasFlowPass(userId, admin))) return { covered: false };
    // Fair use applies only to the on-demand AI call, never to the automation.
    if (feature === "genx") {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { count, error } = await admin
        .from("credit_transactions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId).eq("feature", "genx").eq("kind", "pass").gte("created_at", since);
      if (!error && (count ?? 0) >= GENX_FAIR_USE_PER_DAY) return { covered: false, reason: "fair_use" };
    }
    return { covered: true };
  } catch { return { covered: false }; }
}

/** Record covered (free) usage so it is auditable and countable. Never throws, never moves a balance. */
async function logPassUse(feature: Feature, userId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    if (!admin) return;
    await admin.from("credit_transactions").insert({ user_id: userId, amount: 0, feature, kind: "pass" });
  } catch { /* ledger is best-effort */ }
}



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
  // FLOW Pass: a covered feature opens regardless of balance — that is what the member is paying for.
  if ((await passCovers(feature, user.id)).covered) {
    const d0 = data as { daily_left?: number; purchased?: number; daily_allowance?: number };
    return { ok: true, balance: { dailyLeft: d0.daily_left ?? DAILY_FREE, purchased: d0.purchased ?? 0, dailyAllowance: d0.daily_allowance ?? DAILY_FREE } };
  }
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
    // FLOW Pass: covered features are free — log the use, move no credits, return the live balance.
    if ((await passCovers(feature, user.id)).covered) {
      await logPassUse(feature, user.id);
      return await readBalance();
    }
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
