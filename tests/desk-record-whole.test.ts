import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRealResults, type RealRow } from '../src/lib/genx/realResults';
import { allRows } from '../src/lib/floor/rows';

/*
 * THE DESK RECORD IS THE WHOLE RECORD (11-20).
 *
 * On 11-20 the record since the 10-20 reset held 3,439 gold account-trades. The route asked for
 * `.limit(20000)` and was handed the newest 1,000 — the API's ceiling, applied without a word — so the
 * page was counting from 11-03. And any GENX trade with one retired row was held open for ever. By the
 * route's own rules on that day's data: 99 trades as it was reading them; 267 read whole.
 */
const read = (p: string) => readFileSync(p, 'utf8');

test('the desk record is read a page at a time, in one fixed order, and never as a single capped request', () => {
  const src = read('src/app/api/flow/stats/route.ts');
  assert.match(src, /allRows<RealRow>\(/);
  assert.ok(!/\.limit\(\d+\)/.test(src), 'a limit above 1,000 is silently cut to 1,000');
  assert.match(src, /\.order\("created_at", \{ ascending: true \}\)\s*\.order\("id", \{ ascending: true \}\)/, 'oldest first: a trade opened mid-read cannot shift a row onto two pages');
  assert.match(src, /if \(!read\.complete\) return json\(\{ error: "load_failed"/, 'part of a record is not shown as the record');
  // Still gold, still from the reset, still nobody's personal clock.
  assert.match(src, /\.eq\("symbol", "XAUUSD"\)/);
  assert.match(src, /const since = statsSince\(\);[\s\S]*\.gte\("created_at", since\)/);
});

test('a retired row is dropped before the fold, so the rest of its trade is graded', () => {
  const src = read('src/app/api/flow/stats/route.ts');
  assert.match(src, /const rows = read\.rows\.filter\(\(r\) => r\.outcome !== "excluded"\);\s*const real = buildRealResults\(rows\);/);
  const row = (o: Partial<RealRow>): RealRow => ({ side: 'buy', outcome: 'target', result_pips: 90, created_at: '2026-11-05T14:00:00Z', resolved_at: '2026-11-05T15:00:00Z', manage_style: 'be_on', status: 'closed', ...o });
  const rows = [
    row({}), row({ created_at: '2026-11-05T14:01:00Z', result_pips: 70 }),
    row({ created_at: '2026-11-05T14:02:00Z', outcome: 'excluded', result_pips: null }),     // one account's row retired
    row({ side: 'sell', created_at: '2026-11-06T10:00:00Z', outcome: 'stop', result_pips: -40 }),
  ];
  const before = buildRealResults(rows).summary;
  assert.equal(before.trades, 1, 'folded as it was: the buy is held open by its retired row and only the loss counts');
  assert.equal(before.netPips, -40);
  const after = buildRealResults(rows.filter((r) => r.outcome !== 'excluded')).summary;
  assert.equal(after.trades, 2);
  assert.equal(after.wins, 1);
  assert.equal(after.losses, 1);
  assert.equal(after.netPips, 40, 'the buy is graded at the average of the two accounts that have a result');
  // A trade that really is open is still not graded.
  const open = buildRealResults([row({}), row({ created_at: '2026-11-05T14:01:00Z', outcome: null, result_pips: null, resolved_at: null, status: 'open' })].filter((r) => r.outcome !== 'excluded')).summary;
  assert.equal(open.trades, 0);
});

test('the GENX signal record is read whole too', () => {
  const src = read('src/app/api/genx-stats/route.ts');
  assert.match(src, /allRows<Sig>\(/);
  assert.ok(!/\.limit\(\d+\)/.test(src));
  assert.match(src, /\.order\("resolved_at", \{ ascending: false, nullsFirst: false \}\)\s*\.order\("id", \{ ascending: false \}\)/);
  assert.match(src, /if \(!read\.complete\) return json\(\{ error: "load_failed"/);
});

/* ── reading a whole record ── */
const pager = (total: number, failAt?: number) => {
  const calls: [number, number][] = [];
  const make = () => ({
    range: async (from: number, to: number) => {
      calls.push([from, to]);
      if (failAt != null && from >= failAt) return { data: null, error: { message: 'timeout' } };
      return { data: Array.from({ length: Math.max(0, Math.min(total, to + 1) - from) }, (_, i) => ({ n: from + i })), error: null };
    },
  });
  return { make, calls };
};

test('a record is read whole — a thousand rows at a time — not as its newest thousand', async () => {
  const p = pager(3439);
  const r = await allRows<{ n: number }>(p.make);
  assert.equal(r.complete, true);
  assert.equal(r.rows.length, 3439);
  assert.deepEqual(p.calls, [[0, 999], [1000, 1999], [2000, 2999], [3000, 3999]]);
  assert.equal(new Set(r.rows.map((x) => x.n)).size, 3439);
  const exact = await allRows(pager(2000).make);
  assert.equal(exact.rows.length, 2000);
  assert.equal(exact.complete, true, 'a full last page is followed by an empty one, which ends it');
  assert.equal((await allRows(pager(0).make)).complete, true);
});

test('a page that fails is said, not hidden — part of a record is not the record', async () => {
  const r = await allRows(pager(3439, 2000).make);
  assert.equal(r.complete, false);
  assert.equal(r.rows.length, 2000);
  const capped = await allRows(pager(50_000).make, 3);
  assert.equal(capped.complete, false, 'stopping at the page limit is also incomplete');
});
