import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { subscriptionIdOfInvoice } from "../subscriptionSync";
import {
  isNitrousAddonProduct, nitrousAddonAccess, nitrousPaidThrough, nitrousPeriodEnd,
  NITROUS_ADDON_PRICE_CENTS, NITROUS_ADDON_PRODUCT, validNitrousSubscription,
  type NitrousAddonAccess, type NitrousAddonSubscriptionRow, type NitrousStripeInvoice, type NitrousStripeSubscription,
} from "./addon-policy";

type Admin = SupabaseClient;
type CheckoutRow = { user_id: string; attempt_id: string; stripe_session_id: string | null; status: string;
  expires_at: string; return_origin: string; customer_email: string | null };
const ENDED = new Set(["canceled", "incomplete_expired"]);
const validUserId = (id: string) => /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id);
const idOf = (v: string | { id: string } | null | undefined) => typeof v === "string" ? v : v?.id ?? null;
const iso = (seconds: number | null) => seconds === null ? null : new Date(seconds * 1000).toISOString();

export class NitrousBillingError extends Error {
  constructor(public code: string, public detail: string, public status = 409) { super(code); }
}
const unavailable = () => new NitrousBillingError("billing_unavailable", "Nitrous billing could not be verified. Please try again.", 503);
function checked<T extends { error?: unknown }>(result: T): T { if (result.error) throw unavailable(); return result; }

export async function getNitrousAddonAccessMap(admin: Admin, userIds: string[]): Promise<Record<string, NitrousAddonAccess>> {
  const ids = [...new Set(userIds)];
  const result: Record<string, NitrousAddonAccess> = {};
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const grants = checked(await admin.from("nitrous_addon_grants").select("user_id,active").in("user_id", batch));
    const subscriptions: NitrousAddonSubscriptionRow[] = [];
    for (let page = 0; ; page += 1000) {
      const r = checked(await admin.from("nitrous_addon_subscriptions").select("*").in("user_id", batch)
        .order("stripe_subscription_id").range(page, page + 999));
      subscriptions.push(...(r.data ?? []) as NitrousAddonSubscriptionRow[]);
      if ((r.data ?? []).length < 1000) break;
    }
    for (const id of batch) result[id] = nitrousAddonAccess(
      (grants.data ?? []).some((g) => g.user_id === id && g.active === true), subscriptions.filter((s) => s.user_id === id));
  }
  return result;
}

export async function getNitrousAddonAccess(admin: Admin, userId: string): Promise<NitrousAddonAccess> {
  return (await getNitrousAddonAccessMap(admin, [userId]))[userId];
}

async function withBillingLock<T>(admin: Admin, userId: string, run: (owner: string) => Promise<T>): Promise<T> {
  const owner = randomUUID();
  const r = checked(await admin.rpc("nitrous_acquire_addon_billing_lock", { p_user: userId, p_owner: owner }));
  if (r.data !== true) throw new NitrousBillingError("billing_busy", "Another Nitrous billing update is finishing. Please try again shortly.");
  try { return await run(owner); }
  finally { await admin.rpc("nitrous_release_addon_billing_lock", { p_user: userId, p_owner: owner }); }
}

async function assertBillingLock(admin: Admin, userId: string, owner: string) {
  const r = checked(await admin.from("nitrous_addon_billing_locks").select("expires_at").eq("user_id", userId).eq("owner", owner).maybeSingle());
  if (!r.data || Date.parse(r.data.expires_at) <= Date.now()) throw new NitrousBillingError("billing_busy", "This billing update expired. Please refresh and try again.");
}

async function subscriptionsFor(admin: Admin, userId: string): Promise<NitrousAddonSubscriptionRow[]> {
  const r = checked(await admin.from("nitrous_addon_subscriptions").select("*").eq("user_id", userId)
    .not("status", "in", "(canceled,incomplete_expired)").limit(100));
  if ((r.data ?? []).length === 100) throw unavailable();
  return (r.data ?? []) as NitrousAddonSubscriptionRow[];
}

