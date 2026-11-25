import Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NitrousBillingError, setAdminNitrousGrant } from "@/lib/nitrous/addon";
import { allowedWriteOrigin } from "@/lib/nitrous/policy";
import { bodyOf, json } from "../../nitrous/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Complimentary access is a separate server-only entitlement; approval never charges a card. */
export async function POST(req: Request) {
  if (!allowedWriteOrigin(req)) return json({ ok: false, error: "origin_not_allowed" }, 403);
  const supabase = createClient();
  const admin = createAdminClient();
  if (!supabase || !admin) return json({ ok: false, error: "service_unavailable" }, 503);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return json({ ok: false, error: "unauthorized" }, 401);
  const actor = await admin.from("profiles").select("role,status").eq("id", data.user.id).maybeSingle();
  if (actor.error) return json({ ok: false, error: "authorization_unavailable" }, 503);
  if (!actor.data || actor.data.role !== "admin") return json({ ok: false, error: "forbidden" }, 403);
  const body = await bodyOf(req);
  if (!body || typeof body.enabled !== "boolean" || typeof body.userId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.userId)) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const target = await admin.from("profiles").select("id").eq("id", body.userId).maybeSingle();
  if (target.error) return json({ ok: false, error: "member_unavailable" }, 503);
  if (!target.data) return json({ ok: false, error: "member_not_found" }, 404);
  try {
    const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 15_000, maxNetworkRetries: 1 }) : null;
    const addon = await setAdminNitrousGrant(admin, stripe, body.userId, body.enabled, data.user.id);
    return json({ ok: true, addon });
  } catch (error) {
    if (error instanceof NitrousBillingError) return json({ ok: false, error: error.code, detail: error.detail }, error.status);
    return json({ ok: false, error: "nitrous_grant_failed", detail: "Nitrous access could not be updated. Please refresh and retry." }, 503);
  }
}
