import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasPaidNitrousAccess, nitrousAddonAccess, nitrousPaidThrough, NITROUS_ADDON_PRODUCT,
  validNitrousSubscription, type NitrousAddonSubscriptionRow, type NitrousStripeSubscription } from "../src/lib/nitrous/addon-policy";
import { cancelNitrousMemberSubscription, getNitrousAddonAccess, handleNitrousStripeEvent,
  reconcileNitrousAddonSubscriptions, setAdminNitrousGrant, startNitrousCheckout,
  syncNitrousMemberBilling, syncNitrousSubscription } from "../src/lib/nitrous/addon";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const END = Math.floor(Date.now() / 1000) + 30 * 86_400;
const NOW = new Date().toISOString();
const paidSub = (id = "sub_nitrous", userId = USER): NitrousStripeSubscription => ({
  id, status: "active", customer: "cus_nitrous", metadata: { user_id: userId, product: NITROUS_ADDON_PRODUCT },
  items: { data: [{ id: "si_nitrous", quantity: 1, current_period_end: END,
    price: { id: "price_nitrous", currency: "usd", unit_amount: 1999, recurring: { interval: "month", interval_count: 1 } } }] },
  cancel_at_period_end: false,
  latest_invoice: { id: "in_nitrous", status: "paid", currency: "usd", parent: { subscription_details: { subscription: id } },
    lines: { data: [{ parent: { subscription_item_details: { subscription: id, subscription_item: "si_nitrous" } },
      period: { end: END }, pricing: { price_details: { price: "price_nitrous" } } }] } },
});
const row = (id = "sub_nitrous", userId = USER): NitrousAddonSubscriptionRow => ({
  stripe_subscription_id: id, user_id: userId, stripe_customer_id: "cus_nitrous", status: "active", current_period_end: new Date(END * 1000).toISOString(),
  paid_through: new Date(END * 1000).toISOString(), cancel_at_period_end: false, billing_paused: false, checked_at: NOW,
});