async function knownNitrousSubscription(admin: Admin, subscriptionId: string): Promise<boolean> {
  const r = checked(await admin.from("nitrous_addon_subscriptions").select("stripe_subscription_id").eq("stripe_subscription_id", subscriptionId).maybeSingle());
  return !!r.data;
}

/** Read Stripe itself on every sync; the webhook payload's order and browser success URL grant nothing. */
export async function syncNitrousSubscription(admin: Admin, stripe: Stripe, subscriptionId: string, userIdHint?: string): Promise<string> {
  const checkedAt = new Date().toISOString();
  let s = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] }) as unknown as NitrousStripeSubscription;
  const existingResult = checked(await admin.from("nitrous_addon_subscriptions").select("*").eq("stripe_subscription_id", subscriptionId).maybeSingle());
  const existing = existingResult.data as NitrousAddonSubscriptionRow | null;
  const userId = s.metadata?.user_id || existing?.user_id;
  if (!userId || !validUserId(userId) || (userIdHint && userIdHint !== userId) || (existing && existing.user_id !== userId)) {
    throw new NitrousBillingError("subscription_owner_mismatch", "This subscription does not belong to this member.", 403);
  }
  const valid = validNitrousSubscription(s, userId);
  if (!valid && !existing) throw new NitrousBillingError("wrong_subscription", "This is not a Nitrous add-on subscription.", 400);
  const grant = checked(await admin.from("nitrous_addon_grants").select("active").eq("user_id", userId).maybeSingle());
  // A paid checkout completing alongside a complimentary grant cannot leave future Nitrous renewals running.
  if (valid && grant.data?.active && !ENDED.has(s.status) && !s.cancel_at_period_end) {
    await stripe.subscriptions.update(s.id, { cancel_at_period_end: true });
    s = await stripe.subscriptions.retrieve(s.id, { expand: ["latest_invoice"] }) as unknown as NitrousStripeSubscription;
    if (!validNitrousSubscription(s, userId) || (!s.cancel_at_period_end && !ENDED.has(s.status))) throw unavailable();
  }
  let invoice: NitrousStripeInvoice | null = null;
  if (s.latest_invoice && typeof s.latest_invoice === "object") invoice = s.latest_invoice;
  else if (typeof s.latest_invoice === "string") invoice = await stripe.invoices.retrieve(s.latest_invoice) as unknown as NitrousStripeInvoice;
  const paidThrough = valid ? nitrousPaidThrough(s, invoice) : null;
  checked(await admin.rpc("nitrous_store_addon_subscription", { p_row: {
    stripe_subscription_id: s.id, user_id: userId, stripe_customer_id: idOf(s.customer),
    status: valid ? s.status : "invalid_product", current_period_end: iso(nitrousPeriodEnd(s)),
    paid_through: paidThrough, cancel_at_period_end: !!s.cancel_at_period_end,
    billing_paused: !!s.pause_collection || !valid, checked_at: checkedAt,
  } }));
  return userId;
}

function verifyCheckout(session: Stripe.Checkout.Session, userId: string) {
  if (session.mode !== "subscription" || !isNitrousAddonProduct(session.metadata) || session.metadata?.user_id !== userId
    || session.client_reference_id !== userId) {
    throw new NitrousBillingError("wrong_checkout", "This checkout does not belong to this member's Nitrous add-on.", 403);
  }
}

async function checkoutRow(admin: Admin, userId: string): Promise<CheckoutRow | null> {
  const r = checked(await admin.from("nitrous_addon_checkouts").select("*").eq("user_id", userId).maybeSingle());
  return r.data as CheckoutRow | null;
}

