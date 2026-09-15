import test from 'node:test';
import assert from 'node:assert/strict';
import { reservationStateForOutcome } from '../src/lib/genx2/reservation';
import { structuralRR } from '../src/lib/genx2/families';

// ── RULE #1: order-outcome → reservation state. The safety-critical property is that an
//    ACCEPTED or UNKNOWN result NEVER releases the account (a second signal must not stack
//    while the first might still be live), and only a terminal no-fill frees it.
test('accepted (resting/pending) keeps the account reserved', () => {
  assert.equal(reservationStateForOutcome('accepted'), 'active');
});
test('filled holds the account until the position closes', () => {
  assert.equal(reservationStateForOutcome('filled'), 'filled');
});
test('SAFETY: unknown result never releases — held until reconciled', () => {
  assert.equal(reservationStateForOutcome('unknown'), 'unknown');
});
test('terminal no-fill (canceled/rejected) frees the account', () => {
  assert.equal(reservationStateForOutcome('canceled'), 'release');
  assert.equal(reservationStateForOutcome('rejected'), 'release');
});
test('INVARIANT: pending/unknown are never a release', () => {
  for (const o of ['accepted', 'filled', 'unknown'] as const) {
    assert.notEqual(reservationStateForOutcome(o), 'release');
  }
});

// ── RULE #3: 0.75 reward:risk floor, checked on absolute levels AFTER rounding.
test('0.75 floor: a compliant BUY passes, a sub-floor BUY fails', () => {
  // buy 4294 stop 4275.7 tp 4310.06 → reward 16.06 / risk 18.3 = 0.877 ≥ 0.75
  assert.ok(structuralRR('buy', 4294.1, 4275.7, 4310.06) >= 0.75);
  // tp too close → below floor
  assert.ok(structuralRR('buy', 4294.1, 4275.7, 4300.0) < 0.75);
});
test('0.75 floor: a compliant SELL passes with correct ordering', () => {
  assert.ok(structuralRR('sell', 4300, 4318, 4275) >= 0.75);
});
test('SAFETY: mis-ordered or invalid prices can never pass (rr = 0)', () => {
  assert.equal(structuralRR('buy', 4294, 4300, 4310), 0);   // stop above entry → invalid buy
  assert.equal(structuralRR('sell', 4300, 4290, 4275), 0);  // stop below entry → invalid sell
  assert.equal(structuralRR('buy', 4294, 4294, 4310), 0);   // zero risk
  assert.equal(structuralRR('buy', NaN, 4275, 4310), 0);    // NaN price
});
test('0.75 floor holds after rounding to 2dp (no manufactured qualifier)', () => {
  const entry = +(4294.104).toFixed(2), stop = +(4275.7).toFixed(2), tp = +(4310.06).toFixed(2);
  const rr = structuralRR('buy', entry, stop, tp);
  assert.ok(rr >= 0.75 && Number.isFinite(rr));
});

// ── FIX B (mirror): decision-state must not demote a confirmed setup when blockers reach 0.
function stateV2(overall: number, blockers: number, bands: { ready: number; develop: number; watch: number }) {
  if (overall >= bands.ready && blockers === 0) return 'TRADE_READY';
  if (overall >= bands.develop) return 'DEVELOPING_SETUP';
  if (overall >= bands.watch) return 'WATCHLIST';
  return 'NO_TRADE';
}
test('FIX B: a confirmed 65 (develop band) is DEVELOPING, not demoted to WATCHLIST', () => {
  const bands = { ready: 74, develop: 62, watch: 52 };
  assert.equal(stateV2(65, 1, bands), 'DEVELOPING_SETUP'); // with a blocker
  assert.equal(stateV2(65, 0, bands), 'DEVELOPING_SETUP'); // last blocker cleared → NOT demoted
});
test('FIX B: clearing the last blocker never lowers the state', () => {
  const bands = { ready: 74, develop: 62, watch: 52 };
  const order = { NO_TRADE: 0, WATCHLIST: 1, DEVELOPING_SETUP: 2, TRADE_READY: 3 } as const;
  for (const score of [55, 62, 65, 73, 74, 80]) {
    const withBlocker = order[stateV2(score, 1, bands) as keyof typeof order];
    const cleared = order[stateV2(score, 0, bands) as keyof typeof order];
    assert.ok(cleared >= withBlocker, `score ${score}: clearing blocker demoted ${withBlocker}→${cleared}`);
  }
});
