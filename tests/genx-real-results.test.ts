import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf, clusterFires, buildRealResults, type RealRow } from '../src/lib/genx/realResults';

const row = (o: Partial<RealRow>): RealRow => ({ side: 'buy', outcome: 'stop', result_pips: -50, created_at: '2026-09-16T14:00:00Z', resolved_at: '2026-09-16T15:00:00Z', manage_style: 'be_on', ...o });

test('manual close is self manage regardless of the account setting', () => {
  assert.equal(bucketOf({ outcome: 'manual', manage_style: 'be_off' }), 'self_manage');
  assert.equal(bucketOf({ outcome: 'manual', manage_style: 'play_out' }), 'self_manage');
});
test('non-manual trades follow the style snapshotted when the trade fired', () => {
  assert.equal(bucketOf({ outcome: 'breakeven', manage_style: 'be_on' }), 'be_on');
  assert.equal(bucketOf({ outcome: 'stop', manage_style: 'be_off' }), 'be_off');
  assert.equal(bucketOf({ outcome: 'target', manage_style: 'play_out' }), 'play_out');
});
test('rows from before the cutover (no style) and excluded rows are not counted', () => {
  assert.equal(bucketOf({ outcome: 'stop', manage_style: null }), null);
  assert.equal(bucketOf({ outcome: 'excluded', manage_style: 'be_on' }), null);
});
test('same-side entries minutes apart are one fire; the other side or a later entry is a new fire', () => {
  const t = clusterFires([
    row({ created_at: '2026-09-16T14:00:00Z' }), row({ created_at: '2026-09-16T14:04:00Z' }),
    row({ side: 'sell', created_at: '2026-09-16T14:02:00Z' }), row({ created_at: '2026-09-16T15:00:00Z' }),
  ]);
  const fires = new Set(t.map((x) => x.fire));
  assert.equal(fires.size, 3);
});
test('buckets tally real pips per account trade; open trades are not graded', () => {
  const r = buildRealResults([
    row({ manage_style: 'be_on', outcome: 'breakeven', result_pips: 12 }),
    row({ manage_style: 'be_off', outcome: 'stop', result_pips: -80 }),
    row({ manage_style: 'be_off', outcome: 'manual', result_pips: 30 }),
    row({ manage_style: 'play_out', outcome: 'target', result_pips: 150 }),
    row({ manage_style: 'be_on', outcome: null, result_pips: null }),
  ]);
  assert.equal(r.fires, 1);
  assert.equal(r.openTrades, 1);
  assert.deepEqual([r.buckets.be_on.trades, r.buckets.be_on.wins, r.buckets.be_on.netPips], [1, 1, 12]);
  assert.deepEqual([r.buckets.be_off.trades, r.buckets.be_off.losses, r.buckets.be_off.netPips], [1, 1, -80]);
  assert.deepEqual([r.buckets.self_manage.trades, r.buckets.self_manage.netPips], [1, 30]);
  assert.deepEqual([r.buckets.play_out.trades, r.buckets.play_out.winRate], [1, 100]);
  // The fire still has an open account, so it isn't in the desk summary yet.
  assert.equal(r.summary.trades, 0);
});
test('a zero-pip close is break-even, not a win or a loss', () => {
  const r = buildRealResults([row({ outcome: 'breakeven', result_pips: 0 })]);
  assert.deepEqual([r.buckets.be_on.wins, r.buckets.be_on.losses, r.buckets.be_on.breakeven, r.buckets.be_on.winRate], [0, 0, 1, null]);
});
