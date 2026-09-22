import test from 'node:test';
import assert from 'node:assert/strict';
import { hedgeEnabled, blocksEntry, blockingPositions } from '../command-center/core/hedge';

test('ATLAS may hold one buy and one sell (owner 09-22)', () => {
  delete process.env.CC_HEDGE; delete process.env.GENX_HEDGE;
  assert.equal(hedgeEnabled(), true);
  const open = [{ id: 'p1', side: 'sell' }];
  assert.deepEqual(blockingPositions(open, 'buy'), []);      // the buy goes
  assert.equal(blockingPositions(open, 'sell').length, 1);   // a second sell does not
});
test('either kill switch restores one trade per account', () => {
  for (const key of ['CC_HEDGE', 'GENX_HEDGE'] as const) {
    process.env[key] = 'off';
    assert.equal(hedgeEnabled(), false);
    assert.equal(blocksEntry('sell', 'buy'), true);
    delete process.env[key];
  }
  assert.equal(hedgeEnabled(), true);
});
test('a side it cannot read blocks, rather than stacking blind', () => {
  assert.equal(blocksEntry('sell', null), true);
  assert.equal(blocksEntry(null, 'buy'), true);
  assert.equal(blockingPositions([{ side: null }], 'buy').length, 1);
});
