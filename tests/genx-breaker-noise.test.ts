import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLossEvents, noiseRoomFromBars, GOLD_NOISE_FALLBACK } from '../src/lib/flow/autoExec';
import { deskBreaker } from '../src/lib/genx/rangeGuard';

const T = (hhmm: string) => Date.parse(`2026-09-21T${hhmm}:00Z`);

test('09-21: the three stop-outs before the 01:05 sell pause the desk', () => {
  // genx_alerts losses at 23:25 (previous day), 00:45, 01:05 — the fourth sell went out at 01:05:47.
  const alerts = [Date.parse('2026-09-20T23:25:32Z'), T('00:45'), T('01:05')];
  const events = mergeLossEvents(alerts, []);
  const b = deskBreaker(events, Date.parse('2026-09-21T01:05:47Z'));
  assert.equal(b.paused, true);
  assert.equal(b.count, 3);
});

test('member stop-outs count even when the scanner has not written the signal loss yet', () => {
  const alerts = [Date.parse('2026-09-20T23:25:32Z'), T('00:45')];            // third not written yet
  const stops = Array.from({ length: 50 }, (_, i) => T('01:04') + i * 1000);  // 50 members stopped by one signal
  const events = mergeLossEvents(alerts, stops);
  assert.equal(events.length, 3, 'one fan-out collapses to one loss event');
  assert.equal(deskBreaker(events, T('01:06')).paused, true);
});

test('fifty members stopped by the same signal are ONE loss, not fifty', () => {
  const stops = Array.from({ length: 50 }, (_, i) => T('00:40') + i * 2000);
  assert.equal(mergeLossEvents([], stops).length, 1);
  assert.equal(deskBreaker(mergeLossEvents([], stops), T('00:45')).paused, false);
});

test('noise room follows the market: $5–9 candles give a stop well past $4', () => {
  const bars = [6.1, 5.2, 7.4, 8.9, 5.6, 6.3, 7.0, 5.1, 9.2, 6.6, 5.4, 7.8].map((r) => ({ h: 4370 + r, l: 4370 }));
  const room = noiseRoomFromBars(bars);
  assert.ok(room > 8 && room < 10, `room ${room}`);
});

test('a quiet market never goes below the $4 floor', () => {
  const bars = Array.from({ length: 12 }, () => ({ h: 4371, l: 4370 }));
  assert.equal(noiseRoomFromBars(bars), 4);
});

test('too few candles → the fallback, never the bare floor', () => {
  assert.equal(noiseRoomFromBars([{ h: 4372, l: 4370 }]), GOLD_NOISE_FALLBACK);
});
