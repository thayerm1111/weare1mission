import { type NextRequest } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncSubscription, grantSuiteMonth } from "@/lib/subscriptionSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * THE HOURLY RE-SYNC (owner 11-02). Every plan whose period has ended, or ends within the next few hours,
 * is read again from Stripe and written back: a renewal the webhook never delivered (or delivered in a
 * shape it could not read) is picked up within the hour, and a Pass member is never treated as lapsed
 * while Stripe is charging them. A month's credits are granted only when Stripe shows that month's
 * invoice PAID and the plan is not paused (a paused plan's months are voided, not paid).
 *
 * Read-only toward Stripe: it changes nothing there. Secured by CRON_SECRET like every cron here.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(req.url);
  return url.searchParams.get("key") === secret || req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Statuses that can still change on their own at Stripe (an ended plan never comes back). */
const LIVE = ["active", "trialing", "past_due", "unpaid", "incomplete"];
const DUE_AHEAD_MS = 3 * 3_600_000;
const BATCH = 40;

async function run(): Promise<Response> {
  const admin = createAdminClient();
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!admin || !secret) return json({ ok: false, reason: "not_configured" });
  const stripe = new Stripe(secret);
  const dueBefore = new Date(Date.now() + DUE_AHEAD_MS).toISOString();
  const { data, error } = await admin.from("user_subscriptions")
    .select("user_id, stripe_subscription_id, current_period_end, status")
    .in("status", LIVE)
    .not("stripe_subscription_id", "is", null)
    .or(`current_period_end.is.null,current_period_end.lt.${dueBefore}`)
    .order("current_period_end", { ascending: true, nullsFirst: true })
    .limit(BATCH);
  if (error) return json({ ok: false, reason: error.message.slice(0, 120) }, 500);
  const rows = (data ?? []) as Array<{ user_id: string; stripe_subscription_id: string }>;
  const out: Array<{ user: string; status?: string; granted?: boolean; error?: string }> = [];
  for (const r of rows) {
    try {
      const res = await syncSubscription(admin, stripe, r.stripe_subscription_id, r.user_id);
      let granted = false;
      if (res && !res.paused && res.latestInvoicePaid === true && (res.status === "active" || res.status === "trialing")) {
        await grantSuiteMonth(admin, res.userId, res.periodKey, res.monthly);
        granted = true;
      }
      out.push({ user: r.user_id.slice(0, 8), status: res?.status, granted });
    } catch (e) {
      out.push({ user: r.user_id.slice(0, 8), error: (e instanceof Error ? e.message : "sync_failed").slice(0, 120) });
    }
  }
  return json({ ok: true, checked: rows.length, results: out });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  return run();
}
export async function POST(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  return run();
}
