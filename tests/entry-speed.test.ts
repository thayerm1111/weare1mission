import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { priorityFor, nextRate } from '../src/lib/flow/tradelocker';

test('broker priority: orders and position protection first, then logins, reads, background warm-up', () => {
  assert.equal(priorityFor('POST', '/trade/accounts/803349/orders'), 0, 'order placement is critical');
  assert.equal(priorityFor('PATCH', '/trade/positions/123'), 0, 'break-even / SL modify is critical');
  assert.equal(priorityFor('DELETE', '/trade/positions/123'), 0, 'close is critical');
  assert.equal(priorityFor('POST', '/auth/jwt/refresh'), 1);
  assert.equal(priorityFor('GET', '/trade/accounts/1/positions'), 2, 'routine reads are normal');
  assert.equal(priorityFor('GET', '/trade/quotes?x', 'critical'), 0, 'reads inside an entry fan-out are critical');
  assert.equal(priorityFor('GET', '/auth/jwt/all-accounts', 'background'), 3, 'warm-up is background');
  assert.equal(priorityFor('POST', '/trade/accounts/1/orders', 'background'), 3);
});
test('adaptive request budget: a rate-limit cuts 30%, a clean stretch creeps back, within bounds', () => {
  assert.equal(nextRate(10, 'limited'), 7);
  assert.equal(nextRate(2, 'limited'), 2, 'never below the floor');
  assert.equal(nextRate(7, 'clean'), 7.5);
  assert.equal(nextRate(12, 'clean'), 12, 'never above the ceiling');
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
