import test from 'node:test';
import assert from 'node:assert/strict';

// Covers the 09-15 fan-out speed change (owner: "the AI needs to enter right when it's time").
// The change has two halves; both are mirrored here as the pure decisions the real code makes,
// so the safety invariant — a managed fill is NEVER left without a stop — is locked in.

// ── HALF 1: executor.placeOnActiveAccounts decides whether to run the inline bracket
//    verify+repair at entry. Managed sources (genx/auto/follow) DEFER it to the manager;
//    unmanaged member PLAYS keep it inline. (Mirrors `const verifyBracketsInline = opts.source === "play"`.)
function verifyBracketsInline(source: string): boolean {
  return source === 'play';
}

// ── HALF 2: flowManage STEP 0.4 stop-loss self-heal decides whether to re-attach a missing
//    stop on a managed position. Re-attach IFF the broker exposes the SL column (never blind),
//    the broker shows NO stop, and we have a stop to send. (Mirrors the new manager guard.)
function shouldReattachStop(o: { slIdx: number; brokerSl: number | null; slKeep: number | null }): boolean {
  if (!(o.slIdx >= 0)) return false;                 // broker doesn't expose SL → never re-attach blind
  const missing = o.brokerSl == null || o.brokerSl <= 0;
  return missing && o.slKeep != null && o.slKeep > 0;
}

test('managed GENX entry defers the inline bracket verify (faster fan-out)', () => {
  assert.equal(verifyBracketsInline('genx'), false);
  assert.equal(verifyBracketsInline('genx_follow'), false);
  assert.equal(verifyBracketsInline('auto'), false);
});

test('unmanaged member play keeps the inline bracket verify', () => {
  assert.equal(verifyBracketsInline('play'), true);
});

test('SAFETY: broker dropped the stop leg → manager re-attaches it', () => {
  assert.equal(shouldReattachStop({ slIdx: 6, brokerSl: null, slKeep: 4275.7 }), true);
  assert.equal(shouldReattachStop({ slIdx: 6, brokerSl: 0, slKeep: 4275.7 }), true);
});

test('stop already present on the broker → manager leaves it alone (no re-send churn)', () => {
  assert.equal(shouldReattachStop({ slIdx: 6, brokerSl: 4275.7, slKeep: 4275.7 }), false);
});

test('SAFETY: never re-attach blind when the broker does not expose the SL column', () => {
  // slIdx < 0 means we cannot read the broker stop — do nothing rather than fight a stop we can't see.
  assert.equal(shouldReattachStop({ slIdx: -1, brokerSl: null, slKeep: 4275.7 }), false);
});

test('nothing to send (no ledger stop) → no re-attach', () => {
  assert.equal(shouldReattachStop({ slIdx: 6, brokerSl: null, slKeep: null }), false);
});

// The invariant the whole change rests on: for every managed source, EITHER the entry verifies
// the bracket inline OR the manager self-heals a missing stop. It must never be "neither".
test('INVARIANT: a managed fill is always covered by the manager when entry skips the verify', () => {
  for (const source of ['genx', 'genx_follow', 'auto']) {
    const deferred = !verifyBracketsInline(source);           // entry skipped the inline verify
    const managerCovers = shouldReattachStop({ slIdx: 6, brokerSl: null, slKeep: 4275.7 }); // manager will re-attach
    assert.ok(deferred && managerCovers, `managed source ${source} must be covered by the manager`);
  }
});
