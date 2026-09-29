import test from 'node:test';
import assert from 'node:assert/strict';
import { setupLabel, gradeOf } from '../src/lib/genx/liveTrade';

test('grades never say loss', () => {
  assert.equal(gradeOf(42), 'WIN');
  assert.equal(gradeOf(-30), 'LESSON');
  assert.equal(gradeOf(0), 'BREAKEVEN');
  assert.equal(gradeOf(null), 'BREAKEVEN');
});
test('setup labels', () => {
  assert.equal(setupLabel('pd:G1:2026-09-17:PDH:buy'), 'PDH Breakout · Retest');
  assert.equal(setupLabel('pd:G1:2026-09-17:PDL:sell'), 'PDL Breakdown · Retest');
  assert.equal(setupLabel(null), 'GENX Entry');
});

/**
 * A RETIRED ROW IS NOT A LIVE TRADE (owner 09-29). Khai's card said "Your account is in this trade —
 * in trade 30h" with no entry, stop or target while every position on his broker was closed. The one
 * row behind it had been retired with outcome 'excluded' (the broker stopped listing the position
 * before the manager booked a result), and the results fold counts an excluded row as still open.
 * The member card now drops retired rows before the fold and shows "live" only over a row the
 * ledger still holds OPEN.
 */
import { buildRealResults } from '../src/lib/genx/realResults';
import { readFileSync } from 'node:fs';

const row = (over: Partial<import('../src/lib/genx/realResults').RealRow>) => ({
  side: 'sell', outcome: 'breakeven', result_pips: 14, created_at: '2026-09-28T17:13:33Z', resolved_at: '2026-09-28T17:15:35Z', manage_style: 'be_on', status: 'closed', ...over,
});

test("a retired ('excluded') row is what the fold mistakes for an open trade — the card must drop it first", () => {
  const khai = [
    row({}),
    row({ outcome: 'excluded', result_pips: null, created_at: '2026-09-28T17:22:44Z', resolved_at: '2026-09-28T17:40:29Z' }),
  ];
  assert.ok(buildRealResults(khai).recentFiresAll.some((f) => f.open > 0), 'the shared fold still counts the retired row as open (the desk record is untouched)');
  const shown = khai.filter((r) => r.outcome !== 'excluded');
  assert.equal(buildRealResults(shown).recentFiresAll.some((f) => f.open > 0), false, 'with retired rows dropped, nothing is live');
  assert.equal(buildRealResults(shown).recentFiresAll.filter((f) => f.open === 0 && f.avgPips != null).length, 1, 'the real closed trade still grades');
});

test('the member card shows a live trade only over a row the ledger still holds open', () => {
  const src = readFileSync('src/app/api/floor/live-trade/route.ts', 'utf8');
  assert.ok(/\.filter\(\(r\) => r\.outcome !== "excluded"\)/.test(src), 'retired rows are dropped before the fold');
  assert.ok(/if \(liveFire && liveOpenRows\.length\)/.test(src), 'no open row → no live card');
});
