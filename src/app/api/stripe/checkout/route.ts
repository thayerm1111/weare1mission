import { type NextRequest } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { packById } from "@/lib/creditConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a Stripe Checkout Session for a credit pack. Uses inline price_data so
 * you don't have to pre-create products in Stripe — just set STRIPE_SECRET_KEY.
 * The member's id + the credit amount ride in metadata; the webhook reads them
 * to top up the balance after payment succeeds.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ error: "stripe_not_configured", detail: "Payments aren't switched on yet." }, 200);

  let b: { packId?: string } = {};
  try { b = await req.json(); } catch { /* empty */ }
  const pack = packById(String(b.packId || ""));
  if (!pack) return json({ error: "bad_pack" }, 400);

  const origin = req.headers.get("origin") || `https://${req.headers.get("host")}`;
  const stripe = new Stripe(secret);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(pack.priceUsd * 100),
          product_data: {
            name: `1 Mission — ${pack.label} pack`,
            description: `${pack.credits.toLocaleString()} OM AI credits`,
          },
        },
      }],
      // Idempotency + fulfilment data for the webhook.
      client_reference_id: user.id,
      customer_email: user.email || undefined,
      metadata: { user_id: user.id, credits: String(pack.credits), pack: pack.id },
      success_url: `${origin}/portal/credits?success=1`,
      cancel_url: `${origin}/portal/credits?canceled=1`,
    });
    return json({ url: session.url }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "checkout_failed";
    return json({ error: "checkout_failed", detail: msg.slice(0, 200) }, 502);
  }
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
