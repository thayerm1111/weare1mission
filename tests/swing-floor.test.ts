import test from 'node:test';
import assert from 'node:assert/strict';
import { swingAllowed, isSwingMode, accountSize, partitionBySwingFloor, SWING_MIN_BALANCE } from '../src/lib/genx/swingFloor';

/**
 * SWING NEEDS A REAL ACCOUNT BEHIND IT (owner 09-24: "On smaller accounts don't let them take swing
 * trades the stops are too high. It's too big of a % of their accounts").
 *
 * Gold's minimum lot is one ounce, so a 695-pip swing stop risks ~$69.50 no matter how small the
 * member's risk % is. At the median armed balance of $1,000 that was ~7% of the account on one trade.
 */

test('the floor is the $1,500 the owner set', () => {
  assert.equal(SWING_MIN_BALANCE, 1500);
});

test('only swing is floored — quick and intraday still size down normally', () => {
  const tiny = { equity: 200 };
  assert.equal(swingAllowed(tiny, 'quick'), true);
  assert.equal(swingAllowed(tiny, 'intraday'), true);
  assert.equal(swingAllowed(tiny, 'swing'), false);
  assert.equal(swingAllowed(tiny, null), true, 'a call with no stated horizon is not a swing');
});

test('isSwingMode is not fooled by case or padding', () => {
  assert.equal(isSwingMode(' Swing '), true);
  assert.equal(isSwingMode('SWING'), true);
  assert.equal(isSwingMode('swinging'), false);
  assert.equal(isSwingMode(undefined), false);
});

test('an account exactly at the floor is allowed', () => {
  assert.equal(swingAllowed({ equity: 1500 }, 'swing'), true);
  assert.equal(swingAllowed({ equity: 1499.99 }, 'swing'), false);
});

test('live equity is preferred over stored balance', () => {
  // A member who has drawn down below the floor should not get a swing on a stale balance.
  assert.equal(accountSize({ equity: 900, balance: 5000 }), 900);
  assert.equal(swingAllowed({ equity: 900, balance: 5000 }, 'swing'), false);
});

test('stored balance is used when equity is missing', () => {
  assert.equal(accountSize({ equity: null, balance: 2000 }), 2000);
  assert.equal(swingAllowed({ equity: null, balance: 2000 }, 'swing'), true);
});

test('an unreadable account size refuses SWING but nothing else', () => {
  // Fails closed here on purpose: a wrong yes risks a double-digit % of someone's account,
  // a wrong no costs one swing entry. Quick/intraday must stay unaffected so an unreadable
  // balance can never stand an account down completely.
  const unknown = { equity: null, balance: null };
  assert.equal(swingAllowed(unknown, 'swing'), false);
  assert.equal(swingAllowed(unknown, 'quick'), true);
  assert.equal(swingAllowed(unknown, 'intraday'), true);
});

test('zero and negative balances are treated as unknown, not as huge accounts', () => {
  assert.equal(accountSize({ equity: 0, balance: 0 }), null);
  assert.equal(swingAllowed({ equity: -50 }, 'swing'), false);
});

test('partition splits the fan-out and leaves non-swing untouched', () => {
  const accts = [{ equity: 5000 }, { equity: 800 }, { equity: 1500 }, { equity: null, balance: null }];
  const swing = partitionBySwingFloor(accts, 'swing');
  assert.equal(swing.allowed.length, 2);
  assert.equal(swing.tooSmall.length, 2);
  const quick = partitionBySwingFloor(accts, 'quick');
  assert.equal(quick.allowed.length, 4);
  assert.equal(quick.tooSmall.length, 0);
});

test('the floor is overridable without a redeploy', () => {
  assert.equal(swingAllowed({ equity: 2500 }, 'swing', 5000), false);
  assert.equal(swingAllowed({ equity: 2500 }, 'swing', 1000), true);
});
