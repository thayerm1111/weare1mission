import test from "node:test";
import assert from "node:assert/strict";
import { isActive, isFlowPass, safeSubView, RENEWAL_GRACE_MS, type SubRow } from "../src/lib/subscription";
import { periodEndSec, subscriptionIdOfInvoice, rowFromStripe } from "../src/lib/subscriptionSync";

/**
 * Owner 11-02: pmwneal was charged his $99 FLOW Pass renewal on 10-28 and the site stopped treating him as a
 * Pass holder that evening — the renewal never reached the record. Four more followed. And: "add a cancel
 * button or a pause button for customers. Also add the date they will get charged."
 */
const NOW = Date.UTC(2026, 10, 3, 3, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const pass = (o: Partial<SubRow> = {}): SubRow => ({ user_id: "u", plan: "flow_pass", status: "active", stripe_customer_id: "cus_x", stripe_subscription_id: "sub_1", current_period_end: iso(NOW + 10 * DAY), cancel_at_period_end: false, canceled_at: null, ...o });

test("renewals: the subscription id is found in every invoice shape Stripe sends", () => {
  assert.equal(subscriptionIdOfInvoice({ subscription: "sub_old" }), "sub_old");                     // older API
  assert.equal(subscriptionIdOfInvoice({ subscription: { id: "sub_obj" } }), "sub_obj");
  assert.equal(subscriptionIdOfInvoice({ parent: { subscription_details: { subscription: "sub_new" } } }), "sub_new");   // newer API
  assert.equal(subscriptionIdOfInvoice({ subscription: null, parent: null, lines: { data: [{ parent: { subscription_item_details: { subscription: "sub_line" } } }] } }), "sub_line");
  assert.equal(subscriptionIdOfInvoice({ lines: { data: [{ subscription: "sub_l2" }] } }), "sub_l2");
  assert.equal(subscriptionIdOfInvoice({}), null);
  assert.equal(subscriptionIdOfInvoice(null), null);
});

test("the period end is read from the subscription, or from its items on newer API versions", () => {
  assert.equal(periodEndSec({ id: "s", status: "active", customer: null, current_period_end: 1800000000 }), 1800000000);
  assert.equal(periodEndSec({ id: "s", status: "active", customer: null, items: { data: [{ current_period_end: 1800000500 }, { current_period_end: 1800000100 }] } }), 1800000500);
  assert.equal(periodEndSec({ id: "s", status: "active", customer: null }), null);
});

test("pmwneal's case: a Pass a few hours past its date while Stripe says active is still a Pass; two days past it is not", () => {
  assert.equal(isActive(pass({ current_period_end: iso(NOW - 3 * 3_600_000) }), NOW), true);   // renewal on its way
  assert.equal(isFlowPass(pass({ current_period_end: iso(Date.now() - 3 * 3_600_000) })), true);
  assert.ok(RENEWAL_GRACE_MS >= 24 * 3_600_000 && RENEWAL_GRACE_MS <= 48 * 3_600_000);
  assert.equal(isActive(pass({ current_period_end: iso(NOW - 2 * DAY) }), NOW), false);
  // a Pass set to cancel ends on its date — no grace
  assert.equal(isActive(pass({ current_period_end: iso(NOW - 3 * 3_600_000), cancel_at_period_end: true }), NOW), false);
  // a payment problem is not a Pass
  assert.equal(isActive(pass({ status: "past_due" }), NOW), false);
});

test("paused: the Pass runs to the end of the month that was paid for, and not a minute more", () => {
  const paused = pass({ paused_at: iso(NOW - 2 * DAY), paid_through: iso(NOW + 5 * DAY), current_period_end: iso(NOW + 5 * DAY) });
  assert.equal(isActive(paused, NOW), true);
  assert.equal(isActive(paused, NOW + 6 * DAY), false);
  // Stripe keeps a paused subscription "active" and rolls its (voided) periods on: the paid month still rules
  const rolled = pass({ paused_at: iso(NOW - 40 * DAY), paid_through: iso(NOW - 10 * DAY), current_period_end: iso(NOW + 20 * DAY) });
  assert.equal(isActive(rolled, NOW), false);
});

test("the card is told the next charge date — or that none is coming", () => {
  const running = safeSubView(pass(), NOW);
  assert.equal(running.nextChargeAt, iso(NOW + 10 * DAY));
  assert.equal(running.endsAt, null);
  const ending = safeSubView(pass({ cancel_at_period_end: true }), NOW);
  assert.equal(ending.nextChargeAt, null);
  assert.equal(ending.endsAt, iso(NOW + 10 * DAY));
  const paused = safeSubView(pass({ paused_at: iso(NOW - DAY), paid_through: iso(NOW + 4 * DAY) }), NOW);
  assert.equal(paused.paused, true);
  assert.equal(paused.nextChargeAt, null);
  assert.equal(paused.endsAt, iso(NOW + 4 * DAY));
  // a renewal date already behind us (the record catching up) is never shown as the next charge
  assert.equal(safeSubView(pass({ current_period_end: iso(NOW - 3_600_000) }), NOW).nextChargeAt, null);
  assert.equal(safeSubView(pass({ status: "past_due" }), NOW).paymentIssue, true);
});

test("writing Stripe's answer into the row: periods, cancel, pause — and an old plan never overwrites a new one", () => {
  const now = iso(NOW);
  const base = { id: "sub_1", status: "active", customer: "cus_x", current_period_end: Math.floor((NOW + 30 * DAY) / 1000), metadata: { plan: "flow_pass", user_id: "u" } };
  const r = rowFromStripe(base, "u", null, now)!;
  assert.equal(r.plan, "flow_pass");
  assert.equal(r.current_period_end, iso(NOW + 30 * DAY));
  assert.equal(r.paused_at, null);
  // paused at Stripe: the paid month is the current period
  const p = rowFromStripe({ ...base, pause_collection: { behavior: "void" } }, "u", { stripe_subscription_id: "sub_1" }, now)!;
  assert.equal(p.paused_at, now);
  assert.equal(p.paid_through, iso(NOW + 30 * DAY));
  // and stays the month paid for while Stripe rolls the voided periods on
  const later = rowFromStripe({ ...base, current_period_end: Math.floor((NOW + 60 * DAY) / 1000), pause_collection: { behavior: "void" } }, "u",
    { stripe_subscription_id: "sub_1", paused_at: now, paid_through: iso(NOW + 30 * DAY) }, iso(NOW + 31 * DAY))!;
  assert.equal(later.paused_at, now);
  assert.equal(later.paid_through, iso(NOW + 30 * DAY));
  // resumed: the pause is cleared
  const resumed = rowFromStripe(base, "u", { stripe_subscription_id: "sub_1", paused_at: now, paid_through: iso(NOW + 30 * DAY) }, now)!;
  assert.equal(resumed.paused_at, null);
  assert.equal(resumed.paid_through, null);
  // the $39 Suite a member upgraded from, cancelled by the upgrade, must not erase the Pass that replaced it
  assert.equal(rowFromStripe({ ...base, id: "sub_suite", status: "canceled", metadata: {} }, "u", { stripe_subscription_id: "sub_1" }, now), null);
  // …while the member's own plan ending is written as ended
  assert.equal(rowFromStripe({ ...base, status: "canceled" }, "u", { stripe_subscription_id: "sub_1" }, now)!.status, "canceled");
});

/** A fake admin client that records every write, for syncSubscription. */
function fakeAdmin(existing: Record<string, unknown> | null) {
  const writes: Array<{ table: string; op: string; values: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
  const from = (table: string) => {
    const q = {
      _op: "select", _values: {} as Record<string, unknown>, _filters: [] as Array<[string, unknown]>,
      select() { return q; },
      eq(col: string, v: unknown) { q._filters.push([col, v]); return q; },
      maybeSingle() { return Promise.resolve({ data: table === "user_subscriptions" ? existing : null, error: null }); },
      upsert(values: Record<string, unknown>) { writes.push({ table, op: "upsert", values, filters: [] }); return Promise.resolve({ error: null }); },
      update(values: Record<string, unknown>) { q._op = "update"; q._values = values; const rec = { table, op: "update", values, filters: q._filters }; writes.push(rec); return q; },
      then(res: (v: unknown) => unknown) { return Promise.resolve({ error: null }).then(res); },
    };
    return q;
  };
  return { admin: { from } as never, writes };
}
const fakeStripe = (sub: Record<string, unknown>) => ({ subscriptions: { retrieve: async () => sub } }) as never;

test("a running Pass is never left credit-paused: the sync clears a stale pause from before the Pass took effect", async () => {
  const { syncSubscription } = await import("../src/lib/subscriptionSync");
  const end = Math.floor((Date.now() + 20 * DAY) / 1000);
  const { admin, writes } = fakeAdmin({ stripe_subscription_id: "sub_1", status: "active", paused_at: null, paid_through: null });
  const res = await syncSubscription(admin, fakeStripe({ id: "sub_1", status: "active", metadata: { plan: "flow_pass", user_id: "u1" }, current_period_end: end, latest_invoice: { status: "paid" } }), "sub_1", "u1");
  assert.equal(res?.plan, "flow_pass");
  assert.equal(res?.latestInvoicePaid, true);
  const cleared = writes.filter((w) => w.op === "update").map((w) => `${w.table}:${Object.keys(w.values).join(",")}`);
  assert.deepEqual(cleared, ["flow_broker_accounts:flow_credit_paused", "flow_auto_settings:credit_paused"]);
  for (const w of writes.filter((x) => x.op === "update")) assert.deepEqual(w.filters[0], ["user_id", "u1"]);

  // A legacy Suite, or a Pass that has run out, is left to billing as before.
  const suite = fakeAdmin(null);
  await syncSubscription(suite.admin, fakeStripe({ id: "sub_2", status: "active", metadata: { user_id: "u2" }, current_period_end: end, latest_invoice: { status: "paid" } }), "sub_2", "u2");
  assert.equal(suite.writes.filter((w) => w.op === "update").length, 0);
  const ended = fakeAdmin(null);
  await syncSubscription(ended.admin, fakeStripe({ id: "sub_3", status: "canceled", metadata: { plan: "flow_pass", user_id: "u3" }, current_period_end: end - 40 * 86_400, latest_invoice: { status: "paid" } }), "sub_3", "u3");
  assert.equal(ended.writes.filter((w) => w.op === "update").length, 0);
});
