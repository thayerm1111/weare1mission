import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileNitrousAddonSubscriptions } from "@/lib/nitrous/addon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  const key = process.env.STRIPE_SECRET_KEY;
  if (!admin || !key) return json({ error: "billing_unavailable" }, 503);
  try {
    return json({ ok: true, ...await reconcileNitrousAddonSubscriptions(admin, new Stripe(key, { timeout: 8_000, maxNetworkRetries: 0 })) });
  } catch { return json({ error: "nitrous_reconciliation_failed" }, 503); }
}
