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
  assert.equal(profitGuardPlan({ ...base, price: 4308, choch: null }), null);          // 80-pip peak: no lock yet
  assert.equal(profitGuardPlan({ ...base, price: 4308, choch: 'bullish' }), null);     // flip WITH a buy
  assert.equal(profitGuardPlan({ ...base, price: 4322, choch: null })!.why, 'lock');   // 220 peak: lock, not a snap
});
test('needs a 50+ pip peak', () => {
  assert.equal(profitGuardPlan({ ...base, price: 4303 }), null);                      // 30 pips, never higher
});
test('09-22 case: 106-pip risk, peaked +101, flipped — now snaps (was blocked by the 1R rule)', () => {
  const t = { side: 'buy', entry: 4330.72, R: 10.59, pip: 0.1, curStop: 4320.13, bePx: 4330.9 };
  const r = profitGuardPlan({ ...t, price: 4336.5, best: 4340.79, choch: 'bearish' });
  assert.ok(r && r.why === 'flip');
  assert.equal(r!.stop, 4335.3);                                                      // ~+46 pips locked
});
test('peak lock: +100 peak locks 40% of it with no flip', () => {
  const t = { side: 'buy', entry: 4330.72, R: 10.59, pip: 0.1, curStop: 4320.13, bePx: 4330.9 };
  const r = profitGuardPlan({ ...t, price: 4340, best: 4340.79, choch: null });
  assert.ok(r && r.why === 'lock');
  assert.equal(r!.stop, 4334.76);                                                     // +40 of a 101 peak
  assert.equal(profitGuardPlan({ ...t, price: 4339, best: 4339.5, choch: null }), null); // 88-pip peak: no lock
});
test('peak lock never sets a stop through the market, and does nothing once price is back at break-even', () => {
  const t = { side: 'sell', entry: 4300, R: 5, pip: 0.1, curStop: 4305, bePx: 4299.8 };
  const r = profitGuardPlan({ ...t, price: 4295, best: 4288, choch: null });          // peak 120, now +50
  assert.ok(r && r.stop >= 4295 + 1.2 - 1e-9 && r.stop <= 4299.8);
  assert.equal(profitGuardPlan({ ...t, price: 4299.5, best: 4288, choch: 'bullish' }), null);
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
