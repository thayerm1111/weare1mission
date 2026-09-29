import test from 'node:test';
import assert from 'node:assert/strict';
import { canAfford, weekStartUtc, unreachableFrom, setupBillableUsers, TRADE_COST, type BillRow } from '../src/lib/flow/flowBilling';

/**
 * PAY FOR THE TRADE, NOT THE ATTEMPT (owner 09-29: "when it's on and never takes a trade it looks like
 * it's pulling more than it should"). In one week 509 of 1,577 fires charged 5 credits and placed
 * nothing — 2,545 credits across 48 members. The fee now has a pre-gate (can the member pay?) that
 * charges nobody, and a post-fill charge. These pin the pure decisions behind both, and the two rules
 * that keep the 1-credit setup fee off members a setup could never reach.
 */

const WED = Date.UTC(2026, 8, 30, 15, 0);   // Wed 2026-09-30 15:00 UTC
const MON = Date.UTC(2026, 8, 28, 0, 0);    // the Monday that starts that week

test('the billing week starts Monday 00:00 UTC, like the database top-up', () => {
  assert.equal(weekStartUtc(WED), MON);
  assert.equal(weekStartUtc(MON), MON, 'Monday itself');
  assert.equal(weekStartUtc(Date.UTC(2026, 9, 4, 23, 59)), MON, 'Sunday night still belongs to that week');
  assert.equal(weekStartUtc(Date.UTC(2026, 9, 5, 0, 0)), Date.UTC(2026, 9, 5), 'next Monday starts the next week');
});

test('a member with the fee in their balance can pay', () => {
  assert.equal(canAfford({ balance: 5, topped_up_on: '2026-09-28' }, TRADE_COST, 5, WED), true);
  assert.equal(canAfford({ balance: 543, topped_up_on: '2026-09-28' }, TRADE_COST, 5, WED), true);
});

test('a member at zero who has already had this week\'s top-up cannot pay — they sit the fire out before any order', () => {
  assert.equal(canAfford({ balance: 0, topped_up_on: '2026-09-28' }, TRADE_COST, 5, WED), false);
  assert.equal(canAfford({ balance: 4, topped_up_on: '2026-09-29' }, TRADE_COST, 5, WED), false);
});

test('a member at zero whose weekly floor is still owed can pay, because the charge itself tops them up first', () => {
  assert.equal(canAfford({ balance: 0, topped_up_on: '2026-09-21' }, TRADE_COST, 5, WED), true, 'last topped up last week');
  assert.equal(canAfford({ balance: 0, topped_up_on: null }, TRADE_COST, 5, WED), true, 'never topped up');
  assert.equal(canAfford({ balance: 0, topped_up_on: '2026-09-21' }, 6, 5, WED), false, 'but not for more than the floor');
});

test('a brand-new member (no credits row yet) can pay: their first touch mints the welcome grant', () => {
  assert.equal(canAfford(null, TRADE_COST, 5, WED), true);
});

test('a member is "unreachable" when their latest broker failure is newer than their latest placed order', () => {
  const fails = [
    { user_id: 'a', created_at: '2026-09-29T10:00:00Z' },
    { user_id: 'a', created_at: '2026-09-29T12:00:00Z' },
    { user_id: 'b', created_at: '2026-09-29T09:00:00Z' },
    { user_id: 'c', created_at: '2026-09-29T09:00:00Z' },
  ];
  const placed = [
    { user_id: 'b', created_at: '2026-09-29T11:00:00Z' },   // traded after the failure → reachable again
    { user_id: 'c', created_at: '2026-09-29T08:00:00Z' },   // traded BEFORE the failure → still unreachable
  ];
  const u = unreachableFrom(fails, placed);
  assert.equal(u.has('a'), true, 'no trade since the failure');
  assert.equal(u.has('b'), false, 'a fill after the failure clears it');
  assert.equal(u.has('c'), true, 'an older fill does not');
  assert.equal(u.has('d'), false, 'never failed → never flagged');
});

const row = (user_id: string, over: Partial<BillRow> = {}): BillRow => ({ account_id: `acct-${user_id}`, user_id, flow_last_credit_at: null, flow_credit_paused: false, ...over });

test('the setup fee skips members whose broker is not usable', () => {
  const billable = new Map([['a', [row('a', { equity: 5000 })]], ['b', [row('b', { equity: 5000 })]]]);
  const g = setupBillableUsers(billable, new Set(['a']), 'quick');
  assert.equal(g.bill.has('a'), false);
  assert.equal(g.bill.has('b'), true);
  assert.equal(g.unreachable, 1);
});

test('a SWING setup does not bill a member whose every armed account is under the $1,500 floor, or of unknown size', () => {
  const billable = new Map([
    ['small', [row('small', { equity: 900 })]],
    ['unknown', [row('unknown', { equity: null, balance: null })]],
    ['mixed', [row('mixed', { equity: 900 }), row('mixed', { account_id: 'acct-mixed-2', equity: 2500 })]],
    ['big', [row('big', { balance: 3000 })]],
  ]);
  const g = setupBillableUsers(billable, new Set(), 'swing');
  assert.equal(g.bill.has('small'), false);
  assert.equal(g.bill.has('unknown'), false, 'swing refuses an unreadable size, so they could not take it');
  assert.equal(g.bill.has('mixed'), true, 'one account over the floor can take it');
  assert.equal(g.bill.has('big'), true);
  assert.equal(g.underFloor, 2);
});

test('quick and intraday setups are untouched by the floor — a small account can take those', () => {
  const billable = new Map([['small', [row('small', { equity: 900 })]], ['unknown', [row('unknown', {})]]]);
  for (const mode of ['quick', 'intraday', null]) {
    const g = setupBillableUsers(billable, new Set(), mode);
    assert.equal(g.bill.size, 2, String(mode));
    assert.equal(g.underFloor, 0);
  }
});

/**
 * SAY WHAT THE BROKER SAID (owner 09-29). GenesisFX began answering 403 "You are not allowed to use this API
 * endpoint…" on Monday evening; the panel showed members "…whether they allow A" — cut at 160 characters
 * with no idea who to call. The refusal now reads whole, names the fix, and every other error is unchanged.
 */
import { brokerRefusalMessage } from '../src/lib/flow/executor';

test("a broker 403 tells the member it's the broker's API switch and what to do", () => {
  const m = brokerRefusalMessage("Couldn't load broker instruments (403): You are not allowed to use this API endpoint. Please check with your broker whether they allow API access");
  assert.match(m, /^broker_api_access_off \(403\)/);
  assert.match(m, /Ask the broker to enable API access/);
  assert.ok(!/allow A$/.test(m), 'no mid-sentence cut');
});

test('any other instrument-list failure keeps its old shape', () => {
  assert.equal(brokerRefusalMessage('timeout'), 'instrument_list_failed: timeout');
  assert.ok(brokerRefusalMessage('x'.repeat(500)).length <= 160);
});
