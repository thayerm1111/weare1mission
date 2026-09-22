import test from 'node:test';
import assert from 'node:assert/strict';
import { goldResvKey, blocksEntry, blockingRows, hedgeEnabled } from '../src/lib/genx/hedge';

test('hedging is on by default, and GENX_HEDGE=off restores one-trade-per-account', () => {
  delete process.env.GENX_HEDGE;
  assert.equal(hedgeEnabled(), true);
  assert.equal(goldResvKey('XAUUSD', 'buy'), 'XAUUSD:BUY');
  assert.equal(blocksEntry('sell', 'buy'), false);
  process.env.GENX_HEDGE = 'off';
  assert.equal(hedgeEnabled(), false);
  assert.equal(goldResvKey('XAUUSD', 'buy'), 'XAUUSD');
  assert.equal(blocksEntry('sell', 'buy'), true);
  delete process.env.GENX_HEDGE;
});
test('same side never stacks, whatever the setting', () => {
  assert.equal(blocksEntry('buy', 'buy'), true);
  assert.equal(blocksEntry('sell', 'SELL'), true);
});
test('an unknown side is treated as blocking rather than stacked blind', () => {
  assert.equal(blocksEntry(null, 'buy'), true);
  assert.equal(blocksEntry('', 'buy'), true);
});
test("owner 09-22: an open SELL no longer holds the BUY, but a second SELL is still refused", () => {
  const open = [{ side: 'sell', position_id: 'p1' }];
  assert.deepEqual(blockingRows(open, 'buy'), []);
  assert.equal(blockingRows(open, 'sell').length, 1);
});
