import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLocalRange, detectCompressionBreakout, arbitrateFamilies, familyScore, structuralRR,
  type FamilyCandidate, type Candle,
} from '../src/lib/genx2/families';

// ── C: LOCAL-RANGE REJECTION on a clean 100–110 range with a wick rejection at the high.
test('detectLocalRange finds a fade at the high with rr ≥ floor and stop outside the range', () => {
  const cs: Candle[] = [];
  for (let i = 0; i < 21; i++) {
    const hi = i % 4 === 2, lo = i % 4 === 0;
    const h = hi ? 110 : lo ? 104 : 107;
    const l = lo ? 100 : hi ? 106 : 103;
    cs.push({ o: (h + l) / 2, h, l, c: (h + l) / 2 });
  }
  cs.push({ o: 110, h: 111, l: 107, c: 108 }); // rejection: wick above 110, close back inside, bearish body
  const cand = detectLocalRange(cs, 3, 0.2, 0.75);
  assert.ok(cand, 'expected a local-range candidate');
  assert.equal(cand!.family, 'local_range_rejection');
  assert.equal(cand!.dir, 'sell');
  assert.ok(cand!.stop > cand!.entry, 'sell stop must sit ABOVE entry (outside the range)');
  assert.ok(cand!.target < cand!.entry, 'sell target must sit below entry');
  assert.ok(cand!.rr >= 0.75, `rr ${cand!.rr} must clear the floor`);
});

test('detectLocalRange stands down when the range is breaking (close beyond the high)', () => {
  const cs: Candle[] = [];
  for (let i = 0; i < 21; i++) {
    const hi = i % 4 === 2, lo = i % 4 === 0;
    const h = hi ? 110 : lo ? 104 : 107;
    const l = lo ? 100 : hi ? 106 : 103;
    cs.push({ o: (h + l) / 2, h, l, c: (h + l) / 2 });
  }
  cs.push({ o: 109, h: 113, l: 108, c: 112 }); // CLOSED above the range high → breaking, not a fade
  assert.equal(detectLocalRange(cs, 3, 0.2, 0.75), null);
});

// ── D: COMPRESSION BREAKOUT out of a narrow 100–104 box with a strong-body close.
test('detectCompressionBreakout fires on a confirmed displacement close, stop inside the box', () => {
  const cs: Candle[] = [];
  for (let i = 0; i < 17; i++) {
    const h = i % 2 ? 104 : 102, l = i % 2 ? 102 : 100;
    cs.push({ o: (h + l) / 2, h, l, c: (h + l) / 2 });
  }
  cs.push({ o: 104, h: 105.7, l: 103.9, c: 105.5 }); // strong-body close above the box high (104)
  const cand = detectCompressionBreakout(cs, 3, 0.2, 0.75, 120, 95);
  assert.ok(cand, 'expected a compression-breakout candidate');
  assert.equal(cand!.dir, 'buy');
  assert.ok(cand!.stop < cand!.entry, 'buy stop must sit below entry (back inside the box)');
  assert.ok(cand!.target > cand!.entry && cand!.rr >= 0.75);
});

test('detectCompressionBreakout refuses a chase beyond the extension limit', () => {
  const cs: Candle[] = [];
  for (let i = 0; i < 17; i++) {
    const h = i % 2 ? 104 : 102, l = i % 2 ? 102 : 100;
    cs.push({ o: (h + l) / 2, h, l, c: (h + l) / 2 });
  }
  // Close 8 above the boundary with atr 3 → extension 2.7×ATR > 1.2×ATR limit → refuse.
  cs.push({ o: 104, h: 112.2, l: 104, c: 112 });
  assert.equal(detectCompressionBreakout(cs, 3, 0.2, 0.75, 130, 95), null);
});

// ── D-gate: a strong close with a WEAK body (no displacement) does not qualify.
test('detectCompressionBreakout requires close-quality (rejects a weak-body poke)', () => {
  const cs: Candle[] = [];
  for (let i = 0; i < 17; i++) {
    const h = i % 2 ? 104 : 102, l = i % 2 ? 102 : 100;
    cs.push({ o: (h + l) / 2, h, l, c: (h + l) / 2 });
  }
  cs.push({ o: 105.3, h: 105.7, l: 100.2, c: 105.4 }); // closes above box but body is a tiny fraction of range
  assert.equal(detectCompressionBreakout(cs, 3, 0.2, 0.75, 120, 95), null);
});

// ── G: ARBITRATION — a breakout beyond a boundary invalidates a fade at that same boundary.
test('arbitrateFamilies never runs a range-fade and a breakout against the same boundary', () => {
  const fade: FamilyCandidate = {
    family: 'local_range_rejection', dir: 'sell', strategy: 'fade high', entry: 110, stop: 111.2, target: 105,
    orderType: 'market', invalidation: '', boundary: 110, validityMs: null,
    structureQ: 80, directionalQ: 55, executionQ: 70, rr: structuralRR('sell', 110, 111.2, 105), evidence: [],
  };
  const brk: FamilyCandidate = {
    family: 'compression_breakout', dir: 'buy', strategy: 'breakout long', entry: 110.5, stop: 108, target: 116,
    orderType: 'market', invalidation: '', boundary: 110, validityMs: null,
    structureQ: 70, directionalQ: 80, executionQ: 72, rr: structuralRR('buy', 110.5, 108, 116), evidence: [],
  };
  const winner = arbitrateFamilies([fade, brk]);
  assert.ok(winner);
  assert.equal(winner!.family, 'compression_breakout', 'the breakout must win; the same-boundary fade is dropped');
});

test('arbitrateFamilies picks the highest composite when boundaries do not conflict', () => {
  const a: FamilyCandidate = {
    family: 'local_range_rejection', dir: 'sell', strategy: 'A', entry: 200, stop: 202, target: 194,
    orderType: 'market', invalidation: '', boundary: 200, validityMs: null,
    structureQ: 85, directionalQ: 60, executionQ: 80, rr: 2, evidence: [],
  };
  const b: FamilyCandidate = {
    family: 'breakout_retest', dir: 'buy', strategy: 'B', entry: 100, stop: 98, target: 104,
    orderType: 'market', invalidation: '', boundary: 100, validityMs: 8 * 900000, rr: 1,
    structureQ: 60, directionalQ: 65, executionQ: 60, evidence: [],
  };
  assert.ok(familyScore(a) > familyScore(b));
  assert.equal(arbitrateFamilies([a, b])!.strategy, 'A');
});

test('arbitrateFamilies returns null on no candidates', () => {
  assert.equal(arbitrateFamilies([null, undefined]), null);
});
