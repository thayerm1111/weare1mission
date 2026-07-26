import { type NextRequest } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";

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
    const credits = Number(session.metadata?.credits || 0);
    const pack = session.metadata?.pack || "pack";
    if (userId && Number.isFinite(credits) && credits > 0) {
      const admin = createAdminClient();
      if (!admin) return json({ error: "no_admin_client" }, 200); // don't retry-storm; alert via logs
      const { error } = await admin.rpc("add_purchased_credits", { p_user: userId, p_amount: credits, p_feature: `pack_${pack}` });
      if (error) return json({ error: "credit_failed", detail: error.message.slice(0, 120) }, 500); // let Stripe retry
    }
  }

  return json({ received: true }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
