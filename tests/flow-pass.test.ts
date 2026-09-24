import test from 'node:test';
import assert from 'node:assert/strict';
import { isActive, isFlowPass, PLAN_FLOW_PASS, PLAN_SUITE, type SubRow } from '../src/lib/subscription';
import { FLOW_PASS, PASS_COVERED, isPassCovered, CREDIT_COST } from '../src/lib/creditConfig';

/**
 * THE FLOW PASS — $99/mo, unmetered FLOW + GENX (owner 09-23).
 *
 * These tests pin the two rules that decide whether a member is charged. Both have an asymmetric
 * failure mode worth protecting: get the entitlement wrong in one direction and a paying member is
 * billed for what they already bought; get it wrong in the other and the whole product is free for
 * everyone. The gate is therefore written to FAIL CLOSED, and that is asserted here.
 */

const row = (over: Partial<SubRow> = {}): SubRow => ({
  user_id: 'u1',
  plan: PLAN_FLOW_PASS,
  status: 'active',
  stripe_customer_id: 'cus_1',
  stripe_subscription_id: 'sub_1',
  current_period_end: new Date(Date.now() + 7 * 864e5).toISOString(),
  cancel_at_period_end: false,
  canceled_at: null,
  ...over,
});

test('an active Pass is a Pass', () => {
  assert.equal(isFlowPass(row()), true);
});

test('a Pass cancelled at period end still counts until the period actually ends', () => {
  // The member paid for the month. Cancelling is a decision about the NEXT month, not this one —
  // billing them again for the rest of a month they already bought would be taking money twice.
  assert.equal(isFlowPass(row({ cancel_at_period_end: true })), true);
});

test('a lapsed Pass is not a Pass', () => {
  assert.equal(isFlowPass(row({ current_period_end: new Date(Date.now() - 864e5).toISOString() })), false);
});

test('an unpaid or past_due Pass is not a Pass', () => {
  assert.equal(isFlowPass(row({ status: 'past_due' })), false);
  assert.equal(isFlowPass(row({ status: 'canceled' })), false);
  assert.equal(isFlowPass(row({ status: 'unpaid' })), false);
});

test('a trialing Pass IS a Pass', () => {
  assert.equal(isFlowPass(row({ status: 'trialing' })), true);
});

test('the legacy $39 Suite is NOT a FLOW Pass, however active it is', () => {
  // The whole point of the upgrade prompt: a Suite member keeps being metered until they switch.
  // If this ever returns true, 16 members silently get the $99 product for $39.
  assert.equal(isFlowPass(row({ plan: PLAN_SUITE })), false);
  assert.equal(isActive(row({ plan: PLAN_SUITE })), true);
});

test('no subscription is not a Pass', () => {
  assert.equal(isFlowPass(null), false);
});

test('the Pass covers FLOW automation and GENX, and nothing else', () => {
  assert.equal(isPassCovered('flow_autorun'), true);
  assert.equal(isPassCovered('genx'), true);
  // Everything the member still pays for out of their 50 monthly credits.
  for (const f of ['chat', 'signal', 'scan', 'ghost', 'deepdive', 'chartread', 'command', 'command_center'] as const) {
    assert.equal(isPassCovered(f), false, `${f} must NOT be free with the Pass`);
  }
  assert.equal(PASS_COVERED.length, 2);
});

test('every covered feature is a real metered feature', () => {
  // Guards against a typo in PASS_COVERED silently covering nothing.
  for (const f of PASS_COVERED) assert.ok(CREDIT_COST[f] > 0, `${f} is not a metered feature`);
});

test('the Pass is priced and stocked as the owner set it', () => {
  assert.equal(FLOW_PASS.priceUsd, 99);
  assert.equal(FLOW_PASS.monthlyCredits, 50);
  assert.equal(FLOW_PASS.interval, 'month');
});

import { splitBy, type BillRow } from '../src/lib/flow/flowBilling';

const acct = (user: string, id: string): BillRow =>
  ({ account_id: id, user_id: user, flow_last_credit_at: null, flow_credit_paused: false });

function build(): Map<string, BillRow[]> {
  return new Map([
    ['payer', [acct('payer', 'a1')]],
    ['passer', [acct('passer', 'a2'), acct('passer', 'a3')]],
    ['offguy', [acct('offguy', 'a4')]],
  ]);
}

test('a Pass holder is not billed but IS still allowed to trade', () => {
  // The failure this guards against is subtle and expensive: "not billable" quietly becoming
  // "not traded", which would take FLOW away from the exact members who just paid $99 for it.
  const { bill, pass } = splitBy(build(), new Set(), new Set(['passer']));
  assert.deepEqual([...bill.keys()], ['payer', 'offguy']);
  assert.deepEqual([...pass.keys()], ['passer']);
  assert.equal(pass.get('passer')!.length, 2, 'every account the Pass holder owns must come through');
});

test('FLOW off beats a paid Pass — off means off', () => {
  // A member who paid and then switched FLOW off asked for it not to run. Money is not consent.
  const { bill, pass } = splitBy(build(), new Set(['passer']), new Set(['passer']));
  assert.equal(pass.has('passer'), false);
  assert.equal(bill.has('passer'), false);
});

test('an off member is dropped entirely — no trade and no charge', () => {
  const { bill, pass } = splitBy(build(), new Set(['offguy']), new Set());
  assert.equal(bill.has('offguy'), false);
  assert.equal(pass.has('offguy'), false);
  assert.deepEqual([...bill.keys()], ['payer', 'passer']);
});

test('with nobody off and nobody on a Pass, everyone is billed exactly as before', () => {
  const m = build();
  const { bill, pass } = splitBy(m, new Set(), new Set());
  assert.equal(bill, m, 'the untouched path must not copy the map');
  assert.equal(pass.size, 0);
});
