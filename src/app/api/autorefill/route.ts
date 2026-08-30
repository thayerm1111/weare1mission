import { type NextRequest } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AUTOREFILL, AUTOREFILL_OPTIONS } from "@/lib/creditConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO-REFILL — card on file + off-session credit top-ups.
 *   GET                          → this member's auto-refill status (+ card on file).
 *   POST { action:"setup" }      → Stripe Checkout (setup mode) URL to save a card.
 *   POST { action:"toggle", enabled } → turn auto-refill on/off (needs a card first).
 *   POST { action:"manual" }     → Stripe Checkout to buy the manual top-up pack now.
 *   POST { action:"removecard" } → forget the saved card + turn auto-refill off.
 * The card is collected on Stripe's hosted page and stored in Stripe — never here.
 * The webhook saves the customer + payment method after a successful setup/purchase;
 * the auto-refill cron does the actual off-session charging.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

type Row = {
  enabled?: boolean; status?: string; threshold?: number; refill_credits?: number; refill_price_cents?: number;
  stripe_customer_id?: string | null; stripe_payment_method_id?: string | null; card_brand?: string | null; card_last4?: string | null; last_error?: string | null;
};

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  let r: Row | null = null;
  if (admin) { const { data } = await admin.from("user_autorefill").select("*").eq("user_id", user.id).maybeSingle(); r = (data as Row) ?? null; }
  return json({
    ok: true,
    enabled: !!r?.enabled,
    status: r?.status || "active",
    hasCard: !!r?.stripe_payment_method_id,
    card: r?.stripe_payment_method_id ? { brand: r.card_brand || null, last4: r.card_last4 || null } : null,
    lastError: r?.last_error || null,
    threshold: r?.threshold ?? AUTOREFILL.threshold,
    refillCredits: r?.refill_credits ?? AUTOREFILL.credits,
    refillPriceCents: r?.refill_price_cents ?? AUTOREFILL.priceCents,
    manualCredits: AUTOREFILL.manualCredits,
    manualPriceCents: AUTOREFILL.manualPriceCents,
    options: AUTOREFILL_OPTIONS,
  });
}

/** Get or create this member's Stripe customer id (cached on the auto-refill row). */
async function customerFor(stripe: Stripe, admin: NonNullable<ReturnType<typeof createAdminClient>>, userId: string, email: string | null): Promise<string> {
  const { data } = await admin.from("user_autorefill").select("stripe_customer_id").eq("user_id", userId).maybeSingle();
  const existing = (data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id;
  if (existing) return existing;
  const c = await stripe.customers.create({ email: email || undefined, metadata: { user_id: userId } });
  await admin.from("user_autorefill").upsert({ user_id: userId, stripe_customer_id: c.id, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  return c.id;
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ error: "stripe_not_configured", detail: "Payments aren't switched on yet." }, 200);
  const stripe = new Stripe(secret);
  const admin = createAdminClient();
  if (!admin) return json({ error: "server", detail: "Storage unavailable." }, 200);

  let body: { action?: string; enabled?: boolean; credits?: number } = {};
  try { body = await req.json(); } catch { /* */ }
  const action = String(body.action || "");
  const origin = req.headers.get("origin") || `https://${req.headers.get("host")}`;

  if (action === "plan") {
    // Pick the refill size (owner directive 08-30): each automatic charge tops up by the
    // member's chosen amount. Only the published options are accepted — price comes from
    // OUR list, never from the client, so a tampered request can't set its own pricing.
    const opt = AUTOREFILL_OPTIONS.find((o) => o.credits === Number(body.credits));
    if (!opt) return json({ error: "bad_plan", detail: "Pick one of the offered refill sizes." }, 400);
    await admin.from("user_autorefill").upsert(
      { user_id: user.id, refill_credits: opt.credits, refill_price_cents: opt.priceCents, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    return json({ ok: true, refillCredits: opt.credits, refillPriceCents: opt.priceCents });
  }

  if (action === "setup") {
    // Save a card (no charge) so future refills can run off-session. Stripe's hosted
    // page collects the card + the mandate; we only ever see a token afterward.
    try {
      const customerId = await customerFor(stripe, admin, user.id, user.email ?? null);
      const session = await stripe.checkout.sessions.create({
        mode: "setup",
        customer: customerId,
        payment_method_types: ["card"],
        metadata: { user_id: user.id, kind: "autorefill_setup" },
        setup_intent_data: { metadata: { user_id: user.id, kind: "autorefill" } },
        success_url: `${origin}/portal/account?autorefill=on`,
        cancel_url: `${origin}/portal/account?autorefill=cancel`,
      });
      return json({ ok: true, url: session.url });
    } catch (e) {
      return json({ error: "checkout_failed", detail: (e instanceof Error ? e.message : "").slice(0, 200) }, 502);
    }
  }

  if (action === "toggle") {
    // Turn auto-refill on/off. Enabling requires a saved card (send them to setup first).
    const enable = body.enabled !== false;
    const { data } = await admin.from("user_autorefill").select("stripe_payment_method_id").eq("user_id", user.id).maybeSingle();
    const hasCard = !!(data as { stripe_payment_method_id?: string | null } | null)?.stripe_payment_method_id;
    if (enable && !hasCard) return json({ error: "needs_card", detail: "Add a card first to turn on auto-refill." }, 200);
    await admin.from("user_autorefill").upsert(
      { user_id: user.id, enabled: enable, status: enable ? "active" : "active", last_error: enable ? null : undefined, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    return json({ ok: true, enabled: enable });
  }

  if (action === "manual") {
    // One-tap top-up: buy the manual pack now. Saves the card too (setup_future_usage)
    // so the member can flip auto-refill on afterward without re-entering it.
    try {
      const customerId = await customerFor(stripe, admin, user.id, user.email ?? null);
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: customerId,
        payment_method_types: ["card"],
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: AUTOREFILL.manualPriceCents,
            product_data: { name: `1 Mission — ${AUTOREFILL.manualCredits} credits`, description: "One-time credit top-up" },
          },
        }],
        payment_intent_data: { setup_future_usage: "off_session", metadata: { user_id: user.id, credits: String(AUTOREFILL.manualCredits), pack: "refill" } },
        metadata: { user_id: user.id, credits: String(AUTOREFILL.manualCredits), pack: "refill", kind: "manual_topup" },
        success_url: `${origin}/portal/account?topup=on`,
        cancel_url: `${origin}/portal/account?topup=cancel`,
      });
      return json({ ok: true, url: session.url });
    } catch (e) {
      return json({ error: "checkout_failed", detail: (e instanceof Error ? e.message : "").slice(0, 200) }, 502);
    }
  }

  if (action === "removecard") {
    // Detach the card in Stripe (best-effort) and forget it + turn auto-refill off.
    const { data } = await admin.from("user_autorefill").select("stripe_payment_method_id").eq("user_id", user.id).maybeSingle();
    const pm = (data as { stripe_payment_method_id?: string | null } | null)?.stripe_payment_method_id;
    if (pm) { try { await stripe.paymentMethods.detach(pm); } catch { /* already gone */ } }
    await admin.from("user_autorefill").upsert(
      { user_id: user.id, enabled: false, stripe_payment_method_id: null, card_brand: null, card_last4: null, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    return json({ ok: true });
  }

  return json({ error: "bad_action" }, 400);
}
