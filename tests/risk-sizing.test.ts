import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAccountRisk, resolveDefaultRisk,
  RISK_DEFAULT_CONSERVATIVE, RISK_DEFAULT_AGGRESSIVE,
} from '../src/lib/flow/sizing';

// Mirrors executor.ts placeOnActiveAccounts: caps apply ON TOP of the resolved %.
function effectiveRisk(equity: number, acct?: number | null, member?: number | null, mode?: string | null) {
  let r = resolveAccountRisk(acct, member, mode);
  if (equity < 2000) r = Math.min(r, 2);
  if (equity <= 600) r = Math.min(r, 0.5);
  return r;
}

test('(a) aggressive + no explicit risk anywhere → 2%', () => {
  assert.equal(resolveAccountRisk(null, null, 'aggressive'), RISK_DEFAULT_AGGRESSIVE);
  assert.equal(resolveAccountRisk(null, null, 'AGGRESSIVE'), 2);
});

test('(b) conservative (or unset mode) + no explicit risk → 1%', () => {
  assert.equal(resolveAccountRisk(null, null, 'conservative'), RISK_DEFAULT_CONSERVATIVE);
  assert.equal(resolveAccountRisk(null, null, null), 1);
  assert.equal(resolveAccountRisk(null, null, undefined), 1);
});

test('(c) an explicit per-account % wins regardless of mode', () => {
  assert.equal(resolveAccountRisk(3, null, 'conservative'), 3);
  assert.equal(resolveAccountRisk(0.5, null, 'aggressive'), 0.5);
  assert.equal(resolveAccountRisk(1, null, 'aggressive'), 1, 'an explicit 1% is a choice, not a fallback');
});

test("the member's saved account-wide % outranks the mode default", () => {
  // The 53 production accounts that already size from the member's own selection must
  // not be silently resized by their safety mode.
  assert.equal(resolveAccountRisk(null, 3, 'aggressive'), 3);
  assert.equal(resolveAccountRisk(null, 1, 'aggressive'), 1);
  assert.equal(resolveAccountRisk(null, 0.5, 'conservative'), 0.5);
});

test('(d) small-account caps still clamp on top', () => {
  assert.equal(effectiveRisk(750, null, null, 'aggressive'), 2);     // under $2k → 2% cap
  assert.equal(effectiveRisk(500, null, null, 'aggressive'), 0.5);   // <= $600 → 0.5% cap
  assert.equal(effectiveRisk(600, null, null, 'aggressive'), 0.5);
  assert.equal(effectiveRisk(1500, 5, null, 'aggressive'), 2, 'explicit 5% still capped under $2k');
  assert.equal(effectiveRisk(50000, null, null, 'aggressive'), 2, 'no cap on a large account');
});

test('junk values fall through to the mode default', () => {
  assert.equal(resolveAccountRisk(0, null, 'aggressive'), 2);
  assert.equal(resolveAccountRisk(-1, null, 'conservative'), 1);
  assert.equal(resolveAccountRisk(NaN, null, 'aggressive'), 2);
  assert.equal(resolveDefaultRisk(NaN, 'aggressive'), 2);
});
