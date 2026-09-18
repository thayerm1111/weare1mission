import test from 'node:test';
import assert from 'node:assert/strict';
import { rangePosition, blockedByRange, deskBreaker, BREAKER_PAUSE_MS } from '../src/lib/genx/rangeGuard';

// The overnight box the desk lost five trades inside: 4340.88 support, ~4380 high.
const box = Array.from({ length: 40 }, (_, i) => ({ h: 4380 - (i % 5), l: 4341 + (i % 4), c: 4360 }));

test('09-17 23:40 SELL at 4344 — selling the floor of the range is blocked', () => {
  const r = rangePosition(box, 4344.05);
  assert.ok(r && r.pos < 0.2);
  assert.equal(blockedByRange('sell', r).blocked, true);
});
test('09-18 03:30 SELL at 4345 — same trade, same block', () => {
  assert.equal(blockedByRange('sell', rangePosition(box, 4345.37)).blocked, true);
});
test('buying the ceiling is blocked too', () => {
  assert.equal(blockedByRange('buy', rangePosition(box, 4378)).blocked, true);
});
test('the trades that make money are untouched', () => {
  assert.equal(blockedByRange('buy', rangePosition(box, 4345)).blocked, false);    // long off the floor
  assert.equal(blockedByRange('sell', rangePosition(box, 4377)).blocked, false);   // short off the ceiling
  assert.equal(blockedByRange('buy', rangePosition(box, 4358)).blocked, false);    // mid-range
});
test('a real breakout is not a range trade', () => {
  assert.equal(rangePosition(box, 4392), null);       // clear of the high
  assert.equal(rangePosition(box, 4330), null);       // clear of the low
  assert.equal(blockedByRange('sell', rangePosition(box, 4330)).blocked, false);
});
test('no box, no opinion', () => {
  assert.equal(rangePosition([], 4350), null);
  assert.equal(rangePosition(Array.from({ length: 40 }, () => ({ h: 4350.5, l: 4350, c: 4350.2 })), 4350.2), null); // too tight
  assert.equal(blockedByRange('sell', null).blocked, false);
});
test('desk breaker: three stop-outs in six hours pauses new entries for four', () => {
  const now = Date.UTC(2026, 8, 18, 4, 0, 0);
  const h = (n: number) => now - n * 3600_000;
  assert.equal(deskBreaker([h(1), h(2)], now).paused, false);                       // two is not a streak
  const b = deskBreaker([h(0.5), h(1.5), h(4)], now);
  assert.equal(b.paused, true);
  assert.equal(b.until, h(0.5) + BREAKER_PAUSE_MS);                                 // cools off from the latest loss
  assert.equal(deskBreaker([h(7), h(8), h(9)], now).paused, false);                 // all outside the window
  assert.equal(deskBreaker([h(4.5), h(5), h(5.5)], now).paused, false);             // last loss >4h ago → trading again
});
