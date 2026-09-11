import test from 'node:test';
import assert from 'node:assert/strict';
import { partialOnce, type PartialIntent, type PartialStore } from '../src/lib/flow/partialOperation';
import { columnMap, protectiveStop, positionForOrder } from '../src/lib/flow/brokerEvidence';
import { readCollection, createOrder } from '../src/lib/flow/tradelocker';

function store(): PartialStore {
  let saved: PartialIntent | undefined;
  return { async reserve(intent) {
    const created = !saved;
    saved ??= structuredClone(intent);
    return { created, intent: saved };
  } };
}
const intent = { before_qty: 1, requested_qty: 0.25 };

test('delayed partial is dispatched once across concurrent passes', async () => {
  const db = store(); let requests = 0;
  const send = async () => { requests++; return { ok: true }; };
  const results = await Promise.all(Array.from({ length: 20 }, () => partialOnce(db, intent, send, async () => 1)));
  assert.equal(requests, 1); assert.ok(results.every(r => r.state === 'pending'));
  assert.deepEqual(await partialOnce(db, intent, send, async () => .75), { state: 'confirmed', remaining: .75 });
  assert.equal(requests, 1);
});
test('broker timeout retains reservation after restart', async () => {
  const db = store(); let requests = 0;
  await partialOnce(db, intent, async () => { requests++; throw Error('timeout'); }, async () => null);
  await partialOnce(db, intent, async () => { requests++; return { ok: true }; }, async () => 1);
  assert.equal(requests, 1);
});
test('crash after reservation before dispatch does not cause speculative redispatch', async () => {
  const db = store(); await db.reserve(intent); let requests = 0;
  const result = await partialOnce(db, intent, async () => { requests++; return { ok: true }; }, async () => 1);
  assert.equal(result.state, 'pending'); assert.equal(requests, 0);
});
test('database outage prevents broker close', async () => {
  let requests = 0;
  await assert.rejects(partialOnce({ async reserve() { throw Error('database unavailable'); } }, intent,
    async () => { requests++; return { ok: true }; }, async () => 1));
  assert.equal(requests, 0);
});
test('unreadable and partially filled quantity do not invent a completed partial', async () => {
  for (const qty of [null, NaN, 1, .9]) {
    const result = await partialOnce(store(), intent, async () => ({ ok: true }), async () => qty);
    assert.equal(result.state, 'pending');
  }
});
test('explicit rejection also remains reserved pending broker reconciliation', async () => {
  const db = store(); let requests = 0;
  for (let i = 0; i < 2; i++) await partialOnce(db, intent, async () => { requests++; return { ok: false, error: 'rejected' }; }, async () => 1);
  assert.equal(requests, 1);
});
test('full close and invalid quantities are never dispatched as a partial', async () => {
  for (const qty of [0, -1, 1, 2, NaN]) await assert.rejects(partialOnce(store(), { ...intent, requested_qty: qty }, async () => { throw Error('must not send'); }, async () => null), /invalid_partial_quantity/);
});
test('error or malformed collection is not an empty broker account', () => {
  for (const data of [null, {}, { s: 'error', d: { positions: [] } }, '<html>']) assert.equal(readCollection(data, 'positions').ok, false);
  assert.deepEqual(readCollection({ s: 'ok', d: { positions: [] } }, 'positions'), { ok: true, data: [] });
});
test('stop proof requires exact position, active order, and one unambiguous stop', () => {
  const stop = { positionId: '123', type: 'stop', status: 'Working', stopPrice: 2400 };
  assert.equal(protectiveStop([stop], undefined, '123'), 2400);
  assert.equal(protectiveStop([stop], undefined, 'other'), null);
  assert.equal(protectiveStop([{ ...stop, status: 'Canceled' }], undefined, '123'), null);
  assert.equal(protectiveStop([stop, { ...stop, stopPrice: 2390 }], undefined, '123'), null);
  assert.equal(protectiveStop([], undefined, '123'), null);
});
test('config column positions can differ and order correlation must be exact', () => {
  const config = { d: { ordersConfig: { columns: [{ id: 'positionId' }, { id: 'id' }] } } };
  const cols = columnMap(config, 'ordersConfig');
  assert.equal(positionForOrder([['old', 'old-order'], ['right', 'new-order']], cols, 'new-order'), 'right');
  assert.equal(positionForOrder([['old', 'old-order']], cols, 'new-order'), null);
  assert.equal(positionForOrder([['a', 'new-order'], ['b', 'new-order']], cols, 'new-order'), null);
});
test('missing order ID and HTTP 500 have uncertain outcomes, explicit rejection does not', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, body, uncertain] of [[200, { s: 'ok', d: {} }, true], [500, {}, true], [200, { s: 'error', errmsg: 'rejected' }, false]] as const) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status });
      const r = await createOrder('demo', 'test-token', { accountId: 'a', accNum: '1', tradableInstrumentId: 'i', routeId: 'r', side: 'buy', type: 'market', qty: .01, validity: 'IOC' });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.uncertain === true, uncertain);
    }
  } finally { globalThis.fetch = original; }
});

import { executablePrice, bracketStillValid } from '../src/lib/flow/executionQuote';
test('entry and exit use the correct executable side; no opposite-side fallback', () => {
  const q = { bid: 2400, ask: 2401 };
  assert.equal(executablePrice(q, 'buy', 'entry'), 2401);
  assert.equal(executablePrice(q, 'sell', 'entry'), 2400);
  assert.equal(executablePrice(q, 'buy', 'exit'), 2400);
  assert.equal(executablePrice(q, 'sell', 'exit'), 2401);
  assert.equal(executablePrice({ bid: null, ask: 2401 }, 'buy', 'exit'), null);
  assert.equal(executablePrice({ bid: 2402, ask: 2401 }, 'buy', 'entry'), null);
});
test('entry check preserves structural levels and rejects a price beyond either bracket', () => {
  assert.equal(bracketStillValid('buy', 2400, 2390, 2420), true);
  assert.equal(bracketStillValid('buy', 2389, 2390, 2420), false);
  assert.equal(bracketStillValid('buy', 2421, 2390, 2420), false);
  assert.equal(bracketStillValid('sell', 2400, 2410, 2380), true);
  assert.equal(bracketStillValid('sell', 2379, 2410, 2380), false);
});

import { autoSourceEnabled, SEND_IT_ENABLED } from '../src/lib/flow/automationPolicy';
test('only GENX automated entries are enabled and Send It bypass is retired', () => {
  assert.equal(autoSourceEnabled('genx'), true);
  assert.equal(autoSourceEnabled('flow'), false);
  assert.equal(autoSourceEnabled('matty'), false);
  assert.equal(SEND_IT_ENABLED, false);
});
