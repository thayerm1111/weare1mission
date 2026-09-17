import test from 'node:test';
import assert from 'node:assert/strict';
import { decideGate } from '../src/lib/genx/qualityGate';

const base = { minSlope: 1, minRr: 1.5 };
test('09-15 19:20 buy is blocked: the 20h average was falling', () => {
  const r = decideGate({ ...base, side: 'buy', entryLow: 4282.24, entryHigh: 4282.74, stop: 4280.02, tp: 4291.11, slope: -2.6 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /trend/);
});
test('09-15 14:58 buy is blocked: the 20h average was flat (+0.63 < $1)', () => {
  const r = decideGate({ ...base, side: 'buy', entryLow: 4294.11, entryHigh: 4295.1, stop: 4288.49, tp: 4310.06, slope: 0.63 });
  assert.equal(r.ok, false);
});
test('a sell with a falling 20h average and enough reward passes', () => {
  const r = decideGate({ ...base, side: 'sell', entryLow: 4288.33, entryHigh: 4289.25, stop: 4294.44, tp: 4276.25, slope: -2.84 });
  assert.equal(r.ok, true);
  assert.ok(r.rr! >= 1.5);
});
test('reward is measured from the worst allowed fill with the capped stop', () => {
  // buy zone top 4300, max entry 4301; stop 4280 capped to 4291 (100p); tp 4312 → rr 1.1
  const r = decideGate({ ...base, side: 'buy', entryLow: 4299, entryHigh: 4300, stop: 4280, tp: 4312, slope: 5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /rr/);
});
test('missing trend data fails open on the slope check', () => {
  const r = decideGate({ ...base, side: 'buy', entryLow: 4299, entryHigh: 4300, stop: 4295, tp: 4320, slope: null });
  assert.equal(r.ok, true);
});

test('owner 09-17: default minimum reward is 1:1 (the 09-16 1.22R SELL now passes)', async () => {
  const { minRR } = await import('../src/lib/genx/qualityGate');
  const prev = process.env.GENX_MIN_RR; process.env.GENX_MIN_RR = '1.5'; // a leftover setting must not change it
  try {
    assert.equal(minRR(), 1);
    const r = decideGate({ side: 'sell', entryLow: 4268.33, entryHigh: 4269.40, stop: 4276.06, tp: 4256.66, slope: -2, minSlope: 1 });
    assert.ok(r.rr! >= 1 && r.rr! < 1.5, `rr ${r.rr}`);
    assert.equal(r.ok, true, r.reason);
  } finally { if (prev != null) process.env.GENX_MIN_RR = prev; }
});
