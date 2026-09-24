import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorkingEntry, orderSide, workingBlocks } from '../src/lib/flow/workingOrders';

/**
 * A RESTING ORDER IS EXPOSURE (owner 09-24: "Now there's multiple entries on all accounts. It's
 * supposed to be one at a time").
 *
 * The incident: a SELL_LIMIT at 4299.35 placed 01:46 was still resting when a second at 4292.55 went
 * out at 01:50. Neither was a position yet, so every existing guard saw an empty account and both
 * filled. These pin the three judgements that let that happen.
 */

const cols = undefined; // object-keyed rows; the columnar path shares the same `field` helper

test('a resting limit entry counts', () => {
  assert.equal(isWorkingEntry({ status: 'Working', type: 'Limit', side: 'sell' }, cols), true);
});

test('broker status spellings are all recognised as live', () => {
  for (const status of ['New', 'working', 'PENDING', 'accepted', 'partially_filled', 'Active']) {
    assert.equal(isWorkingEntry({ status, type: 'limit' }, cols), true, status);
  }
});

test('a filled or cancelled order is not exposure', () => {
  for (const status of ['Filled', 'Cancelled', 'rejected', 'expired']) {
    assert.equal(isWorkingEntry({ status, type: 'limit' }, cols), false, status);
  }
});

test("a position's protective stop is not a new entry", () => {
  // The bug this prevents is the mirror image: counting every managed trade's SL as exposure
  // would block the desk completely.
  assert.equal(isWorkingEntry({ status: 'working', type: 'StopLoss', positionId: '55' }, cols), false);
  assert.equal(isWorkingEntry({ status: 'working', type: 'TakeProfit', positionId: '55' }, cols), false);
});

test('an order attached to an existing position is not a new entry', () => {
  assert.equal(isWorkingEntry({ status: 'working', type: 'limit', positionId: '900' }, cols), false);
  assert.equal(isWorkingEntry({ status: 'working', type: 'limit', positionId: '0' }, cols), true);
});

test('side is read from whichever key the broker uses', () => {
  assert.equal(orderSide({ side: 'SELL' }, cols), 'sell');
  assert.equal(orderSide({ orderSide: 'Buy' }, cols), 'buy');
  assert.equal(orderSide({ direction: 'sell' }, cols), 'sell');
  assert.equal(orderSide({ side: 'flat' }, cols), null);
});

test('a resting sell blocks another sell', () => {
  assert.equal(workingBlocks(new Set(['sell']), 'sell'), true);
});

test('a resting sell does NOT block a buy while hedging is on', () => {
  // Owner 09-22: one buy and one sell at a time is allowed, opposite directions are fine.
  assert.equal(workingBlocks(new Set(['sell']), 'buy'), false);
});

test('an unreadable broker blocks — fail closed', () => {
  // A missed entry is recoverable; a stacked position is not.
  assert.equal(workingBlocks(null, 'sell'), true);
  assert.equal(workingBlocks(null, 'buy'), true);
});

test('no resting orders blocks nothing', () => {
  assert.equal(workingBlocks(new Set(), 'sell'), false);
  assert.equal(workingBlocks(new Set(), 'buy'), false);
});

test('the 09-24 stack is refused: a resting 4299.35 sell blocks the 4292.55 sell', () => {
  const resting = new Set(['sell']);            // the 01:46 SELL_LIMIT, still unfilled at 01:50
  assert.equal(workingBlocks(resting, 'sell'), true);
});
