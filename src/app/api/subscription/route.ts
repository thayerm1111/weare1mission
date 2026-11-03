import { type NextRequest } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SUITE, FLOW_PASS } from "@/lib/creditConfig";
import { getSubscription, safeSubView, isFlowPass, PLAN_SUITE, PLAN_FLOW_PASS } from "@/lib/subscription";
import { syncSubscription, grantSuiteMonth } from "@/lib/subscriptionSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Subscription management — member-initiated only.
 *   GET                             → this member's plan, status and next charge date.
 *   POST { action:"subscribe_pass" } → Stripe Checkout URL for the FLOW Pass.
 *   POST { action:"cancel"   }       → cancel at the end of the paid month (keeps access until then).
 *   POST { action:"resume"   }       → undo a pending cancel ("keep" is the same).
 *   POST { action:"pause"    }       → stop billing until resumed: the Pass runs to the end of the paid
 *                                      month, then no charges and no Pass (owner 11-02).
 *   POST { action:"unpause"  }       → resume: inside the paid month billing simply carries on; after it,
 *                                      a new paid month starts now (charged at once, or nothing changes).
 * Every change is made at Stripe first and then read back into the member's row (subscriptionSync), so
 * the row always says what Stripe says.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const sub = await getSubscription(user.id);
  const view = safeSubView(sub);
  return json({
    ok: true,
    price: SUITE.priceUsd, credits: SUITE.monthlyCredits,
    ...view,
    plan: sub?.plan ?? null,
    // What the next charge will be, for the "next charge" line (null when no charge is coming).
    nextChargeAmount: view.nextChargeAt ? (sub?.plan === PLAN_FLOW_PASS ? FLOW_PASS.priceUsd : SUITE.priceUsd) : null,
    // FLOW Pass — what the Credits page needs to render the offer, the active state, or the upgrade.
    pass: {
      active: isFlowPass(sub),
      price: FLOW_PASS.priceUsd,
      credits: FLOW_PASS.monthlyCredits,
      label: FLOW_PASS.label,
      // A legacy $39 Suite member who is still active: show them the one-tap upgrade (owner 09-23).
      canUpgrade: !!sub && sub.plan === PLAN_SUITE && view.active,
      // The member's plan row is a Pass (running, ending, paused or with a payment problem) — the card
      // shows how to manage it rather than the offer.
      mine: !!sub && sub.plan === PLAN_FLOW_PASS,
    },
  });
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ error: "stripe_not_configured", detail: "Payments aren't switched on yet." }, 200);
  const stripe = new Stripe(secret);

  let body: { action?: string } = {};
  try { body = await req.json(); } catch { /* */ }
  const action = String(body.action || "");

  if (action === "subscribe") {
    // RETIRED (owner 09-08): the $39/mo Trading Suite is closed to new sign-ups. Still blocked
    // server-side so a cached page or old link can never start one. Existing subscribers are
    // untouched: cancel/resume below still work and the webhook keeps granting their credits.
    return json({ error: "retired", detail: "That plan is no longer offered — the FLOW Pass replaces it." }, 200);
  }

  /*
   * FLOW PASS — $99/mo, unmetered FLOW + GENX (owner 09-23). Open to everyone, including the legacy
   * $39 Suite members, whose old subscription the webhook cancels the moment this one activates.
   * Inline price_data, same as the credit packs, so nothing has to be pre-created in Stripe.
   * The plan marker goes on BOTH the session and the subscription, because renewal invoices only
   * carry the latter — without it a renewal would be mistaken for a Suite and regrade the member.
   */
  if (action === "subscribe_pass") {
    const existing = await getSubscription(user.id);
    if (isFlowPass(existing)) return json({ error: "already_active", detail: "Your FLOW Pass is already running." }, 200);
    const origin = req.headers.get("origin") || `https://${req.headers.get("host")}`;
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(FLOW_PASS.priceUsd * 100),
            recurring: { interval: FLOW_PASS.interval },
            product_data: {
              name: `1 Mission — ${FLOW_PASS.label}`,
              description: `Unlimited GENX, GEN FX, OM AI Plays and FLOW, plus ${FLOW_PASS.monthlyCredits} credits a month for everything else`,
            },
          },
        }],
        client_reference_id: user.id,
        customer_email: user.email || undefined,
        metadata: { user_id: user.id, plan: FLOW_PASS.tag },
        subscription_data: { metadata: { user_id: user.id, plan: FLOW_PASS.tag } },
        success_url: `${origin}/portal/credits?pass=1`,
        cancel_url: `${origin}/portal/credits?canceled=1`,
        managed_payments: { enabled: false },
      } as Stripe.Checkout.SessionCreateParams);
      return json({ ok: true, url: session.url }, 200);
    } catch (e) {
      return json({ error: "checkout_failed", detail: (e instanceof Error ? e.message : "").slice(0, 200) }, 502);
    }
  }

  if (action === "cancel" || action === "resume" || action === "keep" || action === "pause" || action === "unpause") {
    const admin = createAdminClient();
    const sub = await getSubscription(user.id, admin);
    if (!sub?.stripe_subscription_id) return json({ error: "no_subscription" }, 200);
    const id = sub.stripe_subscription_id;
    const view = safeSubView(sub);
    const now = Date.now();
    const paidThrough = sub.paid_through ? Date.parse(sub.paid_through) : NaN;
    const stillPaid = Number.isFinite(paidThrough) && paidThrough > now;
    try {
      if (action === "cancel") {
        // Paused and the paid month already over: nothing is left to run out — end it now (no charge either way).
        if (sub.paused_at && !stillPaid) await stripe.subscriptions.cancel(id);
        else await stripe.subscriptions.update(id, { cancel_at_period_end: true });
      } else if (action === "resume" || action === "keep") {
        await stripe.subscriptions.update(id, { cancel_at_period_end: false });
      } else if (action === "pause") {
        if (!view.active) return json({ error: "not_active", detail: "There's no running plan to pause." }, 200);
        if (sub.paused_at) return json({ ok: true, already: true });
        // Pausing supersedes a pending cancel: the member wants to come back, not to leave.
        await stripe.subscriptions.update(id, { pause_collection: { behavior: "void" }, cancel_at_period_end: false });
      } else {
        if (!sub.paused_at) return json({ ok: true, already: true });
        if (stillPaid) {
          // Back before the paid month ran out: billing simply carries on at the next renewal.
          await stripe.subscriptions.update(id, { pause_collection: "" });
        } else {
          // A new paid month, starting now — charged at once. If the card is declined nothing changes:
          // the plan stays paused and the member is told (error_if_incomplete).
          await stripe.subscriptions.update(id, { pause_collection: "", billing_cycle_anchor: "now", proration_behavior: "none", payment_behavior: "error_if_incomplete" });
        }
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : "";
      const declined = /card|declin|insufficient|payment/i.test(raw);
      return json({ error: declined ? "card_declined" : "update_failed", detail: declined ? "Your card was declined — nothing was changed. Update your card and try again." : raw.slice(0, 200) }, declined ? 402 : 502);
    }
    // Read the result back from Stripe into the row, and grant the month's credits when a new month was paid.
    if (admin) {
      try {
        const res = await syncSubscription(admin, stripe, id, user.id);
        if (res && action === "unpause" && !res.paused && res.latestInvoicePaid && (res.status === "active" || res.status === "trialing")) {
          await grantSuiteMonth(admin, res.userId, res.periodKey, res.monthly);
        }
      } catch { /* the webhook and the hourly re-sync both catch up */ }
    }
    const fresh = await getSubscription(user.id, admin);
    return json({ ok: true, ...safeSubView(fresh) });
  }

  return json({ error: "bad_action" }, 400);
}
