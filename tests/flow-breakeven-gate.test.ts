import test from 'node:test';
import assert from 'node:assert/strict';
import { breakEvenOutcome } from '../src/lib/flow/flowManage';

// Mirrors the manager: be_done is set for any non-'failed' outcome, and STEP 3 TRAIL
// is gated on be_done (`if (beOn && row.be_done && ...)`).
function applyBreakEven(mv: { ok: boolean; error?: string }, readBackConfirms: boolean) {
  const outcome = breakEvenOutcome(mv.ok, mv.ok ? undefined : mv.error);
  if (outcome === 'failed') return { be_done: false, cur_stop: 'initial', reason: null, trailEligible: false };
  const reason = readBackConfirms ? 'broker_confirmed' : outcome === 'already' ? 'already_at_be' : 'acked_no_readback';
  return { be_done: true, cur_stop: 'break_even', reason, trailEligible: true };
}

test('modify ACK + read-back mismatch → be_done true, trail eligible', () => {
  const r = applyBreakEven({ ok: true }, false);
  assert.equal(r.be_done, true);
  assert.equal(r.cur_stop, 'break_even');
  assert.equal(r.reason, 'acked_no_readback');   // mismatch is observability, not a gate
  assert.equal(r.trailEligible, true);
});

test('modify ACK + read-back confirms → be_done true, broker_confirmed', () => {
  const r = applyBreakEven({ ok: true }, true);
  assert.equal(r.be_done, true);
  assert.equal(r.reason, 'broker_confirmed');
  assert.equal(r.trailEligible, true);
});

test('modify FAILS → be_done stays false, stop stays initial, no trail', () => {
  const r = applyBreakEven({ ok: false, error: 'Reason for rejection: insufficient margin' }, false);
  assert.equal(r.be_done, false);
  assert.equal(r.cur_stop, 'initial');
  assert.equal(r.reason, null);
  assert.equal(r.trailEligible, false, 'a break-even the broker refused must never enable trailing');
});

test('"Nothing to change" is the broker confirming the stop is already at break-even', () => {
  // The 51-position production stall: first modify moved the stop, read-back failed,
  // be_done stayed false, and every retry was rejected as redundant forever.
  const r = applyBreakEven({ ok: false, error: 'Reason for rejection: Nothing to change.' }, false);
  assert.equal(r.be_done, true);
  assert.equal(r.reason, 'already_at_be');
  assert.equal(r.trailEligible, true);
});

test('outcome classification', () => {
  assert.equal(breakEvenOutcome(true), 'acked');
  assert.equal(breakEvenOutcome(false, 'Nothing to change.'), 'already');
  assert.equal(breakEvenOutcome(false, 'nothing   to change'), 'already');
  assert.equal(breakEvenOutcome(false, 'market closed'), 'failed');
  assert.equal(breakEvenOutcome(false, undefined), 'failed');
  assert.equal(breakEvenOutcome(false, ''), 'failed');
});
