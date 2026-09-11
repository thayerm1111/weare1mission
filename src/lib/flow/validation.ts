import { columnMap, field, protectiveStop, positionForOrder } from './brokerEvidence';
import { executablePrice } from './executionQuote';
import { getConfig, listPositions, listOrders, listOrdersHistory, listInstruments, getQuote, type TLEnv } from './tradelocker';

export type ValidationInput = { accountId: string; accNum: string; environment: TLEnv; token: string };
/** Transport-level guard: even an accidental call to an execution helper cannot write.
 * The account/route scope is immutable for the lifetime of this one-shot process. */
export function readOnlyTransport(scope: Pick<ValidationInput, 'accountId' | 'environment'>, transport: typeof fetch): typeof fetch {
  const host = `https://${scope.environment}.tradelocker.com`;
  const accountPath = `/backend-api/trade/accounts/${encodeURIComponent(scope.accountId)}/`;
  const requested = new Set<string>();
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = url.pathname;
    const allowed = ['/backend-api/trade/config', '/backend-api/trade/quotes'].includes(path)
      || ['positions', 'orders', 'ordersHistory', 'instruments'].some(name => path === accountPath + name);
    if (method !== 'GET' || url.origin !== host || !allowed) throw Error('validation_request_out_of_scope');
    if (requested.has(url.href)) throw Error('validation_retry_suppressed');
    requested.add(url.href);
    return transport(input, { ...init, redirect: 'error' });
  };
}

export async function validateBroker(input: ValidationInput) {
  if (!input.accountId || !input.accNum || !input.token || !['live', 'demo'].includes(input.environment)) throw Error('validation_scope_missing');
  const { environment: env, token, accNum, accountId } = input;
  const durations: Record<string, number> = {};
  async function timed<T>(name: string, f: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await f(); }
    catch { throw Error(`${name}_read_failed`); }
    finally { durations[name] = Math.round(performance.now() - start); console.error(`validation_${name}_duration_ms=${durations[name]}`); }
  }
  // Sequential, bounded snapshot: no polling and no extra pressure on live managers.
  const config = await timed('config', () => getConfig(env, token, accNum));
  if (!config.ok) throw Error(`config_read_failed_${config.status}`);
  const pc = columnMap(config.data, 'positionsConfig');
  const oc = columnMap(config.data, 'ordersConfig');
  const hc = columnMap(config.data, 'ordersHistoryConfig') ?? oc;
  const positions = await timed('positions', () => listPositions(env, token, accNum, accountId));
  const orders = await timed('orders', () => listOrders(env, token, accNum, accountId));
  const history = await timed('history', () => listOrdersHistory(env, token, accNum, accountId));
  const instruments = await timed('instruments', () => listInstruments(env, token, accNum, accountId));
  const gold = instruments.ok ? instruments.data.filter(i => /^(XAUUSD|GOLD)([._-].*)?$/i.test(i.brokerSymbol.replace('/', ''))) : [];
  const quote = gold.length === 1 ? await timed('quote', () => getQuote(env, token, accNum, gold[0].tradableInstrumentId, gold[0].infoRouteId || gold[0].routeId)) : null;
  const stopEvidence = positions.ok ? positions.data.map(p => {
    const id = field(p, pc, ['id', 'positionId']);
    const direct = Number(field(p, pc, ['stopLoss', 'stopLossPrice', 'sl']));
    const stopId = field(p, pc, ['stopLossId']);
    const stop = direct > 0 && Number.isFinite(direct) ? direct : id != null && orders.ok ? protectiveStop(orders.data, oc, String(id), stopId != null && String(stopId) !== '0' ? String(stopId) : undefined) : null;
    return { identifiable: id != null, quantityReadable: Number(field(p, pc, ['qty', 'quantity', 'volume'])) > 0, stopReadable: stop != null };
  }) : [];
  const linkedHistory = history.ok ? history.data.filter(row => {
    const id = field(row, hc, ['id', 'orderId']);
    return id != null && positionForOrder([row], hc, String(id)) != null;
  }).length : 0;
  return {
    mode: 'read-only', accountId, environment: env, observedAt: new Date().toISOString(), durationsMs: durations,
    columns: { positions: Object.keys(pc ?? {}), orders: Object.keys(oc ?? {}), history: Object.keys(hc ?? {}) },
    reads: { positions: positions.ok, orders: orders.ok, history: history.ok, instruments: instruments.ok },
    counts: { positions: positions.ok ? positions.data.length : null, orders: orders.ok ? orders.data.length : null, history: history.ok ? history.data.length : null, linkedHistory, goldMatches: gold.length },
    stopEvidence,
    executableQuoteAvailable: quote?.ok ? { buy: executablePrice(quote.data, 'buy', 'entry') != null, sell: executablePrice(quote.data, 'sell', 'entry') != null } : null,
    brokerWriteValidation: 'not_performed',
  };
}
