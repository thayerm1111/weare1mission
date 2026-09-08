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
    // RETIRED (owner 09-08): the $39/mo Trading Suite is closed to new sign-ups — members
    // buy credit packs or use auto-refill instead. Blocked server-side so a cached page or
    // old link can never start a new subscription. Existing subscribers are untouched:
    // cancel/resume below still work and the webhook keeps granting their monthly credits.
    return json({ error: "retired", detail: "The monthly plan is no longer offered — grab a credit pack or turn on auto-refill on the Credits page." }, 200);
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
