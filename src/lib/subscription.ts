import { createAdminClient } from "@/lib/supabase/admin";
import { FLOW_PASS } from "@/lib/creditConfig";

/**
 * Trading Suite subscription helpers (server-only).
 *
 * Source of truth is the `user_subscriptions` row, written ONLY by the Stripe
 * webhook and the /api/subscription route (never the browser). A member is
 * "active" when status is active/trialing and the paid period hasn't lapsed — a
 * member who cancels keeps access until current_period_end (cancel_at_period_end).
 */
export type SubRow = {
  user_id: string;
  plan: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
};

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/** Is this subscription currently entitled to Suite benefits? */
export function isActive(sub: SubRow | null): boolean {
  if (!sub) return false;
  if (sub.status !== "active" && sub.status !== "trialing") return false;
  // Grace: if we have a period end, honor it (covers cancel-at-period-end).
  if (sub.current_period_end) return Date.parse(sub.current_period_end) > Date.now() - 60_000;
  return true;
}

/** Read a member's subscription row (or null). Pass an admin client to reuse one. */
export async function getSubscription(userId: string, admin?: Admin | null): Promise<SubRow | null> {
  const db = admin ?? createAdminClient();
  if (!db) return null;
  const { data } = await db.from("user_subscriptions").select("*").eq("user_id", userId).maybeSingle();
  return (data as SubRow) ?? null;
}

/** Fast boolean: does this member have an active Trading Suite subscription? */
export async function hasActiveSuite(userId: string, admin?: Admin | null): Promise<boolean> {
  return isActive(await getSubscription(userId, admin));
}

/** Browser-safe view of a subscription for the account UI. */
export function safeSubView(sub: SubRow | null) {
  return {
    active: isActive(sub),
    status: sub?.status ?? "inactive",
    cancelAtPeriodEnd: !!sub?.cancel_at_period_end,
    currentPeriodEnd: sub?.current_period_end ?? null,
    canceledAt: sub?.canceled_at ?? null,
  };
}

/*
 * PLANS. `user_subscriptions` holds at most ONE row per member (keyed on user_id), so a member is on
 * exactly one trading plan at a time: the legacy $39 Trading Suite, or the $99 FLOW Pass. Upgrading
 * overwrites the row — which is why the upgrade path must cancel the old Stripe subscription first,
 * or the member would be billed twice while the row shows only the newer plan.
 * ATLAS voice lives in its own table and is never one of these.
 */
export const PLAN_SUITE = "trading_suite";
export const PLAN_FLOW_PASS = FLOW_PASS.key;

/** Is this row an ACTIVE FLOW Pass? (active plan + active status) */
export function isFlowPass(sub: SubRow | null): boolean {
  return !!sub && sub.plan === PLAN_FLOW_PASS && isActive(sub);
}

/**
 * Does this member have an active FLOW Pass — i.e. is FLOW/GENX free for them right now?
 *
 * FAILS CLOSED. Every other billing read in this codebase fails OPEN so a DB blip never blocks a
 * paying member. This one is the opposite: if we cannot confirm the Pass, we report NO pass and the
 * member is metered as normal. Failing open here would hand the entire product to everyone for free
 * on a transient error, and an over-charge can be refunded while a giveaway cannot be clawed back.
 */
export async function hasFlowPass(userId: string, admin?: Admin | null): Promise<boolean> {
  try {
    const db = admin ?? createAdminClient();
    if (!db) return false;
    const { data, error } = await db.from("user_subscriptions").select("*").eq("user_id", userId).maybeSingle();
    if (error) return false;
    return isFlowPass((data as SubRow) ?? null);
  } catch { return false; }
}

/** Which of these members hold an active Pass? Batched for the billing fan-outs. Fails closed (empty). */
export async function flowPassUserIds(admin: Admin, userIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userIds.length) return out;
  try {
    const { data, error } = await admin.from("user_subscriptions").select("*").in("user_id", userIds).eq("plan", PLAN_FLOW_PASS);
    if (error) return out;
    for (const r of (data ?? []) as SubRow[]) if (isFlowPass(r)) out.add(String(r.user_id));
  } catch { /* fail closed */ }
  return out;
}