type Row = Record<string, unknown>;
class Query implements PromiseLike<{ data: Row[]; error: null }> {
  filters: Array<(r: Row) => boolean> = []; mode = "read"; payload: Row[] = []; conflict = "";
  first = 0; last = Infinity; max = Infinity; sort: { key: string; asc: boolean; nullsFirst: boolean } | null = null;
  constructor(private db: MemoryDb, private table: string) {}
  select() { return this; }
  eq(k: string, v: unknown) { this.filters.push(r => r[k] === v); return this; }
  in(k: string, values: unknown[]) { this.filters.push(r => values.includes(r[k])); return this; }
  not(k: string, op: string, v: string) { assert.equal(op, "in"); const values = v.replace(/[()]/g, "").split(","); this.filters.push(r => !values.includes(String(r[k]))); return this; }
  order(key: string, options?: { ascending?: boolean; nullsFirst?: boolean }) { this.sort = { key, asc: options?.ascending !== false, nullsFirst: options?.nullsFirst === true }; return this; }
  range(first: number, last: number) { this.first = first; this.last = last; return this; }
  limit(max: number) { this.max = max; return this; }
  update(payload: Row) { this.mode = "update"; this.payload = [payload]; return this; }
  upsert(payload: Row, options: { onConflict: string }) { this.mode = "upsert"; this.payload = [payload]; this.conflict = options.onConflict; return this; }
  async maybeSingle() { const r = this.run(); return { data: r.data[0] ?? null, error: null }; }
  run() {
    const table = this.db.tables[this.table] ??= [];
    let rows = table.filter(r => this.filters.every(f => f(r)));
    if (this.mode === "update") rows.forEach(r => Object.assign(r, structuredClone(this.payload[0])));
    if (this.mode === "upsert") {
      for (const data of this.payload) { const existing = table.find(r => r[this.conflict] === data[this.conflict]); if (existing) Object.assign(existing, structuredClone(data)); else table.push(structuredClone(data)); }
      rows = this.payload;
    }
    if (this.sort) {
      const { key, asc, nullsFirst } = this.sort;
      rows = [...rows].sort((a, b) => a[key] == null ? b[key] == null ? 0 : nullsFirst ? -1 : 1 : b[key] == null ? nullsFirst ? 1 : -1 : String(a[key]).localeCompare(String(b[key])) * (asc ? 1 : -1));
    }
    return { data: structuredClone(rows.slice(this.first, Math.min(this.last + 1, this.first + this.max))), error: null };
  }
  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(onfulfilled?: ((v: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}
class MemoryDb {
  tables: Record<string, Row[]> = {};
  from(table: string) { return new Query(this, table); }
  async rpc(name: string, args: Row) {
    const locks = this.tables.nitrous_addon_billing_locks ??= [];
    if (name === "nitrous_acquire_addon_billing_lock") {
      if (locks.some(r => r.user_id === args.p_user && Date.parse(String(r.expires_at)) > Date.now())) return { data: false, error: null };
      this.tables.nitrous_addon_billing_locks = locks.filter(r => r.user_id !== args.p_user);
      this.tables.nitrous_addon_billing_locks.push({ user_id: args.p_user, owner: args.p_owner, expires_at: new Date(Date.now() + 120_000).toISOString() });
      return { data: true, error: null };
    }
    if (name === "nitrous_release_addon_billing_lock") {
      this.tables.nitrous_addon_billing_locks = locks.filter(r => r.user_id !== args.p_user || r.owner !== args.p_owner);
      return { data: null, error: null };
    }
    if (name === "nitrous_store_addon_subscription") {
      const data = args.p_row as Row;
      const subs = this.tables.nitrous_addon_subscriptions ??= [];
      const existing = subs.find(r => r.stripe_subscription_id === data.stripe_subscription_id);
      if (existing && existing.user_id !== data.user_id) return { data: null, error: { message: "owner" } };
      if (!existing) subs.push(structuredClone(data));
      else if (String(data.checked_at) >= String(existing.checked_at)) {
        const paid = String(existing.paid_through ?? "") > String(data.paid_through ?? "") ? existing.paid_through : data.paid_through;
        Object.assign(existing, structuredClone(data), { paid_through: paid });
      }
      return { data: null, error: null };
    }
    if (name === "nitrous_set_addon_grant") {
      assert.equal(args.p_actor, ADMIN);
      assert.ok(locks.some(l => l.owner === args.p_lock_owner && l.user_id === args.p_user));
      await this.from("nitrous_addon_grants").upsert({ user_id: args.p_user, active: args.p_enabled }, { onConflict: "user_id" });
      return { data: null, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  }
  client() { return this as unknown as SupabaseClient; }
}

class FakeStripe {
  subData = new Map<string, NitrousStripeSubscription>(); sessions = new Map<string, Stripe.Checkout.Session>();
  keys = new Map<string, Stripe.Checkout.Session>(); created = 0; createCalls = 0; failCreateOnce = false;
  updated: string[] = []; canceled: string[] = []; expired: string[] = []; retrieved: string[] = [];
  subscriptions = {
    retrieve: async (id: string) => { this.retrieved.push(id); const s = this.subData.get(id); if (!s) throw new Error("missing subscription"); return structuredClone(s); },
    update: async (id: string, args: { cancel_at_period_end: boolean }) => { this.updated.push(id); const s = this.subData.get(id)!; s.cancel_at_period_end = args.cancel_at_period_end; return structuredClone(s); },
    cancel: async (id: string) => { this.canceled.push(id); const s = this.subData.get(id)!; s.status = "canceled"; return structuredClone(s); },
  };
  invoices = { retrieve: async () => { throw new Error("Unexpected invoice lookup"); } };
  checkout = { sessions: {
    create: async (args: Stripe.Checkout.SessionCreateParams, opts: { idempotencyKey: string }) => {
      assert.deepEqual((args as Stripe.Checkout.SessionCreateParams & { managed_payments?: { enabled: boolean } }).managed_payments, { enabled: false });
      assert.equal(args.line_items?.[0]?.price_data?.unit_amount, 1999);
      assert.equal(args.line_items?.[0]?.price_data?.recurring?.interval, "month");
      this.createCalls++;
      let s = this.keys.get(opts.idempotencyKey);
      if (!s) {
        this.created++;
        s = { id: `cs_test_${this.created}`, mode: "subscription", status: "open", url: `https://checkout.stripe.com/c/pay/${this.created}`,
          metadata: args.metadata, client_reference_id: args.client_reference_id, expires_at: args.expires_at, subscription: null } as Stripe.Checkout.Session;
        this.keys.set(opts.idempotencyKey, s); this.sessions.set(s.id, s);
      }
      if (this.failCreateOnce) { this.failCreateOnce = false; throw new Error("network outcome unknown"); }
      return structuredClone(s);
    },
    retrieve: async (id: string) => { const s = this.sessions.get(id); if (!s) throw new Error("missing checkout"); return structuredClone(s); },
    expire: async (id: string) => { const s = this.sessions.get(id)!; assert.equal(s.status, "open"); this.expired.push(id); s.status = "expired"; s.url = null; return structuredClone(s); },
  } };
  client() { return this as unknown as Stripe; }
}

test("only paid current periods or explicit grants unlock Nitrous; canceled and old rows cannot override a current purchase", () => {
  const paid = row();
  assert.equal(hasPaidNitrousAccess(paid), true);
  for (const patch of [{ paid_through: null }, { paid_through: "invalid" }, { paid_through: "2000-01-01" }, { status: "past_due" }, { status: "trialing" }, { status: "canceled" }, { billing_paused: true }]) {
    assert.equal(hasPaidNitrousAccess({ ...paid, ...patch }), false);
  }
  assert.equal(nitrousAddonAccess(false, []).entitled, false);
  assert.equal(nitrousAddonAccess(true, []).source, "admin");
  assert.equal(nitrousAddonAccess(false, [{ ...paid, stripe_subscription_id: "old", status: "canceled" }, paid]).source, "subscription");
  assert.equal(nitrousAddonAccess(false, [{ ...paid, cancel_at_period_end: true }]).entitled, true);
});

test("paid invoice proof verifies product, owner, price, currency, line ownership and period in current and legacy Stripe shapes", () => {
  const sub = paidSub();
  const invoice = sub.latest_invoice as Exclude<typeof sub.latest_invoice, string | null | undefined>;
  assert.equal(validNitrousSubscription(sub, USER), true);
  assert.equal(validNitrousSubscription(sub, OTHER), false);
  assert.equal(nitrousPaidThrough(sub, invoice), new Date(END * 1000).toISOString());
  for (const altered of [
    { ...invoice, status: "open" }, { ...invoice, currency: "eur" }, { ...invoice, parent: { subscription_details: { subscription: "sub_other" } } },
    { ...invoice, lines: { data: [{ subscription: sub.id, subscription_item: "si_other", period: { end: END } }] } },
    { ...invoice, lines: { data: [{ subscription: sub.id, period: { end: END + 30 * 86_400 } }] } },
    { ...invoice, lines: { data: [{ subscription: sub.id, proration: true, period: { end: END } }] } },
  ]) assert.equal(nitrousPaidThrough(sub, altered), null);
  const cheaper = structuredClone(sub); cheaper.items!.data![0].price!.unit_amount = 1;
  assert.equal(nitrousPaidThrough(cheaper, invoice), null);
  assert.equal(nitrousPaidThrough(sub, { id: "legacy", status: "paid", currency: "usd", subscription: sub.id,
    lines: { data: [{ subscription: sub.id, subscription_item: "si_nitrous", price: { id: "price_nitrous" }, period: { end: END } }] } }), new Date(END * 1000).toISOString());
});

test("repeated checkout and uncertain transport retry create one Stripe session with one stable idempotency key", async () => {
  const db = new MemoryDb(), stripe = new FakeStripe(); stripe.failCreateOnce = true;
  await assert.rejects(startNitrousCheckout(db.client(), stripe.client(), { id: USER }, "https://weare1mission.com"));
  assert.equal(db.tables.nitrous_addon_billing_locks.length, 0);
  const first = await startNitrousCheckout(db.client(), stripe.client(), { id: USER }, "https://different-return.example");
  const second = await startNitrousCheckout(db.client(), stripe.client(), { id: USER }, "https://weare1mission.com");
  assert.equal(first.url, second.url); assert.equal(stripe.created, 1); assert.equal(stripe.createCalls, 2);
  assert.equal(db.tables.nitrous_addon_checkouts[0].return_origin, "https://weare1mission.com");
});

test("expired uncertain checkout cannot be discarded to create a second recurring purchase", async () => {
  const db = new MemoryDb(), stripe = new FakeStripe();
  db.tables.nitrous_addon_checkouts = [{ user_id: USER, attempt_id: "pending", stripe_session_id: null, status: "creating",
    expires_at: "2020-01-01", return_origin: "https://weare1mission.com", customer_email: null }];
  await assert.rejects(startNitrousCheckout(db.client(), stripe.client(), { id: USER }, "https://weare1mission.com"), /billing_verification_required/);
  assert.equal(stripe.created, 0); assert.equal(db.tables.nitrous_addon_checkouts[0].attempt_id, "pending");
});

test("checkout success sync checks owner and paid invoice, never a browser query flag", async () => {
  const db = new MemoryDb(), stripe = new FakeStripe();
  await startNitrousCheckout(db.client(), stripe.client(), { id: USER }, "https://weare1mission.com");
  const session = stripe.sessions.get("cs_test_1")!; session.status = "complete"; session.subscription = "sub_nitrous";
  stripe.subData.set("sub_nitrous", paidSub());
  await assert.rejects(syncNitrousMemberBilling(db.client(), stripe.client(), OTHER, session.id), /wrong_checkout/);
  assert.equal((await getNitrousAddonAccess(db.client(), OTHER)).entitled, false);
  assert.equal((await syncNitrousMemberBilling(db.client(), stripe.client(), USER, session.id)).entitled, true);
  assert.equal(db.tables.user_subscriptions, undefined);
  assert.equal(db.tables.user_credits, undefined);
});

test("active but unpaid Stripe subscription does not unlock access or permit duplicate checkout", async () => {
  const db = new MemoryDb(), stripe = new FakeStripe();
  const sub = paidSub(); (sub.latest_invoice as { status: string }).status = "open"; stripe.subData.set(sub.id, sub);
  await syncNitrousSubscription(db.client(), stripe.client(), sub.id, USER);
  assert.equal((await getNitrousAddonAccess(db.client(), USER)).entitled, false);
  await assert.rejects(startNitrousCheckout(db.client(), stripe.client(), { id: USER }, "https://weare1mission.com"), /subscription_exists/);
  assert.equal(stripe.created, 0);
});

test("an administrator's free grant cancels only Nitro future renewals and preserves separate plan rows", async () => {
  const db = new MemoryDb(), stripe = new FakeStripe();
  db.tables.nitrous_addon_subscriptions = [row()]; db.tables.user_subscriptions = [{ user_id: USER, stripe_subscription_id: "sub_suite" }];
  stripe.subData.set("sub_nitrous", paidSub());
  const result = await setAdminNitrousGrant(db.client(), stripe.client(), USER, true, ADMIN);
  assert.equal(result.source, "admin"); assert.equal(result.subscription?.cancelAtPeriodEnd, true);
  assert.deepEqual(stripe.updated, ["sub_nitrous"]); assert.deepEqual(stripe.canceled, []);
  assert.equal(db.tables.user_subscriptions[0].stripe_subscription_id, "sub_suite");
  const revoked = await setAdminNitrousGrant(db.client(), stripe.client(), USER, false, ADMIN);
  assert.equal(revoked.source, "subscription"); // paid-through access is not erased by removal of the free grant.
});

test("free grant and member cancellation expire pending payable checkouts", async () => {
  for (const action of ["grant", "cancel"]) {
    const db = new MemoryDb(), stripe = new FakeStripe();
    await startNitrousCheckout(db.client(), stripe.client(), { id: USER }, "https://weare1mission.com");
    if (action === "grant") await setAdminNitrousGrant(db.client(), stripe.client(), USER, true, ADMIN);
    else await cancelNitrousMemberSubscription(db.client(), stripe.client(), USER);
    assert.deepEqual(stripe.expired, ["cs_test_1"]);
    assert.equal(db.tables.nitrous_addon_checkouts[0].status, "expired");
  }
});

test("paid checkout arriving beside a complimentary grant stops its future Nitro renewal", async () => {
  const db = new MemoryDb(), stripe = new FakeStripe();
  db.tables.nitrous_addon_grants = [{ user_id: USER, active: true }]; stripe.subData.set("sub_nitrous", paidSub());
  await syncNitrousSubscription(db.client(), stripe.client(), "sub_nitrous", USER);
  assert.deepEqual(stripe.updated, ["sub_nitrous"]);
  assert.equal((await getNitrousAddonAccess(db.client(), USER)).source, "admin");
});

test("canceling an unpaid subscription ends it, while canceling paid active access honors the paid period", async () => {
  for (const status of ["active", "past_due", "incomplete"]) {
    const db = new MemoryDb(), stripe = new FakeStripe(); db.tables.nitrous_addon_subscriptions = [{ ...row(), status }];
    stripe.subData.set("sub_nitrous", { ...paidSub(), status });
    const result = await cancelNitrousMemberSubscription(db.client(), stripe.client(), USER);
    assert.equal(result.entitled, status === "active");
    if (status === "active") assert.deepEqual(stripe.updated, ["sub_nitrous"]);
    else assert.deepEqual(stripe.canceled, ["sub_nitrous"]);
  }
});

test("Nitrous invoice and subscription webhooks are consumed without touching main subscriptions or credits", async () => {
  for (const type of ["invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"]) {
    const db = new MemoryDb(), stripe = new FakeStripe(); stripe.subData.set("sub_nitrous", paidSub());
    const object = type.startsWith("invoice.") ? { parent: { subscription_details: { subscription: "sub_nitrous" } } } : paidSub();
    assert.equal(await handleNitrousStripeEvent(db.client(), stripe.client(), { type, data: { object } } as unknown as Stripe.Event), true);
    assert.equal(db.tables.user_subscriptions, undefined); assert.equal(db.tables.user_credits, undefined);
  }
  const source = readFileSync("src/app/api/stripe/webhook/route.ts", "utf8");
  assert.ok(source.indexOf("await handleNitrousStripeEvent") < source.indexOf('if (event.type === "checkout.session.completed")'));
});

test("unknown Stripe invoice product does not silently become a main subscription", async () => {
  const db = new MemoryDb(), stripe = new FakeStripe();
  await assert.rejects(handleNitrousStripeEvent(db.client(), stripe.client(), { type: "invoice.paid",
    data: { object: { parent: { subscription_details: { subscription: "sub_unknown" } } } } } as unknown as Stripe.Event));
  assert.equal(db.tables.user_subscriptions, undefined);
});

test("failed reconciliation attempts rotate without advancing Stripe snapshot checks", async () => {
  const db = new MemoryDb(), stripe = new FakeStripe();
  db.tables.nitrous_addon_subscriptions = [{ ...row("sub_deleted"), checked_at: "2020-01-01" }];
  const result = await reconcileNitrousAddonSubscriptions(db.client(), stripe.client());
  assert.deepEqual(result, { checked: 0, failed: 1 });
  assert.equal(db.tables.nitrous_addon_subscriptions[0].checked_at, "2020-01-01");
  assert.ok(db.tables.nitrous_addon_subscriptions[0].reconciliation_attempted_at);
});

test("wrong products and cross-user subscriptions never become Nitrous records", async () => {
  for (const sub of [{ ...paidSub(), metadata: { product: "flow_pass", user_id: USER } }, paidSub("sub_other", OTHER)]) {
    const db = new MemoryDb(), stripe = new FakeStripe(); stripe.subData.set(sub.id, sub);
    await assert.rejects(syncNitrousSubscription(db.client(), stripe.client(), sub.id, USER));
    assert.equal((db.tables.nitrous_addon_subscriptions ?? []).length, 0);
  }
});
