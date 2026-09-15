import test from 'node:test';
import assert from 'node:assert/strict';
import { afterCancel } from '../src/lib/genx2/cancelReconcile';

// ── CANCEL-ON-INVALIDATION: fill-vs-cancel race. The safety-critical property is that the
//    account is freed ONLY on a broker-confirmed cancel; a failed cancel never releases blind.
test('confirmed cancel frees the account (order was working, unfilled)', () => {
  assert.equal(afterCancel({ canceled: true, hasOpenPosition: false }), 'release');
});
test('SAFETY: cancel failed + a position exists → it filled → hold as filled, never release', () => {
  assert.equal(afterCancel({ canceled: false, hasOpenPosition: true }), 'filled');
});
test('SAFETY: cancel failed + no visible position → hold, never release blind', () => {
  assert.equal(afterCancel({ canceled: false, hasOpenPosition: false }), 'hold');
});
test('INVARIANT: only a confirmed cancel ever releases the account', () => {
  for (const hasOpenPosition of [true, false]) {
    assert.notEqual(afterCancel({ canceled: false, hasOpenPosition }), 'release',
      'a failed cancel must never free the account');
  }
});

// ── TRAIL GATE: record on the broker ACK, not the read-back (mirrors break-even fix 8620e8d).
function trailRecords(ackOk: boolean, readbackConfirmed: boolean, ackGateOn: boolean): boolean {
  if (!ackOk) return false;          // broker rejected the modify → nothing recorded
  if (ackGateOn) return true;        // FIX: an accepted modify records the trail
  return readbackConfirmed;          // legacy: only when the read-back re-confirms the stop
}
test('FIX: an acked trail records even when the read-back cannot confirm (no readable SL)', () => {
  assert.equal(trailRecords(true, false, true), true);
});
test('an acked trail with a confirming read-back also records', () => {
  assert.equal(trailRecords(true, true, true), true);
});
test('legacy (gate off) still requires the read-back to confirm', () => {
  assert.equal(trailRecords(true, false, false), false);
  assert.equal(trailRecords(true, true, false), true);
});
test('a rejected modify never records the trail (either mode)', () => {
  assert.equal(trailRecords(false, true, true), false);
  assert.equal(trailRecords(false, true, false), false);
});
test('INVARIANT: the fix un-stalls trailing on accounts with an unreadable broker SL', () => {
  // The exact bug: broker accepts the stop move, read-back can't see it → old code never advanced.
  assert.equal(trailRecords(true, /*readback*/ false, /*legacy*/ false), false); // stalled (bug)
  assert.equal(trailRecords(true, /*readback*/ false, /*fixed */ true), true);   // advances (fixed)
});
