import test from 'node:test';
import assert from 'node:assert/strict';
import { breakEvenPlan, partialPlan } from '../src/lib/flow/memberManage';

test('break-even locks +5 pips of profit, only tightens, only past the market', () => {
  assert.deepEqual(breakEvenPlan('buy', 4354.52, 4349.77, 4362.8), { ok: true, stop: 4355.02 });   // entry + $0.50
  assert.equal(breakEvenPlan('buy', 4354.52, 4349.77, 4355.4).ok, false);      // <10 pips of profit
  assert.equal(breakEvenPlan('buy', 4354.52, 4356, 4362).ok, false);           // would widen an already-better stop
  assert.equal(breakEvenPlan('buy', 4354.52, 4349.77, null).ok, false);        // no price → never guess
  assert.deepEqual(breakEvenPlan('sell', 4300, 4310, 4288), { ok: true, stop: 4299.5 });
  assert.equal(breakEvenPlan('sell', 4300, 4310, 4299.2).ok, false);
  assert.equal(breakEvenPlan('sell', 4300, 4299, 4288).ok, false);
});
test('partial closes half, never the whole position, once', () => {
  assert.deepEqual(partialPlan(0.1, false), { ok: true, close: 0.05 });
  assert.equal(partialPlan(0.01, false).ok, false);
  assert.equal(partialPlan(0.1, true).ok, false);
  const p = partialPlan(0.03, false); assert.ok(p.ok && p.close < 0.03);
});
