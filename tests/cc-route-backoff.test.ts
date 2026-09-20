import test from 'node:test';
import assert from 'node:assert/strict';
import { routeKey } from '../command-center/adapters/tradelocker';

test('a 429 on orders history does not share a key with the positions read', () => {
  assert.equal(routeKey('get', '/trade/accounts/810219/positions'), 'GET /trade/accounts/:id/positions');
  assert.notEqual(routeKey('GET', '/trade/accounts/810219/ordersHistory'), routeKey('GET', '/trade/accounts/810219/positions'));
  assert.equal(routeKey('PATCH', '/trade/positions/72057594108380710?x=1'), 'PATCH /trade/positions/:id');
});
