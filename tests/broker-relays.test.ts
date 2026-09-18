import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRoute } from '../src/lib/flow/tradelocker';

test('one route = everything stays on this server', () => {
  assert.equal(pickRoute('live:12345', 1), 0);
  assert.equal(pickRoute('live:12345', 0), 0);
});
test('an account always takes the same exit IP', () => {
  const a = pickRoute('live:803349', 4);
  for (let i = 0; i < 50; i++) assert.equal(pickRoute('live:803349', 4), a);
});
test('accounts spread across the exits', () => {
  const counts = new Array(4).fill(0);
  for (let i = 0; i < 400; i++) counts[pickRoute(`live:${800000 + i * 7}`, 4)] += 1;
  for (const c of counts) assert.ok(c > 400 / 4 * 0.5, `lopsided split: ${counts.join(",")}`);
  assert.equal(counts.reduce((a, b) => a + b, 0), 400);
});