async function reconcileCheckout(admin: Admin, stripe: Stripe, userId: string, sessionId: string): Promise<Stripe.Checkout.Session> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new NitrousBillingError("invalid_checkout", "The checkout reference is invalid.", 400);
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  verifyCheckout(session, userId);
  const subId = idOf(session.subscription as string | { id: string } | null);
  if (session.status === "complete" && subId) await syncNitrousSubscription(admin, stripe, subId, userId);
  checked(await admin.from("nitrous_addon_checkouts").update({ status: session.status ?? "open", updated_at: new Date().toISOString() })
    .eq("user_id", userId).eq("stripe_session_id", session.id));
  return session;
}

export async function syncNitrousMemberBilling(admin: Admin, stripe: Stripe, userId: string, sessionId?: string): Promise<NitrousAddonAccess> {
  return withBillingLock(admin, userId, async () => {
    const current = await checkoutRow(admin, userId);
    if (sessionId || current?.stripe_session_id) await reconcileCheckout(admin, stripe, userId, sessionId || current!.stripe_session_id!);
    for (const row of await subscriptionsFor(admin, userId)) await syncNitrousSubscription(admin, stripe, row.stripe_subscription_id, userId);
    return getNitrousAddonAccess(admin, userId);
  });
}

/** Session parameters are persisted with the attempt so uncertain creates retry the exact same idempotency key. */
export async function startNitrousCheckout(admin: Admin, stripe: Stripe, user: { id: string; email?: string | null }, origin: string): Promise<{ url?: string; addon?: NitrousAddonAccess }> {
  return withBillingLock(admin, user.id, async (owner) => {
    let current = await checkoutRow(admin, user.id);
    if (current?.stripe_session_id) {
      const prior = await reconcileCheckout(admin, stripe, user.id, current.stripe_session_id);
      if (prior.status === "open") {
        const access = await getNitrousAddonAccess(admin, user.id);
        if (access.entitled) {
          await assertBillingLock(admin, user.id, owner);
          await stripe.checkout.sessions.expire(prior.id);
          checked(await admin.from("nitrous_addon_checkouts").update({ status: "expired" }).eq("user_id", user.id).eq("stripe_session_id", prior.id));
          return { addon: access };
        }
        if (prior.url) return { url: prior.url };
        throw unavailable();
      }
      current = { ...current, status: prior.status ?? current.status };
    }
    for (const row of await subscriptionsFor(admin, user.id)) await syncNitrousSubscription(admin, stripe, row.stripe_subscription_id, user.id);
    const access = await getNitrousAddonAccess(admin, user.id);
    if (access.entitled) return { addon: access };
    // A failed renewal is still an existing subscription; never open another recurring charge on top of it.
    if ((await subscriptionsFor(admin, user.id)).length) throw new NitrousBillingError("subscription_exists", "A Nitrous subscription already exists. Refresh its status or contact One Mission before starting another purchase.");
    if (current?.status === "creating" && !current.stripe_session_id && Date.parse(current.expires_at) <= Date.now()) {
      throw new NitrousBillingError("billing_verification_required", "An earlier checkout still needs verification. Contact One Mission before starting another purchase.");
    }
    if (!current || current.status !== "creating") {
      current = { user_id: user.id, attempt_id: randomUUID(), stripe_session_id: null, status: "creating",
        expires_at: new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000).toISOString(),
        return_origin: origin, customer_email: user.email ?? null };
      await assertBillingLock(admin, user.id, owner);
      checked(await admin.from("nitrous_addon_checkouts").upsert({ ...current, updated_at: new Date().toISOString() }, { onConflict: "user_id" }));
    }
    const metadata = { user_id: user.id, product: NITROUS_ADDON_PRODUCT, attempt_id: current.attempt_id };
    const back = `${current.return_origin}/portal/nitrous`;
    await assertBillingLock(admin, user.id, owner);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", payment_method_types: ["card"],
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: NITROUS_ADDON_PRICE_CENTS,
        recurring: { interval: "month" }, product_data: { name: "One Mission · Nitrous add-on",
          description: "Monthly access to Nitrous and Slow Drip. Requires active One Mission membership. Cancel future renewals from Nitrous." } } }],
      client_reference_id: user.id, customer_email: current.customer_email || undefined,
      metadata, subscription_data: { metadata },
      expires_at: Math.floor(Date.parse(current.expires_at) / 1000),
      success_url: `${back}?nitrous=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${back}?nitrous=canceled`,
      // Match this Stripe account's existing flat-price checkout configuration.
      managed_payments: { enabled: false },
    } as Stripe.Checkout.SessionCreateParams, { idempotencyKey: `nitrous-addon-${current.attempt_id}` });
    verifyCheckout(session, user.id);
    await assertBillingLock(admin, user.id, owner);
    checked(await admin.from("nitrous_addon_checkouts").update({ stripe_session_id: session.id, status: session.status ?? "open",
      updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("attempt_id", current.attempt_id));
    if (session.status !== "open" || !session.url) throw new NitrousBillingError("checkout_finished", "This checkout has finished. Refresh your Nitrous access.");
    return { url: session.url };
  });
}

