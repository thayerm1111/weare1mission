import test from 'node:test';
import assert from 'node:assert/strict';
import { breakEvenPlan, partialPlan } from '../src/lib/flow/memberManage';

test('break-even only tightens and only in profit', () => {
  assert.deepEqual(breakEvenPlan('buy', 4354.52, 4349.77, 4362.8), { ok: true, stop: 4354.52 });
  assert.equal(breakEvenPlan('buy', 4354.52, 4349.77, 4352).ok, false);        // not in profit
  assert.equal(breakEvenPlan('buy', 4354.52, 4356, 4362).ok, false);           // would widen
  assert.deepEqual(breakEvenPlan('sell', 4300, 4310, 4290), { ok: true, stop: 4300 });
  assert.equal(breakEvenPlan('sell', 4300, 4298, 4290).ok, false);
});
test('partial closes half, never the whole position, once', () => {
  assert.deepEqual(partialPlan(0.1, false), { ok: true, close: 0.05 });
  assert.equal(partialPlan(0.01, false).ok, false);
  assert.equal(partialPlan(0.1, true).ok, false);
  const p = partialPlan(0.03, false); assert.ok(p.ok && p.close < 0.03);
});
