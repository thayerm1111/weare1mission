import { type NextRequest } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SUITE, FLOW_PASS } from "@/lib/creditConfig";
import { getSubscription, safeSubView, isFlowPass, PLAN_SUITE } from "@/lib/subscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Trading Suite subscription management — member-initiated only.
 *   GET                       → this member's subscription status.
 *   POST { action:"subscribe"} → Stripe Checkout URL for the $39/mo plan.
 *   POST { action:"cancel"    } → cancel at period end (keeps access until then).
 *   POST { action:"resume"    } → undo a pending cancel.
 * All balance/entitlement changes land through the Stripe webhook; this route
 * only starts checkout or flips the cancel flag on the member's own row.
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
    // FLOW Pass — what the Credits page needs to render the offer, the active state, or the upgrade.
    pass: {
      active: isFlowPass(sub),
      price: FLOW_PASS.priceUsd,
      credits: FLOW_PASS.monthlyCredits,
      label: FLOW_PASS.label,
      // A legacy $39 Suite member who is still active: show them the one-tap upgrade (owner 09-23).
      canUpgrade: !!sub && sub.plan === PLAN_SUITE && view.active,
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
              description: `Unlimited FLOW + GENX, plus ${FLOW_PASS.monthlyCredits} credits a month for everything else`,
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

  if (action === "cancel" || action === "resume") {
    const admin = createAdminClient();
    const sub = await getSubscription(user.id, admin);
    if (!sub?.stripe_subscription_id) return json({ error: "no_subscription" }, 200);
    const cancelAtEnd = action === "cancel";
    try {
      await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: cancelAtEnd });
      if (admin) await admin.from("user_subscriptions").update({
        cancel_at_period_end: cancelAtEnd,
        canceled_at: cancelAtEnd ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq("user_id", user.id);
      return json({ ok: true, cancelAtPeriodEnd: cancelAtEnd });
    } catch (e) {
      return json({ error: "update_failed", detail: (e instanceof Error ? e.message : "").slice(0, 200) }, 502);
    }
  }

  return json({ error: "bad_action" }, 400);
}
