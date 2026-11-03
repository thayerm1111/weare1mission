import type Stripe from "stripe";
import type { createAdminClient } from "@/lib/supabase/admin";
import { SUITE, FLOW_PASS } from "@/lib/creditConfig";
import { isActive, type SubRow } from "@/lib/subscription";

/**
 * KEEPING user_subscriptions IN STEP WITH STRIPE (owner 11-02).
 *
 * WHAT WENT WRONG. A FLOW Pass member (pmwneal, 10-28) was charged his $99 renewal and the site stopped
 * treating him as a Pass holder the same evening. Four more Pass members followed as their months came up.
 * The renewal was taken by Stripe but never written here: the row kept the first month's end date, and
 * once that passed the Pass read as expired — FLOW and GENX went back on the meter (76 credits between
 * them), and the Credits page offered them the Pass they were already paying for, with no Cancel button.
 *
 * Two reasons, both fixed here:
 *  - The renewal handler read `invoice.subscription`. Newer Stripe API versions deliver invoices with the
 *    subscription under `parent.subscription_details.subscription` instead, so every renewal was dropped.
 *    The id is now read from wherever the payload carries it, and the period end likewise (newer
 *    versions move it from the subscription onto its items).
 *  - Nothing ever checked a subscription again after a missed event. The hourly re-sync
 *    (/api/cron/subscriptions-sync) now reads every subscription that is due, from Stripe itself, so a
 *    lost or malformed event costs a member an hour at most.
 *
 * PAUSE (owner 11-02: "stop billing until resumed"). Stripe's pause_collection voids the invoices while a
 * subscription is paused; the subscription itself stays "active" and its periods keep rolling. So the row
 * records when the member paused (`paused_at`) and the end of the month they had paid for
 * (`paid_through`), and the Pass is honoured up to that date only (subscription.isActive).
 */

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/** The subscription fields we read, in either API shape. */
export type StripeSubLike = {
  id: string; status: string; customer: string | { id: string } | null;
  current_period_end?: number | null;
  items?: { data?: Array<{ current_period_end?: number | null }> } | null;
  cancel_at_period_end?: boolean | null; canceled_at?: number | null;
  pause_collection?: { behavior?: string | null; resumes_at?: number | null } | null;
  metadata?: Record<string, string> | null;
  latest_invoice?: string | { id: string; status?: string | null } | null;
};

/** The end of the current period, in seconds: on the subscription (older API) or on its items (newer). */
export function periodEndSec(s: StripeSubLike): number | null {
  if (typeof s.current_period_end === "number" && s.current_period_end > 0) return s.current_period_end;
  const ends = (s.items?.data ?? []).map((i) => Number(i?.current_period_end)).filter((n) => Number.isFinite(n) && n > 0);
  return ends.length ? Math.max(...ends) : null;
}

/** The subscription an invoice belongs to, wherever this API version puts it. */
export function subscriptionIdOfInvoice(inv: unknown): string | null {
  const o = (inv ?? {}) as Record<string, unknown>;
  const idOf = (v: unknown): string | null => (typeof v === "string" && v ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);
  const direct = idOf(o.subscription);
  if (direct) return direct;
  const parent = o.parent as { subscription_details?: { subscription?: unknown } } | null | undefined;
  const viaParent = idOf(parent?.subscription_details?.subscription);
  if (viaParent) return viaParent;
  const lines = (o.lines as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
  for (const l of lines) {
    const a = idOf(l.subscription);
    if (a) return a;
    const p = l.parent as { subscription_item_details?: { subscription?: unknown } } | null | undefined;
    const b = idOf(p?.subscription_item_details?.subscription);
    if (b) return b;
  }
  return null;
}

export type ExistingRow = { stripe_subscription_id?: string | null; status?: string | null; paused_at?: string | null; paid_through?: string | null } | null;

const iso = (sec?: number | null) => (sec ? new Date(sec * 1000).toISOString() : null);
const ENDED = new Set(["canceled", "incomplete_expired"]);

/**
 * What the member's row should say about this Stripe subscription — or null when it must not be written:
 * a subscription that has ended never overwrites a row that holds a DIFFERENT subscription (the $39 Suite
 * a member upgraded from, cancelled by the upgrade, must not erase the Pass that replaced it).
 * Pure, so the rules can be tested without Stripe.
 */
export function rowFromStripe(s: StripeSubLike, userId: string, existing: ExistingRow, nowIso: string): Record<string, unknown> | null {
  if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== s.id && ENDED.has(String(s.status))) return null;
  const plan = s.metadata?.plan === FLOW_PASS.tag ? FLOW_PASS.key : "trading_suite";
  const periodEnd = iso(periodEndSec(s));
  const sameSub = !existing?.stripe_subscription_id || existing.stripe_subscription_id === s.id;
  // Paused at Stripe: keep the date the member paused and the month they paid for. The first sync that sees a
  // pause (one started outside the site) takes the current period as the paid one.
  let pausedAt: string | null = null, paidThrough: string | null = null;
  if (s.pause_collection && !ENDED.has(String(s.status))) {
    pausedAt = (sameSub && existing?.paused_at) || nowIso;
    paidThrough = (sameSub && existing?.paused_at && existing?.paid_through) || periodEnd;
  }
  return {
    user_id: userId, plan, status: s.status,
    stripe_customer_id: typeof s.customer === "string" ? s.customer : s.customer?.id ?? null,
    stripe_subscription_id: s.id,
    current_period_end: periodEnd,
    cancel_at_period_end: !!s.cancel_at_period_end,
    canceled_at: iso(s.canceled_at ?? null),
    paused_at: pausedAt,
    paid_through: paidThrough,
    updated_at: nowIso,
  };
}

