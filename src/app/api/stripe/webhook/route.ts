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

/** Save a card on file for auto-refill: record the customer + payment method (with
 *  brand/last4), attach it to the customer and make it the default so the auto-refill
 *  cron can charge it off-session. `enable` flips auto-refill on (used for explicit
 *  card-setup; a plain top-up saves the card but leaves the toggle where it was). */
async function saveAutorefillCard(admin: Admin, stripe: Stripe, userId: string, customerId: string | null, paymentMethodId: string, enable: boolean) {
  let brand: string | null = null, last4: string | null = null;
  try {
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    brand = pm.card?.brand ?? null; last4 = pm.card?.last4 ?? null;
    if (customerId) {
      try { await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }); } catch { /* already attached */ }
      try { await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } }); } catch { /* best-effort */ }
    }
  } catch { /* keep whatever we have */ }
  const patch: Record<string, unknown> = {
    user_id: userId, stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId,
    card_brand: brand, card_last4: last4, status: "active", last_error: null, updated_at: new Date().toISOString(),
  };
  if (enable) patch.enabled = true;
  await admin.from("user_autorefill").upsert(patch, { onConflict: "user_id" });
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

    // Auto-refill card SETUP (no charge) → save the card + turn auto-refill on.
    if (session.mode === "setup" && session.setup_intent && userId) {
      const admin = createAdminClient();
      if (!admin) return json({ error: "no_admin_client" }, 200);
      const siId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent.id;
      try {
        const si = await stripe.setupIntents.retrieve(siId);
        const pm = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id ?? null;
        const cust = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
        if (pm) await saveAutorefillCard(admin, stripe, userId, cust, pm, true);
      } catch { /* card save best-effort; the member can retry setup */ }
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
      // If this purchase saved a card (setup_future_usage), keep it on file AND turn
      // auto-refill on (owner directive 09-01: a saved card means auto-refill is live —
      // every member with a card on file had bought a top-up yet still had the toggle
      // off, so their FLOW would have paused when credits ran out anyway). The credits
      // page keeps the toggle front and center to switch it off.
      try {
        if (session.payment_intent) {
          const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id;
          const pi = await stripe.paymentIntents.retrieve(piId);
          const pm = typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id ?? null;
          const cust = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
          if (pm) await saveAutorefillCard(admin, stripe, userId, cust, pm, true);
        }
      } catch { /* card capture best-effort */ }
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
