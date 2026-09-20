import test from 'node:test';
import assert from 'node:assert/strict';
import { closeFillFromHistory } from '../command-center/adapters/tradelocker';

const cfg = { d: { ordersHistoryConfig: { columns: ['id','tradableInstrumentId','routeId','qty','side','type','status','filledQty','avgPrice','price','stopPrice','validity','expireDate','createdDate','lastModified','isOCO','stopLoss','stopLossType','takeProfit','takeProfitType','strategyId','positionId'].map((id) => ({ id })) } } };
const row = (o: Record<string, unknown>) => ['o1','1','541039','14.23',o.side,'stop',o.status,'14.23',o.avg,'0','4376.38','GTC',null,'1789947557000',o.at,'false',null,null,null,null,null,o.pos];

test('the closing stop fill of a sell is read from columnar history', () => {
  const body = { d: { ordersHistory: [
    row({ side: 'sell', status: 'Filled', avg: '4374.56', at: '1789947174000', pos: '72057594048066858' }),
    row({ side: 'buy', status: 'Filled', avg: '4376.53', at: '1789947557000', pos: '72057594048066858' }),
    row({ side: 'buy', status: 'Filled', avg: '4300.00', at: '1789947999000', pos: 'someone-else' }),
  ] } };
  assert.deepEqual(closeFillFromHistory(body, cfg, '72057594048066858', 'sell'), { price: 4376.53, at: 1789947557000 });
});

test('object rows work too, and nothing found is null', () => {
  const body = { d: { ordersHistory: [{ positionId: 'p9', side: 'sell', status: 'Filled', avgPrice: 4390.1, lastModified: 5 }] } };
  assert.equal(closeFillFromHistory(body, null, 'p9', 'buy')?.price, 4390.1);
  assert.equal(closeFillFromHistory(body, null, 'p0', 'buy'), null);
  assert.equal(closeFillFromHistory({ d: { ordersHistory: [{ positionId: 'p9', side: 'sell', status: 'Cancelled', avgPrice: 1 }] } }, null, 'p9', 'buy'), null);
});