export type SyncResult = { userId: string; status: string; periodKey: string; plan: string; monthly: number; paused: boolean; latestInvoicePaid: boolean | null };

/**
 * Mirror a Stripe subscription into user_subscriptions. Returns what the caller needs to grant the month's
 * credits (or null when there is no member, or the write was refused as above).
 */
export async function syncSubscription(admin: Admin, stripe: Stripe, subscriptionId: string, userIdHint?: string | null): Promise<SyncResult | null> {
  const s = (await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] })) as unknown as StripeSubLike;
  const userId = userIdHint || s.metadata?.user_id || null;
  if (!userId) return null;
  let existing: ExistingRow = null;
  try {
    const { data } = await admin.from("user_subscriptions").select("stripe_subscription_id, status, paused_at, paid_through").eq("user_id", userId).maybeSingle();
    existing = (data as ExistingRow) ?? null;
  } catch { /* no row yet */ }
  const row = rowFromStripe(s, userId, existing, new Date().toISOString());
  if (!row) return null;
  await admin.from("user_subscriptions").upsert(row, { onConflict: "user_id" });
  const plan = String(row.plan);
  // A running Pass is never credit-paused (flowBilling: Pass holders trade and are never charged). A member who
  // ran dry before the Pass took effect — or while a renewal was catching up, as the five did — keeps the old
  // flag otherwise, because only a successful charge clears it and a Pass holder is never charged: their
  // accounts would sit out the warm-up fleet and show as paused. Clear it whenever the Pass reads as running.
  if (plan === FLOW_PASS.key && isActive(row as unknown as SubRow)) {
    try {
      await admin.from("flow_broker_accounts").update({ flow_credit_paused: false }).eq("user_id", userId).eq("flow_credit_paused", true);
      await admin.from("flow_auto_settings").update({ credit_paused: false }).eq("user_id", userId).eq("credit_paused", true);
    } catch { /* best-effort: a later sync or charge clears it */ }
  }
  const li = s.latest_invoice;
  const latestInvoicePaid = li && typeof li === "object" ? li.status === "paid" : null;
  return {
    userId, status: s.status, periodKey: String(periodEndSec(s) ?? ""), plan,
    monthly: plan === FLOW_PASS.key ? FLOW_PASS.monthlyCredits : SUITE.monthlyCredits,
    paused: row.paused_at != null, latestInvoicePaid,
  };
}

/** Grant the month's allowance: top the balance UP TO the plan's amount for this billing period (no rollover,
 *  no stacking). Idempotent per period. */
export async function grantSuiteMonth(admin: Admin, userId: string, periodKey: string, amount: number = SUITE.monthlyCredits): Promise<void> {
  if (!periodKey) return;
  const { data: cur } = await admin.from("user_credits").select("balance, suite_period").eq("user_id", userId).maybeSingle();
  if (cur && (cur as { suite_period?: string }).suite_period === periodKey) return; // already granted
  const bal = Number((cur as { balance?: number } | null)?.balance ?? 0);
  const newBal = Math.max(bal, amount);
  await admin.from("user_credits").upsert(
    { user_id: userId, balance: newBal, suite_period: periodKey, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  try { await admin.from("credit_transactions").insert({ user_id: userId, amount: Math.max(0, newBal - bal), feature: amount === SUITE.monthlyCredits ? "suite_monthly" : "flow_pass_monthly", kind: "grant" }); } catch { /* ledger is best-effort */ }
}