async function cancelOwnedSubscription(admin: Admin, stripe: Stripe, row: NitrousAddonSubscriptionRow, userId: string, lockOwner: string) {
  const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id) as unknown as NitrousStripeSubscription;
  if (!validNitrousSubscription(sub, userId)) throw new NitrousBillingError("wrong_subscription", "This subscription could not be verified as this member's Nitrous add-on.", 409);
  await assertBillingLock(admin, userId, lockOwner);
  if (!ENDED.has(sub.status) && sub.status !== "active") await stripe.subscriptions.cancel(sub.id);
  else if (!ENDED.has(sub.status) && !sub.cancel_at_period_end) await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
  await syncNitrousSubscription(admin, stripe, sub.id, userId);
}

/** Cancel future Nitrous renewal only. This never touches Suite, FLOW Pass, credits, or voice. */
export async function cancelNitrousMemberSubscription(admin: Admin, stripe: Stripe, userId: string): Promise<NitrousAddonAccess> {
  return withBillingLock(admin, userId, async (owner) => {
    const current = await checkoutRow(admin, userId);
    if (current?.status === "creating" && !current.stripe_session_id) {
      throw new NitrousBillingError("billing_verification_required", "An earlier checkout still needs verification before cancellation can be confirmed. Contact One Mission.");
    }
    if (current?.stripe_session_id) {
      const session = await reconcileCheckout(admin, stripe, userId, current.stripe_session_id);
      if (session.status === "open") {
        await assertBillingLock(admin, userId, owner);
        await stripe.checkout.sessions.expire(session.id);
        checked(await admin.from("nitrous_addon_checkouts").update({ status: "expired" }).eq("user_id", userId).eq("stripe_session_id", session.id));
      }
    }
    for (const row of await subscriptionsFor(admin, userId)) await cancelOwnedSubscription(admin, stripe, row, userId, owner);
    return getNitrousAddonAccess(admin, userId);
  });
}

/** Complimentary access stops future add-on billing before the grant is committed. */
export async function setAdminNitrousGrant(admin: Admin, stripe: Stripe | null, userId: string, enabled: boolean, actorId: string): Promise<NitrousAddonAccess> {
  if (!validUserId(userId) || !validUserId(actorId)) throw new NitrousBillingError("invalid_member", "Choose a valid member.", 400);
  return withBillingLock(admin, userId, async (owner) => {
    if (enabled) {
      const current = await checkoutRow(admin, userId);
      if (current?.status === "creating" && !current.stripe_session_id) {
        if (!stripe) throw unavailable();
        // Do not grant while an unresolved create could leave a later payable checkout behind.
        throw new NitrousBillingError("checkout_pending", "This member's checkout is still being prepared. Ask them to refresh Nitrous, then retry the grant.");
      }
      if (current?.stripe_session_id && current.status !== "expired") {
        if (!stripe) throw unavailable();
        const session = await reconcileCheckout(admin, stripe, userId, current.stripe_session_id);
        if (session.status === "open") {
          await assertBillingLock(admin, userId, owner);
          await stripe.checkout.sessions.expire(session.id);
          checked(await admin.from("nitrous_addon_checkouts").update({ status: "expired" }).eq("user_id", userId).eq("stripe_session_id", session.id));
        }
      }
      const rows = await subscriptionsFor(admin, userId);
      if (rows.length && !stripe) throw unavailable();
      for (const row of rows) await cancelOwnedSubscription(admin, stripe!, row, userId, owner);
    }
    checked(await admin.rpc("nitrous_set_addon_grant", { p_user: userId, p_enabled: enabled, p_actor: actorId, p_lock_owner: owner }));
    return getNitrousAddonAccess(admin, userId);
  });
}

