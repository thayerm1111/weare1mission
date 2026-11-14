import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAN_SUITE, PLAN_FLOW_PASS } from '../src/lib/subscription';
import { FLOW_PASS } from '../src/lib/creditConfig';

/*
 * RETIRING THE $39 TRADING SUITE must never touch a FLOW Pass.
 *
 * The retire job was written (09-21) when the Suite was the only plan in user_subscriptions, and it cancelled
 * "every live row". The FLOW Pass (11-02) lives in the same table. Found 11-13 while switching off one Suite
 * member's renewal: the admin button labelled "Trading Suite ($39/mo) — retire" was showing 15 members and
 * would have cancelled 13 Passes with the 2 Suites.
 */
const route = readFileSync('src/app/api/admin/subscriptions/retire/route.ts', 'utf8');

test('the Suite retire job reads Suite rows only, and only Suite rows leave the reader', () => {
  assert.equal(PLAN_SUITE, 'trading_suite'); assert.equal(PLAN_FLOW_PASS, 'flow_pass');
  // The query is filtered by plan before it is filtered by status…
  assert.match(route, /\.select\("user_id, plan, stripe_subscription_id, status, cancel_at_period_end, current_period_end"\)\s*\n\s*\.eq\("plan", PLAN_SUITE\)\s*\n\s*\.in\("status", \["active", "trialing", "past_due"\]\)/);
  // …and the rows are filtered again in code, so a changed query cannot let a Pass through.
  assert.match(route, /\.filter\(\(r\) => r\.plan === PLAN_SUITE\)/);
  // Nothing else in the file reads the table unfiltered.
  assert.equal((route.match(/from\("user_subscriptions"\)\s*\n?\s*\.select/g) ?? []).length, 1);
});

test('before each cancellation Stripe itself is asked: a subscription tagged as a Pass is skipped, never cancelled', () => {
  assert.equal(FLOW_PASS.tag, 'flow_pass');
  const loop = route.slice(route.indexOf('for (const r of rows)'), route.indexOf('console.log(`[suite-retire]'));
  const ask = loop.indexOf('stripe.subscriptions.retrieve(r.stripe_subscription_id)');
  const skip = loop.indexOf('if (sub.metadata?.plan === FLOW_PASS.tag) { skipped.push(r.stripe_subscription_id); continue; }');
  const cancel = loop.indexOf('stripe.subscriptions.cancel(r.stripe_subscription_id)');
  const end = loop.indexOf('stripe.subscriptions.update(r.stripe_subscription_id, { cancel_at_period_end: true })');
  assert.ok(ask > 0 && skip > ask && cancel > skip && end > skip, 'the Pass check must come before either way of cancelling');
  // The check sits inside the try: if Stripe cannot be asked, the subscription is reported failed, not cancelled.
  assert.ok(loop.indexOf('try {') < ask && loop.indexOf('} catch (e) {') > end);
});

test('it still never refunds or deletes, and still needs an explicit confirm', () => {
  assert.doesNotMatch(route, /refunds\.create|\.delete\(\)|subscriptions\.del\b/);
  assert.match(route, /if \(body\.confirm !== true\) return json\(\{ error: "confirm_required"/);
});
