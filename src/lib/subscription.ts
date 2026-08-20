import { createAdminClient } from "@/lib/supabase/admin";

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
