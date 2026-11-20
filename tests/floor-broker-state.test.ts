import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detailColumns, parseAccountState, figuresFromStored, brokerBusy, STATE_TTL_MS } from '../src/lib/floor/brokerState';
import { FIGURES_FRESH_MS } from '../src/lib/floor/overview';

/*
 * THE FLOOR's Balance and Equity (owner 11-20: "Show actual broker-reported values"; "Never continue to
 * label stale values as live"; "A customer's trading pause must never be confused…"). What is pinned here:
 * the broker's row is read by column name or not at all, only a dated reading is shown as current, a
 * display read steps aside for trading — and showing a number can never write to a table a trade reads.
 */
const NOW = Date.parse('2026-11-20T15:00:00Z');
const CONFIG = { s: 'ok', d: { accountDetailsConfig: { columns: [{ id: 'balance' }, { id: 'projectedBalance' }, { id: 'availableFunds' }, { id: 'openNetPnL' }, { id: 'positionsCount' }] } } };

test('the state row is read by the names the broker gives its columns', () => {
  const cols = detailColumns(CONFIG);
  assert.deepEqual(cols, ['balance', 'projectedBalance', 'availableFunds', 'openNetPnL', 'positionsCount']);
  const st = parseAccountState({ s: 'ok', d: { accountDetailsData: [10000, 10125.5, 9000, 125.5, 2] } }, cols);
  assert.deepEqual(st, { balance: 10000, equity: 10125.5, openPnl: 125.5, positions: 2 });
  // The same numbers in another order, on a broker build that orders them differently, are still read right.
  const other = ['positionsCount', 'openNetPnL', 'projectedBalance', 'balance'];
  assert.deepEqual(parseAccountState({ d: { accountDetailsData: [2, 125.5, 10125.5, 10000] } }, other), { balance: 10000, equity: 10125.5, openPnl: 125.5, positions: 2 });
});

test('a positional row with no column names is not read at all — a balance from the wrong position is worse than none', () => {
  assert.equal(parseAccountState({ d: { accountDetailsData: [10000, 10125.5, 9000, 125.5, 2] } }, []), null);
  assert.deepEqual(detailColumns({ d: {} }), []);
  assert.deepEqual(detailColumns(null), []);
});

test('a missing figure stays missing; it never becomes zero', () => {
  const st = parseAccountState({ d: { accountDetailsData: [10000, null, 0, '', 'x'] } }, ['balance', 'projectedBalance', 'availableFunds', 'openNetPnL', 'positionsCount'])!;
  assert.equal(st.balance, 10000);
  assert.equal(st.equity, null);
  assert.equal(st.openPnl, null);
  assert.equal(st.positions, null);
  assert.equal(parseAccountState({ d: { accountDetailsData: [null, null] } }, ['balance', 'projectedBalance']), null, 'neither balance nor equity: nothing to show');
  assert.equal(parseAccountState(null, ['balance']), null);
});

test('a broker that answers with named fields is read by those names', () => {
  assert.deepEqual(parseAccountState({ d: { balance: '2500.25', equity: 2490, openGrossPnL: -10.25, positionsCount: 1.0 } }, []), { balance: 2500.25, equity: 2490, openPnl: -10.25, positions: 1 });
});

test('only a dated reading is current, and only for a few minutes', () => {
  const iso = (ago: number) => new Date(NOW - ago).toISOString();
  const fresh = figuresFromStored({ balance: '10000', equity: 10125, open_pl: 125, positions: 2, read_at: iso(30_000) }, [{ balance: 9000 }], NOW);
  assert.equal(fresh.state, 'live');
  assert.equal(fresh.balance, 10000, 'the reading wins over the balance kept from the day of connection');
  assert.equal(fresh.equity, 10125);
  assert.equal(fresh.note, null);
  const old = figuresFromStored({ balance: 10000, equity: 10125, open_pl: 125, positions: 2, read_at: iso(FIGURES_FRESH_MS + 60_000) }, [], NOW);
  assert.equal(old.state, 'last_known');
  assert.equal(old.at, iso(FIGURES_FRESH_MS + 60_000), 'shown with its age');
  assert.ok(old.note);
});

