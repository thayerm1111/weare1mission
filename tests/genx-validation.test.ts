import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyTransport } from '../src/lib/flow/validation';
test('validation blocks writes, foreign accounts, auth routes, and other hosts', async () => {
  let sent = 0;
  const transport = readOnlyTransport({ environment: 'live', accountId: 'fixture' }, async () => { sent++; return new Response('{}'); });
  for (const [url, method] of [
    ['https://live.tradelocker.com/backend-api/trade/accounts/fixture/orders', 'POST'],
    ['https://live.tradelocker.com/backend-api/trade/accounts/other/positions', 'GET'],
    ['https://demo.tradelocker.com/backend-api/trade/config', 'GET'],
    ['https://live.tradelocker.com/backend-api/auth/jwt/refresh', 'POST'],
    ['https://live.tradelocker.com/backend-api/trade/positions/p', 'DELETE'],
  ]) await assert.rejects(transport(url, { method }), /out_of_scope/);
  assert.equal(sent, 0);
});
test('validation allows scoped reads and rejects redirects', async () => {
  let mode: RequestRedirect | undefined;
  const transport = readOnlyTransport({ environment: 'live', accountId: 'fixture' }, async (_, init) => { mode = init?.redirect; return new Response('{}'); });
  await transport('https://live.tradelocker.com/backend-api/trade/accounts/fixture/positions');
  assert.equal(mode, 'error');
});

import { protectiveStop } from '../src/lib/flow/brokerEvidence';
test('broker stopLossId resolves an order even without its positionId and rejects conflicting links', () => {
  const order = { id: 'stop-1', type: 'stop', status: 'New', stopPrice: 2400 };
  assert.equal(protectiveStop([order], undefined, 'position-1', 'stop-1'), 2400);
  assert.equal(protectiveStop([order], undefined, 'position-1', 'stop-other'), null);
  assert.equal(protectiveStop([{ ...order, positionId: 'other' }], undefined, 'position-1', 'stop-1'), null);
});
test('diagnostic suppresses retries before they reach the broker', async () => {
  let sent = 0;
  const transport = readOnlyTransport({ environment: 'live', accountId: 'fixture' }, async () => { sent++; return new Response('{}'); });
  const url = 'https://live.tradelocker.com/backend-api/trade/config';
  await transport(url);
  await assert.rejects(transport(url), /retry_suppressed/);
  assert.equal(sent, 1);
});
