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
  assert.equal(nextRate(20, 'limited'), 14);
  assert.equal(nextRate(8, 'limited'), 8, 'never below the safety floor (manager keeps its throughput)');
  assert.equal(nextRate(14, 'clean'), 14.5);
  assert.equal(nextRate(24, 'clean'), 24, 'never above the ceiling');
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

test('manager exit price from the live stream is calibrated to the broker and stays on the conservative side', async () => {
  const { streamExitPrice } = await import('../src/lib/flow/flowManage');
  // broker bid 4350.10 / ask 4350.40 when stream printed 4350.00 → basis +0.25, spread 0.30
  assert.equal(+streamExitPrice('buy', 4350.00, 0.25, 0.30).toFixed(2), 4350.10, 'long exits at the bid');
  assert.equal(+streamExitPrice('sell', 4350.00, 0.25, 0.30).toFixed(2), 4350.40, 'short exits at the ask');
  assert.equal(+streamExitPrice('buy', 4352.00, 0.25, 0.30).toFixed(2), 4352.10, 'moves with the stream');
  const src = readFileSync('src/lib/flow/flowManage.ts', 'utf8');
  assert.ok(/QUOTE_CALIBRATE_MS = 20_000/.test(src) && /STREAM_MAX_AGE_MS = 1_500/.test(src), 'stale stream or calibration falls back to the broker quote');
});