test('before any reading, the connection-day balance is offered as an earlier balance — with no equity and no date', () => {
  const f = figuresFromStored(null, [{ balance: null }, { balance: '5000' }], NOW);
  assert.equal(f.state, 'last_known');
  assert.equal(f.balance, 5000);
  assert.equal(f.equity, null);
  assert.equal(f.openPnl, null);
  assert.equal(f.at, null);
  assert.match(String(f.note), /earlier balance/i);
  const none = figuresFromStored(null, [{ balance: null }], NOW);
  assert.equal(none.state, 'unavailable');
  assert.equal(none.balance, null);
  // A stored reading with no numbers in it is not a reading.
  assert.equal(figuresFromStored({ balance: null, equity: null, read_at: new Date(NOW).toISOString() }, [], NOW).state, 'unavailable');
});

test('a display read steps aside while an order or a login is waiting', () => {
  assert.equal(brokerBusy({}), false);
  assert.equal(brokerBusy({ live: { queued: [0, 0, 4, 9] } }), false, 'ordinary and background reads do not block it');
  assert.equal(brokerBusy({ live: { queued: [1, 0, 0, 0] } }), true, 'an order is waiting');
  assert.equal(brokerBusy({ demo: { queued: [0, 0, 0, 0] }, live: { queued: [0, 2, 0, 0] } }), true, 'a login is waiting');
  assert.ok(STATE_TTL_MS < FIGURES_FRESH_MS, 'a reading kept in memory is still inside the freshness window');
});

test('SHOWING A NUMBER CANNOT CHANGE A TRADE: the service never writes the accounts table, and reads the broker at background priority', () => {
  const src = readFileSync('src/lib/floor/accountState.ts', 'utf8');
  // Every write in the file goes to the readings table.
  const writes = [...src.matchAll(/\.from\("([a-z_]+)"\)\s*\.(update|upsert|insert|delete)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(writes)], ['floor_account_state']);
  assert.ok(!/from\("flow_broker_accounts"\)[^;]*\.(update|upsert|insert|delete)\(/.test(src));
  assert.ok(!/from\("flow_broker_connections"\)[^;]*\.(update|upsert|insert|delete)\(/.test(src));
  // The member's own rows only.
  assert.match(src, /from\("flow_broker_accounts"\)\.select\([^)]*\)\.eq\("user_id", userId\)\.eq\("account_id", account\.id\)/);
  assert.match(src, /from\("flow_broker_connections"\)\.select\("id, status"\)\.eq\("user_id", userId\)/);
  // Behind every order and stop, and not at all while one is waiting or the login is known to be broken.
  assert.match(src, /withBrokerPriority\("background"/);
  assert.ok(src.indexOf('brokerBusy(brokerRateStats())') > 0 && src.indexOf('brokerBusy(brokerRateStats())') < src.indexOf('connectionToken('), 'the busy check comes before any broker call');
  assert.match(src, /c\.status === "connected"/);
  // Nothing in it places, modifies or closes anything.
  assert.ok(!/placeOrder|modifyPosition|closePosition|setStop|cancelOrder/i.test(src));
  const tl = readFileSync('src/lib/flow/tradelocker.ts', 'utf8');
  const fn = tl.slice(tl.indexOf('export async function getAccountState'), tl.indexOf('/** GET /trade/accounts/{accountId}/instruments'));
  assert.match(fn, /method: "GET"/);
  assert.ok(!/POST|PATCH|DELETE|PUT/.test(fn));
});

test('the readings table is additive, server-only and reversible', () => {
  const up = readFileSync('supabase/migrations/20261120150000_floor_account_state.sql', 'utf8');
  const down = readFileSync('supabase/migrations/20261120150000_floor_account_state_down.sql', 'utf8');
  assert.match(up, /create table if not exists public\.floor_account_state/);
  assert.match(up, /enable row level security/);
  assert.ok(!/create policy/i.test(up), 'no policies: the service role only');
  assert.ok(!/alter table public\.flow_/i.test(up), 'it touches no table a trade reads');
  assert.match(up, /primary key \(user_id, environment, account_id\)/);
  assert.match(down, /drop table if exists public\.floor_account_state/);
  assert.ok(!/drop table if exists public\.(?!floor_account_state)/.test(down));
});
