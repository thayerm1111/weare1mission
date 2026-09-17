import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { laneFor } from '../src/lib/flow/tradelocker';

const H = 'https://live.tradelocker.com/backend-api';
test('orders for different broker accounts run in parallel lanes; one account stays single-file', () => {
  const lanes = new Set<string>();
  for (let i = 0; i < 200; i++) lanes.add(laneFor(H, 'POST', `/trade/accounts/${800000 + i}/orders`, `${800000 + i}|1|tok${i}`, i));
  assert.ok(lanes.size >= 6, `order writes spread over ${lanes.size} lanes`);
  const same = new Set([1, 2, 3, 4].map((rr) => laneFor(H, 'POST', '/trade/accounts/803349/orders', '803349|1|abc', rr)));
  assert.equal(same.size, 1, 'the same account always uses the same write lane');
});
test('token refreshes never queue behind orders; reads use their own lanes', () => {
  assert.match(laneFor(H, 'POST', '/auth/jwt/refresh', '', 3), /\|a\d$/);
  assert.match(laneFor(H, 'GET', '/trade/quotes?x', 'k', 3), /\|r\d$/);
  assert.match(laneFor(H, 'POST', '/trade/accounts/1/orders', 'k', 3), /\|w\d$/);
});
test('fan-out is wider and reuses a warm broker login; account settings are always re-read', () => {
  const ae = readFileSync('src/lib/flow/autoExec.ts', 'utf8');
  assert.ok(/const FANOUT_CONCURRENCY = 40;/.test(ae));
  assert.ok(/activeAccounts\(userId, \{ maxBrokerAgeMs: 90_000 \}\)/.test(ae));
  const cn = readFileSync('src/lib/flow/connection.ts', 'utf8');
  const fn = cn.slice(cn.indexOf('export async function activeAccounts'));
  assert.ok(fn.indexOf('.eq("autotrade_enabled", true)') < fn.indexOf('brokerCache.get(conn.id)'), 'enabled accounts are read from the DB before any cached broker data is used');
  assert.ok(/warmGoldFleet\(/.test(readFileSync('src/lib/genx/pdTick.ts', 'utf8')) && /warmGoldFleet\(/.test(readFileSync('src/lib/genx/watchTick.ts', 'utf8')));
});
