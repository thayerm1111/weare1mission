import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Promo "rich" grant — every member who signs up with promo code "rich"
 * (profiles.conectiv_id = 'rich', case-insensitive) gets a ONE-TIME 100-credit
 * top-up so they can use the platform.
 *
 * The retroactive grant was applied directly to every existing 'rich' member.
 * This is the going-forward, self-healing hook: the first time a 'rich' member
 * with no prior grant loads their balance (app → /api/me, web → /api/credits),
 * they receive the 100 credits. It is idempotent — the credit_transactions
 * ledger row (feature = 'promo_rich') that add_purchased_credits writes is the
 * source of truth, so a member is never granted twice even across many loads.
 * A DB trigger would be cleaner but isn't available here; this covers future
 * 'rich' sign-ups on their next visit with no schema change.
 */
const PROMO_CODE = "rich";
const PROMO_AMOUNT = 100;
const PROMO_FEATURE = "promo_rich";

export async function ensurePromoRichCredits(userId: string | null | undefined): Promise<void> {
  try {
    if (!userId) return;
    const admin = createAdminClient();
    if (!admin) return;

    // Only members who used promo code "rich" qualify.
    const { data: prof } = await admin
      .from("profiles")
      .select("conectiv_id")
      .eq("id", userId)
      .maybeSingle();
    const code = ((prof as { conectiv_id?: string | null } | null)?.conectiv_id ?? "").trim().toLowerCase();
    if (code !== PROMO_CODE) return;

    // Already granted? The ledger row makes this self-healing and idempotent.
    const { data: prior } = await admin
      .from("credit_transactions")
      .select("id")
      .eq("user_id", userId)
      .eq("feature", PROMO_FEATURE)
      .limit(1)
      .maybeSingle();
    if (prior) return;

    // Grant: add_purchased_credits bumps user_credits.balance AND writes the
    // credit_transactions ledger row (feature = 'promo_rich') that the guard
    // above reads on the next load.
    await admin.rpc("add_purchased_credits", {
      p_user: userId,
      p_amount: PROMO_AMOUNT,
      p_feature: PROMO_FEATURE,
    });
  } catch {
    /* best-effort — never break a balance read because of the promo grant */
  }
}
