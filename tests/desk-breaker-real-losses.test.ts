import test from 'node:test';
import assert from 'node:assert/strict';
import { lossEventsByTrade, type StopRow } from '../src/lib/flow/autoExec';
import { deskBreaker, BREAKER_LOSSES } from '../src/lib/genx/rangeGuard';

/**
 * THE DESK BREAKER COUNTS REAL TRADES, NOT ROWS (owner 09-24: "when they are actual loses. Check the
 * broker and see if it hit stop loss").
 *
 * The incident these pin down: on 2026-09-23 the breaker reported "4 stop-outs in the last six hours"
 * and blocked three GENX sells. The broker record for that window held exactly ONE losing trade — a
 * sell with init_stop 4293.94 that closed on one member's account at 22:06 and another's at 00:56.
 * Two things had inflated it: paper `genx_alerts` outcomes counted as losses, and a 10-minute time
 * bucket split one staggered fan-out into several events.
 */

const at = (iso: string, stop: number | null, side = 'sell'): StopRow =>
  ({ side, init_stop: stop, resolved_at: iso });

test('one fan-out is one loss, however many members took it', () => {
  const rows = [
    at('2026-09-23T22:06:15Z', 4293.94),
    at('2026-09-23T22:06:26Z', 4293.94),
    at('2026-09-24T00:56:06Z', 4293.94),
  ];
  assert.equal(lossEventsByTrade(rows).length, 1);
});

test('the 09-23 window produces ONE loss, so the desk is not paused', () => {
  // The regression test for the actual incident. Four was the old answer; one is the true one.
  const rows = [
    at('2026-09-23T22:06:15Z', 4293.94),
    at('2026-09-23T22:06:26Z', 4293.94),
    at('2026-09-24T00:56:06Z', 4293.94),
  ];
  const events = lossEventsByTrade(rows);
  const b = deskBreaker(events, Date.parse('2026-09-24T01:46:00Z'));
  assert.equal(b.count, 1);
  assert.equal(b.paused, false, 'one real losing trade must never pause the desk');
});

test('members stopping out hours apart on the SAME trade still count once', () => {
  // This is what the old 10-minute bucket got wrong: 2h50m apart, one trade.
  const rows = [at('2026-09-23T22:06:15Z', 4293.94), at('2026-09-24T00:56:06Z', 4293.94)];
  assert.equal(lossEventsByTrade(rows).length, 1);
});

test('genuinely different trades still count separately', () => {
  // The breaker must not be blunted into uselessness — distinct stops are distinct bets.
  const rows = [
    at('2026-09-24T01:20:00Z', 4303.93),
    at('2026-09-24T01:15:32Z', 4301.94),
    at('2026-09-24T01:00:00Z', 4296.92),
  ];
  const events = lossEventsByTrade(rows);
  assert.equal(events.length, 3);
  const b = deskBreaker(events, Date.parse('2026-09-24T01:46:00Z'));
  assert.equal(b.count, 3);
  assert.equal(b.paused, true, 'three separate losing trades SHOULD still pause the desk');
});

test('the newest close represents the trade, so the cool-off runs from the latest loss', () => {
  const rows = [at('2026-09-23T22:06:15Z', 4293.94), at('2026-09-24T00:56:06Z', 4293.94)];
  assert.equal(lossEventsByTrade(rows)[0], Date.parse('2026-09-24T00:56:06Z'));
});

test('a buy and a sell that happen to share a stop price are different trades', () => {
  const rows = [at('2026-09-24T01:00:00Z', 4300, 'sell'), at('2026-09-24T01:01:00Z', 4300, 'buy')];
  assert.equal(lossEventsByTrade(rows).length, 2);
});

test('rows with no init_stop are still counted, via the time bucket', () => {
  // Never silently drop a real loss just because the ledger row is incomplete.
  const rows = [at('2026-09-24T01:00:00Z', null), at('2026-09-24T00:30:00Z', null)];
  assert.equal(lossEventsByTrade(rows).length, 2);
});

test('an unparseable timestamp is ignored rather than counted as a loss at epoch 0', () => {
  const rows = [at('not-a-date', 4293.94), at('2026-09-24T01:00:00Z', 4290.00)];
  assert.equal(lossEventsByTrade(rows).length, 1);
});

test('no losses at all means no pause', () => {
  const b = deskBreaker(lossEventsByTrade([]), Date.now());
  assert.equal(b.paused, false);
  assert.equal(b.count, 0);
});

test('the threshold is still three', () => {
  assert.equal(BREAKER_LOSSES, 3);
});
