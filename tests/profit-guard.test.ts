import test from 'node:test';
import assert from 'node:assert/strict';
import { profitGuardPlan, GUARD_BEHIND_PIPS } from '../src/lib/flow/profitGuard';
import { chochOfBars } from '../src/lib/genx/choch';

const base = { side: 'buy', entry: 4300, R: 5, pip: 0.1, curStop: 4305, bePx: 4300.5, choch: 'bearish' as const };

test('owner case: +220 pips on a 300-pip target, market flips → stop snaps in behind price', () => {
  const r = profitGuardPlan({ ...base, price: 4322 });
  assert.ok(r);
  assert.equal(r!.profitPips, 220);
  assert.equal(r!.stop, +(4322 - GUARD_BEHIND_PIPS * 0.1).toFixed(2));   // 4320.80 → ~208 pips locked
});
test('does nothing without a flip against the trade', () => {
  assert.equal(profitGuardPlan({ ...base, price: 4322, choch: null }), null);
  assert.equal(profitGuardPlan({ ...base, price: 4322, choch: 'bullish' }), null);   // flip WITH a buy
});
test('needs 1R and 50+ pips of real profit', () => {
  assert.equal(profitGuardPlan({ ...base, price: 4303 }), null);                      // 30 pips
  assert.equal(profitGuardPlan({ ...base, price: 4306, R: 20 }), null);               // 60 pips but < 1R
});
test('only tightens, and never worse than break-even', () => {
  assert.equal(profitGuardPlan({ ...base, price: 4322, curStop: 4321.5 }), null);     // already tighter
  const sell = profitGuardPlan({ side: 'sell', entry: 4300, price: 4278, R: 5, pip: 0.1, curStop: 4295, bePx: 4299.5, choch: 'bullish' });
  assert.ok(sell && sell.stop > 4278 && sell.stop <= 4299.5);
});
test('a wide spread pushes the snapped stop further from the market', () => {
  const tight = profitGuardPlan({ ...base, price: 4322 })!;
  const wide = profitGuardPlan({ ...base, price: 4322, spread: 3 })!;
  assert.ok(wide.stop < tight.stop);
});
test('structure read: chop is not a reversal', () => {
  const flat = Array.from({ length: 20 }, () => ({ h: 4301, l: 4300, c: 4300.5 }));
  assert.equal(chochOfBars(flat), null);
});
