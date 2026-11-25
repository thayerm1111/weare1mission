import Stripe from "stripe";
import { bodyOf, json, requireUser } from "../_shared";
import { cancelNitrousMemberSubscription, getNitrousAddonAccess, NitrousBillingError, startNitrousCheckout, syncNitrousMemberBilling } from "@/lib/nitrous/addon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function failure(e: unknown) {
  if (e instanceof NitrousBillingError) return json({ error: e.code, detail: e.detail }, e.status);
  return json({ error: "billing_unavailable", detail: "Nitrous billing could not be verified. Please try again." }, 503);
}

export async function GET() {
  try {
    const auth = await requireUser();
    if ("error" in auth) return auth.error;
    return json({ addon: await getNitrousAddonAccess(auth.admin, auth.user.id) });
  } catch (e) { return failure(e); }
}

export async function POST(req: Request) {
  try {
    const auth = await requireUser(req);
    if ("error" in auth) return auth.error;
    const body = await bodyOf(req);
    if (!body || !["checkout", "sync", "cancel"].includes(String(body.action))) return json({ error: "invalid_action" }, 400);
    // Lapsed members retain the ability to cancel and reconcile their own recurring billing.
    if (body.action === "checkout" && !auth.active) return json({ error: "membership_required", detail: "Active One Mission membership is required before purchasing Nitrous." }, 403);
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return json({ error: "billing_unavailable", detail: "Nitrous checkout is temporarily unavailable." }, 503);
    const stripe = new Stripe(secret, { timeout: 15_000, maxNetworkRetries: 1 });
    if (body.action === "checkout") return json(await startNitrousCheckout(auth.admin, stripe, auth.user, new URL(req.url).origin));
    if (body.action === "cancel") return json({ addon: await cancelNitrousMemberSubscription(auth.admin, stripe, auth.user.id) });
    if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || body.sessionId.length > 255)) return json({ error: "invalid_checkout" }, 400);
    return json({ addon: await syncNitrousMemberBilling(auth.admin, stripe, auth.user.id, body.sessionId as string | undefined) });
  } catch (e) { return failure(e); }
}
