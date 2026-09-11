import test from 'node:test';
import assert from 'node:assert/strict';
import { readProtectiveStop } from '../src/lib/flow/brokerEvidence';
import { modifyPosition, closePosition, listPositions } from '../src/lib/flow/tradelocker';
import { partialOnce, type PartialIntent } from '../src/lib/flow/partialOperation';

// Column names/order captured by the read-only diagnostic; all IDs and prices below
// are synthetic. No credential or customer trade is included in these fixtures.
const positionsColumns = ['id','tradableInstrumentId','routeId','side','qty','avgPrice','stopLossId','takeProfitId','openDate','unrealizedPl','strategyId'];
const ordersColumns = ['id','tradableInstrumentId','routeId','qty','side','type','status','filledQty','avgPrice','price','stopPrice','validity','expireDate','createdDate','lastModified','isOpen','positionId','stopLoss','stopLossType','takeProfit','takeProfitType','strategyId'];
const config = { s: 'ok', d: { positionsConfig: { columns: positionsColumns.map(id => ({ id })) }, ordersConfig: { columns: ordersColumns.map(id => ({ id })) } } };
function row(cols: string[], values: Record<string, unknown>) { return cols.map(k => values[k] ?? null); }
function json(data: unknown) { return new Response(JSON.stringify(data), { status: 200 }); }
function sandboxBroker(options: { stop?: number; ordersError?: boolean; missingPosition?: boolean } = {}) {
  let stop = options.stop ?? 2390;
  let quantity = 1;
  const writes: { method: string; body: unknown }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      assert.match(path, /\/trade\/positions\/synthetic-position$/);
      writes.push({ method, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 }); // ack only: state does not change until settle()
    }
    if (path.endsWith('/config')) return json(config);
    if (path.endsWith('/positions')) return json({ s: 'ok', d: { positions: options.missingPosition ? [] : [row(positionsColumns, { id: 'synthetic-position', qty: quantity, side: 'buy', avgPrice: 2400, stopLossId: 'synthetic-stop' })] } });
    if (path.endsWith('/orders')) return options.ordersError ? json({ s: 'error', errmsg: 'fixture unavailable' }) : json({ s: 'ok', d: { orders: [row(ordersColumns, { id: 'synthetic-stop', type: 'stop', status: 'New', stopPrice: stop, isOpen: true })] } });
    throw Error('unexpected_fixture_request');
  };
  return { transport, writes, settleStop(value: number) { stop = value; }, settleQuantity(value: number) { quantity = value; } };
}

test('BE and trailing acknowledgements require linked broker stop settlement', async () => {
  const original = globalThis.fetch; const broker = sandboxBroker(); globalThis.fetch = broker.transport;
  try {
    const args = ['demo', 'fixture-token', '3', 'fixture-be', 'synthetic-position'] as const;
    assert.equal((await modifyPosition('demo', 'fixture-token', '3', 'synthetic-position', { stopLoss: 2402 })).ok, true);
    assert.equal(await readProtectiveStop(...args), 2390); // acknowledged != applied
    broker.settleStop(2402);
    assert.equal(await readProtectiveStop(...args), 2402);
    await modifyPosition('demo', 'fixture-token', '3', 'synthetic-position', { stopLoss: 2406 });
    assert.equal(await readProtectiveStop(...args), 2402);
    broker.settleStop(2406);
    assert.equal(await readProtectiveStop(...args), 2406);
    assert.deepEqual(broker.writes, [{ method: 'PATCH', body: { stopLoss: 2402 } }, { method: 'PATCH', body: { stopLoss: 2406 } }]);
  } finally { globalThis.fetch = original; }
});

test('unreadable linked orders cannot become confirmed protection', async () => {
  const original = globalThis.fetch; globalThis.fetch = sandboxBroker({ ordersError: true }).transport;
  try { assert.equal(await readProtectiveStop('demo', 'fixture-token', '3', 'fixture-error', 'synthetic-position'), null); }
  finally { globalThis.fetch = original; }
});

test('closed or absent position cannot become confirmed protection', async () => {
  const original = globalThis.fetch; globalThis.fetch = sandboxBroker({ missingPosition: true }).transport;
  try { assert.equal(await readProtectiveStop('demo', 'fixture-token', '3', 'fixture-gone', 'synthetic-position'), null); }
  finally { globalThis.fetch = original; }
});

test('partial HTTP acknowledgement stays pending through multiple passes until broker quantity settles', async () => {
  const original = globalThis.fetch; const broker = sandboxBroker(); globalThis.fetch = broker.transport;
  let reservation: PartialIntent | undefined;
  const store = { async reserve(intent: PartialIntent) { const created = !reservation; reservation ??= { ...intent }; return { created, intent: reservation }; } };
  const send = () => closePosition('demo', 'fixture-token', '3', 'synthetic-position', .25);
  const read = async () => { const r = await listPositions('demo', 'fixture-token', '3', 'fixture-partial'); return r.ok ? Number((r.data[0] as unknown[])[4]) : null; };
  const run = () => partialOnce(store, { before_qty: 1, requested_qty: .25 }, send, read);
  try {
    assert.equal((await run()).state, 'pending');
    assert.equal((await run()).state, 'pending');
    broker.settleQuantity(.9); // closing order only partly filled
    assert.equal((await run()).state, 'pending');
    broker.settleQuantity(.75);
    assert.deepEqual(await run(), { state: 'confirmed', remaining: .75 });
    assert.deepEqual(broker.writes, [{ method: 'DELETE', body: { qty: .25 } }]);
  } finally { globalThis.fetch = original; }
});
