import test from 'node:test';
import assert from 'node:assert/strict';
import { entryLimitPrice, goldMaxEntry, goldPastChaseLimit, goldMaxChasePips } from '../src/lib/flow/executor';

test('max entry is the zone edge plus 10 pips on the adverse side', () => {
  assert.equal(goldMaxEntry('buy', 4282.24, 4282.74, 10), 4283.74);
  assert.equal(goldMaxEntry('sell', 4288.33, 4289.25, 10), 4287.33);
  assert.equal(goldMaxEntry('buy', null, null, 10), null);
  assert.equal(goldMaxEntry('buy', 4282.24, 4282.74, 0), null);
});
test("the 09-15 19:20 buy: limit is capped at the zone edge + 10p, not the 0.75 R:R price", () => {
  // stop 4280.02, tp 4291.11 → R:R cap ≈ 4286.35; chase cap 4283.74 is stricter.
  assert.equal(entryLimitPrice('buy', 4285.5, 4280.02, 4291.11, 2, 4283.74), 4283.74);
  assert.equal(entryLimitPrice('buy', 4285.5, 4280.02, 4291.11, 2, null), 4286.35);
});
test('the 09-15 21:05 sell: limit is floored at the zone edge - 10p', () => {
  assert.equal(entryLimitPrice('sell', 4284.6, 4294.44, 4276.25, 2, 4287.33), 4287.33);
});
test('when the R:R cap is already stricter, it still wins', () => {
  // buy stop 4290, tp 4300 → R:R cap ≈ 4295.72; loose chase cap 4299 → R:R cap applies.
  assert.equal(entryLimitPrice('buy', 4295, 4290, 4300, 2, 4299), 4295.71);
});
test('past-chase detection and env default', () => {
  assert.equal(goldPastChaseLimit('buy', 4284, 4283.74), true);
  assert.equal(goldPastChaseLimit('sell', 4288, 4287.33), false);
  const prev = process.env.GENX_GOLD_MAX_CHASE_PIPS;
  delete process.env.GENX_GOLD_MAX_CHASE_PIPS; assert.equal(goldMaxChasePips(), 10);
  process.env.GENX_GOLD_MAX_CHASE_PIPS = '0'; assert.equal(goldMaxChasePips(), 0);
  if (prev === undefined) delete process.env.GENX_GOLD_MAX_CHASE_PIPS; else process.env.GENX_GOLD_MAX_CHASE_PIPS = prev;
});
