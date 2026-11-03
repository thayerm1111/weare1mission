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
  /** Set while the member has paused billing (Stripe pause_collection). */
  paused_at?: string | null;
  /** The end of the month they had paid for when they paused: the Pass runs to here and no further. */
  paid_through?: string | null;
};

/**
 * RENEWAL GRACE (owner 11-02). Stripe takes a renewal at the period end; the record catches up when the
 * renewal reaches us (webhook) or, failing that, on the hourly re-sync (subscriptionSync.ts). In between, a
 * subscription Stripe last told us was active keeps its benefits. Five Pass members lost theirs the moment
 * the date passed because the renewal never arrived; the re-sync makes that impossible to last, and this
 * makes the hour it takes invisible. A subscription set to cancel, or paused, gets no grace: it ends on
 * its date.
 */
export const RENEWAL_GRACE_MS = 36 * 3_600_000;

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/** Is this subscription currently entitled to its plan's benefits? */
export function isActive(sub: SubRow | null, nowMs: number = Date.now()): boolean {
  if (!sub) return false;
  if (sub.status !== "active" && sub.status !== "trialing") return false;
  // Paused: the month they paid for, and not a minute more (Stripe keeps a paused subscription "active").
  if (sub.paused_at) {
    const until = Date.parse(String(sub.paid_through ?? sub.current_period_end ?? ""));
    return Number.isFinite(until) && until > nowMs - 60_000;
  }
  if (sub.current_period_end) {
    const end = Date.parse(sub.current_period_end);
    if (!Number.isFinite(end)) return true;
    return end > nowMs - (sub.cancel_at_period_end ? 60_000 : RENEWAL_GRACE_MS);
  }
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

/**
 * Browser-safe view of a subscription for the account UI — including the date the member is next charged
 * (owner 11-02: "add the date they will get charged"). `nextChargeAt` is null whenever no charge is coming:
 * set to cancel, or paused. `endsAt` is when the plan stops if nothing changes (cancel or pause), else null.
 * A renewal date already in the past (the record is catching up) shows as unknown rather than as a past date.
 */
export function safeSubView(sub: SubRow | null, nowMs: number = Date.now()) {
  const active = isActive(sub, nowMs);
  const paused = !!sub?.paused_at;
  const canceling = !!sub?.cancel_at_period_end && !paused;
  const periodEnd = sub?.current_period_end ?? null;
  const future = (v: string | null | undefined) => (v && Date.parse(v) > nowMs ? v : null);
  return {
    active,
    status: sub?.status ?? "inactive",
    cancelAtPeriodEnd: !!sub?.cancel_at_period_end,
    currentPeriodEnd: periodEnd,
    canceledAt: sub?.canceled_at ?? null,
    paused,
    pausedAt: sub?.paused_at ?? null,
    paidThrough: sub?.paid_through ?? null,
    nextChargeAt: active && !paused && !canceling ? future(periodEnd) : null,
    endsAt: paused ? (sub?.paid_through ?? periodEnd) : canceling ? periodEnd : null,
    paymentIssue: sub?.status === "past_due" || sub?.status === "unpaid" || sub?.status === "incomplete",
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
