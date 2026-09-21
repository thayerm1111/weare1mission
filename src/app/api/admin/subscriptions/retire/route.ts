import { type NextRequest } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { gateAdmin } from "@/lib/sports/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RETIRING THE $39 TRADING SUITE — stop the cards being charged again.
 *
 * New sign-ups have been closed since 09-08 (see /api/subscription), but the members who were already
 * on it kept renewing. The owner's instruction was plain: take the option off and do not run their
 * cards again. So this cancels every live Suite subscription.
 *
 *   GET  → who is still on it, when each renews, and what a run would do. Changes nothing.
 *   POST { confirm: true }                   → cancel at period end: no further charge, and they keep
 *                                              the month they have already paid for. The default.
 *   POST { confirm: true, immediate: true }  → end it now. Only when explicitly asked for; it takes
 *                                              away time somebody has paid for.
 *
 * Twice-gated: the owner's own session (gateAdmin), or an `x-admin-key` matching ADMIN_TASK_KEY so the
 * job can be run once from a terminal without anybody sitting at the admin page. Everyone else gets a
 * 404, so the endpoint's existence is not leaked. Every run is logged.
 *
 * It never refunds and never deletes. Cancelling a subscription in Stripe is reversible by resubscribing;
 * nothing here removes credits already granted.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

type Row = { user_id: string; stripe_subscription_id: string | null; status: string | null; cancel_at_period_end: boolean | null; current_period_end: string | null };

async function authorised(req: NextRequest): Promise<boolean> {
  const key = (process.env.ADMIN_TASK_KEY ?? "").trim();
  const given = (req.headers.get("x-admin-key") ?? "").trim();
  if (key && given && given === key) return true;
  return (await gateAdmin()).ok;
}

async function live(): Promise<{ rows: Row[]; error?: string }> {
  const admin = createAdminClient();
  if (!admin) return { rows: [], error: "server_not_configured" };
  const { data, error } = await admin.from("user_subscriptions")
    .select("user_id, stripe_subscription_id, status, cancel_at_period_end, current_period_end")
    .in("status", ["active", "trialing", "past_due"]);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as Row[] };
}

export async function GET(req: NextRequest) {
  if (!await authorised(req)) return json({ error: "not_found" }, 404);
  const { rows, error } = await live();
  if (error) return json({ error }, 500);
  return json({
    ok: true,
    total: rows.length,
    willCancel: rows.filter((r) => r.stripe_subscription_id && !r.cancel_at_period_end).length,
    alreadyCancelling: rows.filter((r) => r.cancel_at_period_end).length,
    missingStripeId: rows.filter((r) => !r.stripe_subscription_id).length,
    renewals: rows.map((r) => ({ status: r.status, renewsAt: r.current_period_end, cancelling: !!r.cancel_at_period_end })),
  });
}

export async function POST(req: NextRequest) {
  if (!await authorised(req)) return json({ error: "not_found" }, 404);
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json({ error: "stripe_not_configured" }, 500);

  let body: { confirm?: boolean; immediate?: boolean } = {};
  try { body = (await req.json()) as typeof body; } catch { /* */ }
  if (body.confirm !== true) return json({ error: "confirm_required", detail: "POST { confirm: true } to cancel every live Trading Suite subscription." }, 400);

  const admin = createAdminClient();
  const stripe = new Stripe(secret);
  const { rows, error } = await live();
  if (error) return json({ error }, 500);

  const done: string[] = [], failed: { id: string; why: string }[] = [], skipped: string[] = [];
  for (const r of rows) {
    if (!r.stripe_subscription_id) { skipped.push(r.user_id); continue; }
    if (r.cancel_at_period_end && !body.immediate) { skipped.push(r.stripe_subscription_id); continue; }
    try {
      if (body.immediate) await stripe.subscriptions.cancel(r.stripe_subscription_id);
      else await stripe.subscriptions.update(r.stripe_subscription_id, { cancel_at_period_end: true });
      if (admin) {
        await admin.from("user_subscriptions").update({
          cancel_at_period_end: !body.immediate,
          canceled_at: new Date().toISOString(),
          ...(body.immediate ? { status: "canceled" } : {}),
        }).eq("user_id", r.user_id);
      }
      done.push(r.stripe_subscription_id);
    } catch (e) {
      failed.push({ id: r.stripe_subscription_id, why: e instanceof Error ? e.message.slice(0, 160) : "unknown" });
    }
  }

  console.log(`[suite-retire] ${done.length} cancelled ${body.immediate ? "immediately" : "at period end"}, ${skipped.length} skipped, ${failed.length} failed`);


  return json({ ok: failed.length === 0, mode: body.immediate ? "immediate" : "period_end", cancelled: done.length, skipped: skipped.length, failed });
}
