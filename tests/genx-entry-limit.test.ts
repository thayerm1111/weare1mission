import test from 'node:test';
import assert from 'node:assert/strict';
import { entryLimitPrice, ENTRY_FLOOR_RR } from '../src/lib/flow/executor';

const rr = (side: 'buy'|'sell', px: number, stop: number, tp: number) =>
  side === 'buy' ? (tp - px) / (px - stop) : (px - tp) / (stop - px);

test('owner floor is 0.8 (09-21, was 0.75)', () => assert.equal(ENTRY_FLOOR_RR, 0.8));

test('a chased SELL is capped at the 0.75 floor instead of filling at 0.18:1', () => {
  // The 02:56 incident shape: sell zone ~4350, stop 4358, target 4326.
  const stop = 4358, tp = 4326;
  const chased = 4331.5;                       // a late fan-out account's price
  assert.ok(rr('sell', chased, stop, tp) < ENTRY_FLOOR_RR, 'precondition: raw chase is under the floor');
  const px = entryLimitPrice('sell', chased, stop, tp, 2);
  assert.ok(px > chased, 'a sell limit may not sell BELOW the cap');
  assert.ok(rr('sell', px, stop, tp) >= ENTRY_FLOOR_RR - 1e-9, 'fill at the limit is >= 0.75:1');
});

test('a chased BUY is capped at the 0.75 floor', () => {
  const stop = 4300, tp = 4360;
  const chased = 4352;
  assert.ok(rr('buy', chased, stop, tp) < ENTRY_FLOOR_RR);
  const px = entryLimitPrice('buy', chased, stop, tp, 2);
  assert.ok(px < chased, 'a buy limit may not pay ABOVE the cap');
  assert.ok(rr('buy', px, stop, tp) >= ENTRY_FLOOR_RR - 1e-9);
});

test('a good price still gets cap-width tolerance, not a zero-tolerance limit', () => {
  // The 05:14 production incident: quote 4329 at 1.41:1, cap 4326. Pricing the limit at
  // the quote left no room for a single adverse tick and nothing filled (72% -> 0%).
  const px = 4329, stop = 4337, tp = 4317.75;
  const lim = entryLimitPrice('sell', px, stop, tp, 2);
  assert.equal(lim, 4326.31); // 0.8 floor (09-21)
  assert.ok(lim < px, 'a sell limit must sit BELOW the quote so the round-trip can tick');
  const rrAtLimit = (lim - tp) / (stop - lim);
  assert.ok(rrAtLimit >= ENTRY_FLOOR_RR - 1e-9, 'the worst fill it permits is still >= 0.75');
});

test('buy gets cap-width tolerance above the quote', () => {
  const px = 4310, stop = 4300, tp = 4360;
  const lim = entryLimitPrice('buy', px, stop, tp, 2);
  assert.ok(lim > px, 'a buy limit must sit ABOVE the quote');
  assert.ok((tp - lim) / (lim - stop) >= ENTRY_FLOOR_RR - 1e-9);
});

test('no target → limit at the executable price, never a market order', () => {
  // conservative snap: a buy rounds down, a sell rounds up
  assert.equal(entryLimitPrice('buy', 4321.456, 4300, null, 2), 4321.45);
  assert.equal(entryLimitPrice('sell', 4321.454, null, 4300, 2), 4321.46);
});
