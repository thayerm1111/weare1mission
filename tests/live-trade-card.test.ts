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
