import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiveSince, DEFAULT_STATS_SINCE } from '../src/lib/genx/statsSince';

/**
 * A MEMBER'S OWN RESET POINT (owner 09-29: "reset these stats — I need to reconnect new accounts and I
 * want fresh stats"). The community clock (FLOOR_STATS_SINCE) still applies to everyone; a member's
 * own clock only ever moves THEIR window later, never earlier, and only their member-facing views read it.
 */
test('no personal reset → the community clock', () => {
  assert.equal(effectiveSince(DEFAULT_STATS_SINCE, null), DEFAULT_STATS_SINCE);
});

test('a personal reset after the community clock wins', () => {
  assert.equal(effectiveSince('2026-09-20T22:00:00Z', '2026-09-30T01:40:00Z'), '2026-09-30T01:40:00Z');
});

test('a personal reset BEFORE the community clock cannot pull old trades back in', () => {
  assert.equal(effectiveSince('2026-09-20T22:00:00Z', '2026-09-01T00:00:00Z'), '2026-09-20T22:00:00Z');
});

test('only the member-facing views read the member clock; the desk record and the GENX card do not', () => {
  const live = readFileSync('src/app/api/floor/live-trade/route.ts', 'utf8');
  assert.ok(/effectiveSince\(communitySince, await memberStatsSince\(admin, user\.id\)\)/.test(live), 'live trade card');
  const mine = readFileSync('src/app/api/admin/my-results/route.ts', 'utf8');
  assert.ok(/memberStatsSince\(admin, OWNER_USER_ID\)/.test(mine) && /q\.gte\("created_at", mine\)/.test(mine), 'owner results view');
  for (const f of ['src/app/api/flow/stats/route.ts', 'src/lib/genx/realResults.ts']) {
    assert.ok(!/memberStatsSince/.test(readFileSync(f, 'utf8')), `${f} untouched`);
  }
  const sql = readFileSync('supabase/migrations/20260930013000_member_stats_since.sql', 'utf8');
  assert.ok(/add column if not exists stats_since timestamptz/.test(sql));
});
