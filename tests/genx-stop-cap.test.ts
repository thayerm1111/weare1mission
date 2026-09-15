import test from 'node:test';
import assert from 'node:assert/strict';
import { capGoldStop, goldStopCapPips } from '../src/lib/flow/sizing';

test('a buy stop deeper than 100 pips is pulled in to exactly 100 pips', () => {
  assert.equal(capGoldStop('buy', 4312.5, 4297.28, 100), 4302.5);
});
test('a sell stop deeper than 100 pips is pulled in to exactly 100 pips', () => {
  assert.equal(capGoldStop('sell', 4346.5, 4362.0, 100), 4356.5);
});
test('a stop inside the cap is untouched (never widened)', () => {
  assert.equal(capGoldStop('buy', 4312.5, 4305.0, 100), 4305.0);
  assert.equal(capGoldStop('sell', 4346.5, 4350.66, 100), 4350.66);
});
test('never moves a stop that is already through the price, or when inputs are missing', () => {
  assert.equal(capGoldStop('buy', 4312.5, 4320, 100), 4320);
  assert.equal(capGoldStop('buy', null, 4290, 100), 4290);
  assert.equal(capGoldStop('buy', 4312.5, null, 100), null);
});
test('cap 0 disables it; env default is 100 and 0 turns it off', () => {
  assert.equal(capGoldStop('buy', 4312.5, 4250, 0), 4250);
  const prev = process.env.GENX_GOLD_STOP_CAP_PIPS;
  delete process.env.GENX_GOLD_STOP_CAP_PIPS; assert.equal(goldStopCapPips(), 100);
  process.env.GENX_GOLD_STOP_CAP_PIPS = '0'; assert.equal(goldStopCapPips(), 0);
  process.env.GENX_GOLD_STOP_CAP_PIPS = '80'; assert.equal(goldStopCapPips(), 80);
  if (prev === undefined) delete process.env.GENX_GOLD_STOP_CAP_PIPS; else process.env.GENX_GOLD_STOP_CAP_PIPS = prev;
});
