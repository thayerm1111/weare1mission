import { type NextRequest } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { SUITE } from "@/lib/creditConfig";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/** Mirror a Stripe subscription into user_subscriptions. Returns the resolved
 *  member id + whether it's currently active, so the caller can grant credits. */
async function syncSubscription(admin: Admin, stripe: Stripe, subscriptionId: string, userIdHint?: string | null) {
  const s = await stripe.subscriptions.retrieve(subscriptionId) as unknown as {
    id: string; status: string; customer: string | { id: string };
    current_period_end?: number; cancel_at_period_end?: boolean; canceled_at?: number | null;
    metadata?: Record<string, string>;
  };
  const userId = userIdHint || s.metadata?.user_id || null;
  if (!userId) return null;
  const periodEndIso = s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null;
  await admin.from("user_subscriptions").upsert({
    user_id: userId, plan: "trading_suite", status: s.status,
    stripe_customer_id: typeof s.customer === "string" ? s.customer : s.customer?.id ?? null,
    stripe_subscription_id: s.id,
    current_period_end: periodEndIso,
    cancel_at_period_end: !!s.cancel_at_period_end,
    canceled_at: s.canceled_at ? new Date(s.canceled_at * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  return { userId, status: s.status, periodKey: String(s.current_period_end ?? "") };
}

/** Grant the monthly Suite allowance: top the balance UP TO the floor for this
 *  billing period (no rollover, no stacking). Idempotent per period. */
async function grantSuiteMonth(admin: Admin, userId: string, periodKey: string) {
  const { data: cur } = await admin.from("user_credits").select("balance, suite_period").eq("user_id", userId).maybeSingle();
  if (cur && (cur as { suite_period?: string }).suite_period === periodKey) return; // already granted
  const bal = Number((cur as { balance?: number } | null)?.balance ?? 0);
  const newBal = Math.max(bal, SUITE.monthlyCredits);
  await admin.from("user_credits").upsert(
    { user_id: userId, balance: newBal, suite_period: periodKey, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  try { await admin.from("credit_transactions").insert({ user_id: userId, amount: Math.max(0, newBal - bal), feature: "suite_monthly", kind: "grant" }); } catch { /* ledger is best-effort */ }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe webhook — the ONLY place credits get added from a purchase. Verifies
 * the signature, and on a completed checkout reads the member id + credit
 * amount from the session metadata and tops up their balance via the
 * service-role RPC. Requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and
 * SUPABASE_SERVICE_ROLE_KEY. Point Stripe at /api/stripe/webhook.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !whSecret) return json({ error: "stripe_not_configured" }, 200);

  const sig = req.headers.get("stripe-signature");
  if (!sig) return json({ error: "no_signature" }, 400);
  const raw = await req.text(); // raw body required for signature verification

  const stripe = new Stripe(secret);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, whSecret);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "bad_signature";
    return json({ error: "invalid_signature", detail: msg.slice(0, 120) }, 400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.user_id;

    // Trading Suite subscription checkout → record it and grant the first month.
    if (session.mode === "subscription" && session.subscription) {
      const admin = createAdminClient();
      if (!admin) return json({ error: "no_admin_client" }, 200);
      const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
      const res = await syncSubscription(admin, stripe, subId, userId);
      if (res && (res.status === "active" || res.status === "trialing")) await grantSuiteMonth(admin, res.userId, res.periodKey);
      return json({ received: true }, 200);
    }

    // Credit-pack (one-time) purchase → top up balance.
    const credits = Number(session.metadata?.credits || 0);
    const pack = session.metadata?.pack || "pack";
    if (userId && Number.isFinite(credits) && credits > 0) {
      const admin = createAdminClient();
      if (!admin) return json({ error: "no_admin_client" }, 200); // don't retry-storm; alert via logs
      const { error } = await admin.rpc("add_purchased_credits", { p_user: userId, p_amount: credits, p_feature: `pack_${pack}` });
      if (error) return json({ error: "credit_failed", detail: error.message.slice(0, 120) }, 500); // let Stripe retry
    }
  }

  // Subscription lifecycle → keep user_subscriptions in sync (status, cancel, renewals).
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created" || event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    const admin = createAdminClient();
    if (admin) await syncSubscription(admin, stripe, sub.id, sub.metadata?.user_id);
  }

  // Renewal payment → refresh the monthly credit allowance for the new period.
  if (event.type === "invoice.paid") {
    const inv = event.data.object as unknown as { subscription?: string | { id: string } };
    const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id;
    if (subId) {
      const admin = createAdminClient();
      if (admin) {
        const res = await syncSubscription(admin, stripe, subId);
        if (res && (res.status === "active" || res.status === "trialing")) await grantSuiteMonth(admin, res.userId, res.periodKey);
      }
    }
  }

  return json({ received: true }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
