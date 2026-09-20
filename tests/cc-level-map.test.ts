import test from 'node:test';
import assert from 'node:assert/strict';
import { levelMap, aboveBelow, swings } from '../command-center/core/levelMap';

const H = 3600_000, D = 24 * H;
const NOW = Date.UTC(2026, 8, 20, 23, 0, 0); // Sunday evening, New York
const bar = (t: number, h: number, l: number) => ({ t, o: (h + l) / 2, h, l, c: (h + l) / 2 });

test('swings find a fractal high and low', () => {
  const bs = [bar(0, 10, 5), bar(1, 11, 6), bar(2, 12, 7), bar(3, 15, 8), bar(4, 12, 7), bar(5, 11, 3), bar(6, 12, 6), bar(7, 13, 7)];
  const s = swings(bs, 2);
  assert.deepEqual(s.highs.map((b) => b.h), [15]);
  assert.deepEqual(s.lows.map((b) => b.l), [3]);
});

test('the map reaches back to past days and last week, on both sides of price', () => {
  const d1 = [];
  for (let k = 12; k >= 1; k--) d1.push(bar(NOW - k * D, 4380 + k, 4340 - k));
  const m = levelMap({ d1, nowMs: NOW, price: 4371, atr: 3 });
  assert.ok(m.some((l) => l.label.includes("last week's low")), 'last week low present');
  const { above, below } = aboveBelow(4371, [[{ price: 4382, kind: 'dh', label: "today's high" }], m], 8);
  assert.ok(below.length > 0, 'there is a level below 4371');
  assert.ok(below.every((l) => l.price <= 4371));
  assert.ok(above.every((l) => l.price > 4371));
  assert.ok(above.some((l) => l.label === "today's high"));
  for (let i = 1; i < above.length; i++) assert.ok(above[i].price >= above[i - 1].price);
  for (let i = 1; i < below.length; i++) assert.ok(below[i].price <= below[i - 1].price, 'nearest first');
});

test('confluent levels merge and name every reason', () => {
  const d1 = [bar(NOW - 2 * D, 4400, 4350), bar(NOW - D, 4390, 4360)];
  const h4 = [];
  for (let k = 0; k < 9; k++) h4.push(bar(NOW - (20 - k) * 4 * H, k === 4 ? 4400.2 : 4380, 4370));
  const m = levelMap({ d1, h4, nowMs: NOW, price: 4371, atr: 3 });
  const at4400 = m.filter((l) => Math.abs(l.price - 4400) < 1);
  assert.equal(at4400.length, 1);
  assert.match(at4400[0].label, /4h swing high/);
});

test('no bars, no levels, no throw', () => {
  assert.deepEqual(levelMap({ nowMs: NOW, price: 4371, atr: 0 }), []);
});