/** Return true whenever an event belongs to Nitrous, preventing every generic subscription fallthrough. */
export async function handleNitrousStripeEvent(admin: Admin, stripe: Stripe, event: Stripe.Event): Promise<boolean> {
  const kind = String(event.type);
  if (kind === "checkout.session.completed" || kind === "checkout.session.async_payment_succeeded" || kind === "checkout.session.async_payment_failed") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== "subscription") return false;
    const subId = idOf(session.subscription as string | { id: string } | null);
    if (!subId) {
      if (isNitrousAddonProduct(session.metadata)) throw unavailable();
      return false;
    }
    const sub = await stripe.subscriptions.retrieve(subId);
    if (!isNitrousAddonProduct(session.metadata) && !isNitrousAddonProduct(sub.metadata) && !await knownNitrousSubscription(admin, subId)) return false;
    if (!session.metadata?.user_id) throw unavailable();
    verifyCheckout(session, session.metadata.user_id);
    await syncNitrousSubscription(admin, stripe, subId, session.metadata.user_id);
    checked(await admin.from("nitrous_addon_checkouts").update({ stripe_session_id: session.id, status: session.status ?? "complete", updated_at: new Date().toISOString() })
      .eq("user_id", session.metadata.user_id).eq("attempt_id", session.metadata.attempt_id));
    return true;
  }
  if (kind.startsWith("customer.subscription.")) {
    const sub = event.data.object as Stripe.Subscription;
    if (!isNitrousAddonProduct(sub.metadata) && !await knownNitrousSubscription(admin, sub.id)) return false;
    await syncNitrousSubscription(admin, stripe, sub.id);
    return true;
  }
  if (["invoice.paid", "invoice.payment_failed", "invoice.payment_action_required", "invoice.voided", "invoice.marked_uncollectible"].includes(kind)) {
    const subId = subscriptionIdOfInvoice(event.data.object);
    if (!subId) return false;
    // Retrieval errors propagate. Unknown product must never fall through and become a Suite purchase.
    const sub = await stripe.subscriptions.retrieve(subId);
    if (!isNitrousAddonProduct(sub.metadata) && !await knownNitrousSubscription(admin, subId)) return false;
    await syncNitrousSubscription(admin, stripe, subId);
    return true;
  }
  return false;
}

/** Attempt ordering rotates failures too, without advancing the Stripe snapshot freshness fence. */
export async function reconcileNitrousAddonSubscriptions(admin: Admin, stripe: Stripe) {
  const r = checked(await admin.from("nitrous_addon_subscriptions").select("stripe_subscription_id,user_id")
    .not("status", "in", "(canceled,incomplete_expired)").order("reconciliation_attempted_at", { ascending: true, nullsFirst: true }).limit(20));
  let checkedCount = 0, failed = 0;
  const started = Date.now();
  for (const row of r.data ?? []) {
    // Cap each invocation so a slow provider cannot exhaust the platform's runtime.
    if (Date.now() - started > 25_000) break;
    checked(await admin.from("nitrous_addon_subscriptions").update({ reconciliation_attempted_at: new Date().toISOString() })
      .eq("stripe_subscription_id", row.stripe_subscription_id));
    try { await syncNitrousSubscription(admin, stripe, row.stripe_subscription_id, row.user_id); checkedCount++; }
    catch { failed++; }
  }
  return { checked: checkedCount, failed };
}
