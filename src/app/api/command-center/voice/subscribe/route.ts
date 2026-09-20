import { type NextRequest } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { VOICE_PLAN, VOICE_PRODUCT_TAG, topupById } from "@/lib/voicePlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BUYING COMMAND CENTER VOICE.
 *
 * Two things are sold here and they are different shapes: the monthly subscription (mode
 * "subscription") and a one-off pack of extra minutes for the current period (mode "payment").
 *
 * Inline `price_data` rather than pre-created Stripe products, matching the credit packs — the price
 * lives in src/lib/voicePlan.ts and there is no second copy in a dashboard to drift away from it.
 *
 * `metadata.product` is load-bearing. The webhook already treats any subscription checkout as the
 * Trading Suite and grants Suite credits on it; without this marker a voice subscription would be
 * recorded as a Suite one AND hand out a month of trading credits for free. The webhook branches on it
 * before it branches on mode.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ error: "stripe_not_configured", detail: "Payments aren't switched on yet." }, 200);

  let body: { topupId?: string } = {};
  try { body = await req.json(); } catch { /* an empty body means the subscription */ }

  const origin = req.headers.get("origin") || `https://${req.headers.get("host")}`;
  const stripe = new Stripe(secret);
  const back = `${origin}/portal/command-center`;

  try {
    /* ── extra minutes for the current period ───────────────────────────── */
    if (body.topupId) {
      const pack = topupById(String(body.topupId));
      if (!pack) return json({ error: "bad_pack" }, 400);

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(pack.priceUsd * 100),
            product_data: {
              name: `Command Center Voice — ${pack.label}`,
              // Said plainly at the point of sale, because it is the one surprising thing about it.
              description: `${pack.minutes.toLocaleString()} extra voice minutes for your current billing period.`,
            },
          },
        }],
        client_reference_id: user.id,
        customer_email: user.email || undefined,
        metadata: {
          user_id: user.id,
          product: VOICE_PRODUCT_TAG,
          kind: "topup",
          minutes: String(pack.minutes),
          pack: pack.id,
        },
        success_url: `${back}?voice=topup`,
        cancel_url: `${back}?voice=canceled`,
        managed_payments: { enabled: false },
      } as Stripe.Checkout.SessionCreateParams);
      return json({ url: session.url }, 200);
    }

    /* ── the monthly subscription ───────────────────────────────────────── */
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(VOICE_PLAN.priceUsd * 100),
          recurring: { interval: "month" },
          product_data: {
            name: VOICE_PLAN.label,
            description: VOICE_PLAN.blurb,
          },
        },
      }],
      client_reference_id: user.id,
      customer_email: user.email || undefined,
      metadata: { user_id: user.id, product: VOICE_PRODUCT_TAG, kind: "subscription" },
      // Carried onto the subscription itself as well: a renewal event arrives with no checkout session
      // attached, so the marker has to live somewhere the subscription object can be read from.
      subscription_data: {
        metadata: { user_id: user.id, product: VOICE_PRODUCT_TAG },
      },
      success_url: `${back}?voice=on`,
      cancel_url: `${back}?voice=canceled`,
      managed_payments: { enabled: false },
    } as Stripe.Checkout.SessionCreateParams);
    return json({ url: session.url }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "checkout_failed";
    return json({ error: "checkout_failed", detail: msg.slice(0, 200) }, 502);
  }
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
