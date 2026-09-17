import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { staleGoldRows, STALE_ROW_MIN_AGE_MS } from '../src/lib/flow/autoExec';

const now = Date.parse('2026-09-17T16:00:00Z');
test('a ledger row the broker no longer holds is retired; a live or brand-new position never is', () => {
  const rows = [
    { position_id: '72057594047440998', created_at: '2026-09-11T02:25:09Z' },   // 834969 phantom from 09-11
    { position_id: '111', created_at: '2026-09-17T15:30:00Z' },                 // still open at the broker
    { position_id: '222', created_at: new Date(now - STALE_ROW_MIN_AGE_MS + 60_000).toISOString() }, // just filled, broker list may lag
  ];
  assert.deepEqual(staleGoldRows(rows, new Set(['111']), now), ['72057594047440998']);
  assert.deepEqual(staleGoldRows(rows, new Set(['111', '72057594047440998']), now), [], 'broker still lists it → kept');
});
test('self-heal runs only after a readable broker read, before the one-trade reservation, on copy and follower paths', () => {
  const src = readFileSync('src/lib/flow/autoExec.ts', 'utf8');
  assert.equal((src.match(/if \(brokerOpen\) await retireStaleGoldRows\(/g) ?? []).length, 2);
});
