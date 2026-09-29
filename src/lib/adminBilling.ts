/**
 * WHO BOUGHT WHAT (owner 09-29: "a spot where i can see what users have purchased what and whos on the
 * subscription … just need to see what pack they bought or if they are also on subscription").
 *
 * One read for the whole Approvals page: every credit-pack purchase and auto-refill top-up in the
 * ledger, every subscription row, and every auto-refill setting, folded into one summary per member.
 * Grants (owner/admin/promo/trial) are deliberately NOT counted as purchases — the owner wants to see
 * money in, not credits handed out. Read-only; nothing here writes.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { FLOW_PASS, PACKS, SUITE } from "@/lib/creditConfig";
import { isActive, PLAN_FLOW_PASS, PLAN_SUITE, type SubRow } from "@/lib/subscription";

export type PackKey = "starter" | "trader" | "pro" | "autorefill";

export type MemberBilling = {
  /** How many times each pack was bought (auto-refill counts each card top-up). */
  packs: Record<PackKey, number>;
  /** Credits actually paid for, all time. */
  creditsBought: number;
  lastPurchaseAt: string | null;
  /** The member's subscription row, if any — active or not, so a lapsed one still shows as lapsed. */
  sub: { plan: string; label: string; status: string; active: boolean; periodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  /** Card-on-file auto-refill, when the member has set it up. */
  autoRefill: { enabled: boolean; credits: number | null; last4: string | null } | null;
};

export const PACK_LABELS: Record<PackKey, string> = {
  starter: `${PACKS.find((p) => p.id === "starter")?.label ?? "Starter"} (${PACKS.find((p) => p.id === "starter")?.credits ?? 50})`,
  trader: `${PACKS.find((p) => p.id === "trader")?.label ?? "Trader"} (${PACKS.find((p) => p.id === "trader")?.credits ?? 200})`,
  pro: `${PACKS.find((p) => p.id === "pro")?.label ?? "Pro"} (${PACKS.find((p) => p.id === "pro")?.credits ?? 500})`,
  autorefill: "Auto-refill top-up",
};

/** Ledger features that are real purchases. Everything else in `kind='purchase'` is a grant. */
const PURCHASE_FEATURES: Record<string, PackKey> = {
  pack_starter: "starter",
  pack_trader: "trader",
  pack_pro: "pro",
  autorefill: "autorefill",
};

function planLabel(plan: string): string {
  if (plan === PLAN_FLOW_PASS) return FLOW_PASS.label;
  if (plan === PLAN_SUITE) return SUITE.label;
  return plan;
}

const empty = (): MemberBilling => ({
  packs: { starter: 0, trader: 0, pro: 0, autorefill: 0 },
  creditsBought: 0,
  lastPurchaseAt: null,
  sub: null,
  autoRefill: null,
});

/** Pure fold, so the shape is testable without a database. */
export function foldBilling(
  purchases: { user_id: string; feature: string; amount: number | null; created_at: string }[],
  subs: SubRow[],
  refills: { user_id: string; enabled: boolean | null; refill_credits: number | null; card_last4: string | null }[],
): Record<string, MemberBilling> {
  const out: Record<string, MemberBilling> = {};
  const get = (id: string) => (out[id] ??= empty());
  for (const p of purchases) {
    const key = PURCHASE_FEATURES[p.feature];
    if (!key) continue;
    const b = get(p.user_id);
    b.packs[key] += 1;
    b.creditsBought += Math.max(0, Number(p.amount) || 0);
    if (!b.lastPurchaseAt || Date.parse(p.created_at) > Date.parse(b.lastPurchaseAt)) b.lastPurchaseAt = p.created_at;
  }
  for (const s of subs) {
    const b = get(s.user_id);
    b.sub = {
      plan: s.plan,
      label: planLabel(s.plan),
      status: s.status,
      active: isActive(s),
      periodEnd: s.current_period_end ?? null,
      cancelAtPeriodEnd: !!s.cancel_at_period_end,
    };
  }
  for (const r of refills) {
    const b = get(r.user_id);
    b.autoRefill = { enabled: r.enabled === true, credits: r.refill_credits ?? null, last4: r.card_last4 ?? null };
  }
  return out;
}

/** Every member's purchases + subscription, keyed by user id. Empty map on any read failure. */
export async function loadMemberBilling(): Promise<Record<string, MemberBilling>> {
  const admin = createAdminClient();
  if (!admin) return {};
  try {
    const [purchases, subs, refills] = await Promise.all([
      admin.from("credit_transactions")
        .select("user_id, feature, amount, created_at")
        .eq("kind", "purchase")
        .in("feature", Object.keys(PURCHASE_FEATURES))
        .limit(10000),
      admin.from("user_subscriptions").select("*").limit(10000),
      admin.from("user_autorefill").select("user_id, enabled, refill_credits, card_last4").limit(10000),
    ]);
    return foldBilling(
      (purchases.data ?? []) as { user_id: string; feature: string; amount: number | null; created_at: string }[],
      (subs.data ?? []) as SubRow[],
      (refills.data ?? []) as { user_id: string; enabled: boolean | null; refill_credits: number | null; card_last4: string | null }[],
    );
  } catch {
    return {};
  }
}
