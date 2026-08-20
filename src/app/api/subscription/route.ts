import { type NextRequest } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SUITE } from "@/lib/creditConfig";
import { getSubscription, safeSubView } from "@/lib/subscription";

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
  return json({ ok: true, price: SUITE.priceUsd, credits: SUITE.monthlyCredits, ...safeSubView(sub) });
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
    const origin = req.headers.get("origin") || `https://${req.headers.get("host")}`;
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(SUITE.priceUsd * 100),
            recurring: { interval: SUITE.interval },
            product_data: { name: "1 Mission — Trading Suite", description: `Full AI trading desk + ${SUITE.monthlyCredits} credits/mo + free auto-run` },
          },
        }],
        client_reference_id: user.id,
        customer_email: user.email || undefined,
        metadata: { user_id: user.id, plan: SUITE.key },
        subscription_data: { metadata: { user_id: user.id, plan: SUITE.key } },
        success_url: `${origin}/portal/account?suite=on`,
        cancel_url: `${origin}/portal/account?suite=cancelled`,
        managed_payments: { enabled: false },
      } as Stripe.Checkout.SessionCreateParams);
      return json({ ok: true, url: session.url });
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
