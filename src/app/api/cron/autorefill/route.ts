import { type NextRequest } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { AUTOREFILL } from "@/lib/creditConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * AUTO-REFILL sweep (scheduled). For every member who has turned auto-refill ON,
 * has a saved card, and whose purchased balance has dropped BELOW their threshold,
 * charge the saved card OFF-SESSION and grant the credits. A declined/needs-auth
 * charge PAUSES that member's auto-refill and records the reason so the UI can
 * prompt them to update the card. Secured by CRON_SECRET (Vercel cron sends it as
 * a Bearer header); it never runs without a configured secret, since it moves money.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // never charge cards without a configured secret
  const url = new URL(req.url);
  return url.searchParams.get("key") === secret || req.headers.get("authorization") === `Bearer ${secret}`;
}

const REFILL_COOLDOWN_MS = 15 * 60 * 1000; // never re-charge the same member within 15 min

type Row = {
  user_id: string; threshold: number | null; refill_credits: number | null; refill_price_cents: number | null;
  stripe_customer_id: string | null; stripe_payment_method_id: string | null; last_refill_at: string | null;
};

async function run(): Promise<Response> {
  const admin = createAdminClient();
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!admin || !secret) return json({ ok: false, reason: "not_configured" });
  const stripe = new Stripe(secret);

  const { data } = await admin.from("user_autorefill")
    .select("user_id, threshold, refill_credits, refill_price_cents, stripe_customer_id, stripe_payment_method_id, last_refill_at")
    .eq("enabled", true).eq("status", "active").not("stripe_payment_method_id", "is", null).limit(500);
  const rows = (data ?? []) as Row[];

  let charged = 0, skipped = 0, failed = 0;
  const nowMs = Date.now();
  for (const r of rows) {
    try {
      if (!r.stripe_payment_method_id) { skipped++; continue; }
      // SELF-HEAL a row that has a saved card but no customer id (an old webhook
      // upsert could clobber it with null): the payment method knows its own
      // customer in Stripe — recover it, persist it, and carry on, instead of
      // silently skipping this member forever.
      let customerId = r.stripe_customer_id;
      if (!customerId) {
        try {
          const pm = await stripe.paymentMethods.retrieve(r.stripe_payment_method_id);
          customerId = typeof pm.customer === "string" ? pm.customer : pm.customer?.id ?? null;
        } catch { /* surfaced below */ }
        if (customerId) {
          await admin.from("user_autorefill").update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() }).eq("user_id", r.user_id);
        } else {
          // Card exists but isn't linked to any Stripe customer — it can never be
          // charged off-session. Surface it on the row (the UI shows last_error)
          // rather than skipping without a trace.
          await admin.from("user_autorefill").update({ last_error: "card_not_linked: re-add your card to finish auto-refill setup", updated_at: new Date().toISOString() }).eq("user_id", r.user_id);
          skipped++; continue;
        }
      }
      if (r.last_refill_at && nowMs - Date.parse(r.last_refill_at) < REFILL_COOLDOWN_MS) { skipped++; continue; }

      // Trigger on the persistent (purchased) balance — the one that actually depletes
      // for paying members. A member at/above threshold is left alone.
      const { data: cur } = await admin.from("user_credits").select("balance").eq("user_id", r.user_id).maybeSingle();
      const bal = Number((cur as { balance?: number } | null)?.balance ?? 0);
      const threshold = r.threshold ?? AUTOREFILL.threshold;
      if (bal >= threshold) { skipped++; continue; }

      const credits = r.refill_credits ?? AUTOREFILL.credits;
      const amount = r.refill_price_cents ?? AUTOREFILL.priceCents;

      // Stamp last_refill_at FIRST (best-effort double-charge guard against an
      // overlapping run) — the cooldown above reads it next tick.
      await admin.from("user_autorefill").update({ last_refill_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString() }).eq("user_id", r.user_id);

      let status = "";
      try {
        const pi = await stripe.paymentIntents.create({
          amount, currency: "usd", customer: customerId, payment_method: r.stripe_payment_method_id,
          off_session: true, confirm: true,
          metadata: { user_id: r.user_id, credits: String(credits), kind: "autorefill" },
          description: `1 Mission — auto-refill ${credits} credits`,
        });
        status = pi.status;
      } catch (e) {
        const msg = (e instanceof Error ? e.message : "charge_failed").slice(0, 160);
        await admin.from("user_autorefill").update({ status: "paused", last_error: msg, updated_at: new Date().toISOString() }).eq("user_id", r.user_id);
        try { await admin.from("notifications").insert({ user_id: r.user_id, kind: "billing", title: "Auto-refill paused", body: "We couldn't charge your card for a credit refill. Update your card to turn auto-refill back on." }); } catch { /* notifications best-effort */ }
        failed++; continue;
      }

      if (status === "succeeded") {
        await admin.rpc("add_purchased_credits", { p_user: r.user_id, p_amount: credits, p_feature: "autorefill" });
        await admin.from("user_autorefill").update({ last_error: null, updated_at: new Date().toISOString() }).eq("user_id", r.user_id);
        charged++;
      } else {
        // requires_action / processing / anything not settled → pause and let them re-auth.
        await admin.from("user_autorefill").update({ status: "paused", last_error: `pi_${status || "unknown"}`, updated_at: new Date().toISOString() }).eq("user_id", r.user_id);
        try { await admin.from("notifications").insert({ user_id: r.user_id, kind: "billing", title: "Auto-refill needs attention", body: "Your card needs re-authorization for auto-refill. Re-add it to continue." }); } catch { /* */ }
        failed++;
      }
    } catch { /* per-member best-effort; never let one member break the sweep */ }
  }
  return json({ ok: true, considered: rows.length, charged, skipped, failed });
}

export async function GET(req: NextRequest) { if (!authorized(req)) return json({ error: "unauthorized" }, 401); return run(); }
export async function POST(req: NextRequest) { if (!authorized(req)) return json({ error: "unauthorized" }, 401); return run(); }
