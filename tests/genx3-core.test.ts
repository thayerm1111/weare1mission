import test from 'node:test';
import assert from 'node:assert/strict';
import { XAUUSD, toTicks, fromTicks, roundPrice, distance } from '../src/lib/genx3/instrument';
import { normalize1m, aggregate, checkHealth, type Bar } from '../src/lib/genx3/candles';
import { pivots } from '../src/lib/genx3/structure';
import { canTransition } from '../src/lib/genx3/stateMachine';
import { idempotencyKey, stableUuid, validateSignal, type Genx3Signal } from '../src/lib/genx3/signal';
import { CONFIG, validateConfig, STRATEGY, STRATEGY_VERSION } from '../src/lib/genx3/config';
import { analyze } from '../src/lib/genx3/engine';
import { activeEngine } from '../src/lib/genx3/engineSelect';

const T0 = Date.UTC(2026, 8, 15, 10, 0, 0);
const bar = (i: number, px = 4300): Bar => ({ t: T0 + i * 60_000, o: px, h: px + 0.5, l: px - 0.5, c: px + 0.1 });

test('instrument: $1 of gold = 100 ticks = 10 display pips; round trip is exact', () => {
  assert.equal(toTicks(1), 100);
  assert.equal(fromTicks(250), 2.5);
  const d = distance(4300, 4310);
  assert.deepEqual([d.priceUsd, d.ticks, d.displayPips, d.specVersion], [10, 1000, 100, XAUUSD.specVersion]);
  assert.equal(roundPrice(4300.126, 'down'), 4300.12);
  assert.equal(roundPrice(4300.121, 'up'), 4300.13);
});

test('candles: the forming 1m bar is never treated as closed', () => {
  const raw = [bar(0), bar(1), bar(2)];
  const asOf = T0 + 2 * 60_000 + 30_000; // mid bar 2
  const n = normalize1m(raw, asOf);
  assert.equal(n.closed.length, 2);
  assert.equal(n.forming?.t, bar(2).t);
});

test('candles: 5m bucket only emitted after its full period elapsed; UTC boundaries', () => {
  const raw = Array.from({ length: 10 }, (_, i) => bar(i));
  const early = aggregate(normalize1m(raw, T0 + 9 * 60_000 + 59_000).closed, '5m', T0 + 9 * 60_000 + 59_000);
  assert.equal(early.length, 1);
  assert.equal(early[0].t % 300_000, 0);
  const late = aggregate(normalize1m(raw, T0 + 10 * 60_000).closed, '5m', T0 + 10 * 60_000);
  assert.equal(late.length, 2);
});

test('candles: duplicates, invalid OHLC and out-of-order rows are cleaned and counted', () => {
  const bad = { t: T0 + 3 * 60_000, o: 4300, h: 4299, l: 4301, c: 4300 };
  const n = normalize1m([bar(1), bar(0), bar(1), bad], T0 + 10 * 60_000);
  assert.equal(n.closed.length, 2);
  assert.equal(n.duplicates, 1);
  assert.equal(n.invalid, 1);
  assert.ok(n.outOfOrder >= 1);
});

test('health: a stale feed is INVALID (fail closed)', () => {
  const closed = Array.from({ length: 100 }, (_, i) => bar(i));
  const asOf = closed.at(-1)!.t + 60_000 + CONFIG.data.maxFeedAgeMs + 1_000;
  const h = checkHealth({ closed1m: closed, asOf, maxFeedAgeMs: CONFIG.data.maxFeedAgeMs, maxGapBars: 3, spikeAtrMultiple: 4, duplicates: 0, outOfOrder: 0, invalid: 0, feedDisagreeUsd: 3 });
  assert.equal(h.state, 'INVALID');
  assert.ok(h.issues.some((x) => x.startsWith('stale_feed')));
});

test('health: live tick disagreeing with candles is INVALID', () => {
  const closed = Array.from({ length: 100 }, (_, i) => bar(i));
  const asOf = closed.at(-1)!.t + 61_000;
  const h = checkHealth({ closed1m: closed, asOf, maxFeedAgeMs: 150000, maxGapBars: 3, spikeAtrMultiple: 4, duplicates: 0, outOfOrder: 0, invalid: 0, liveTick: 4310, feedDisagreeUsd: 3 });
  assert.equal(h.state, 'INVALID');
});

test('structure: pivots do not repaint — a confirmed pivot survives new bars', () => {
  const prices = [1, 2, 3, 6, 3, 2, 1, 2, 3, 2, 1];
  const bars: Bar[] = prices.map((p, i) => ({ t: i * 900_000, o: 4300 + p, h: 4300 + p + 0.2, l: 4300 + p - 0.2, c: 4300 + p }));
  const early = pivots(bars.slice(0, 6), 3, 3, 900_000);
  assert.equal(early.confirmed.filter((p) => p.kind === 'high').length, 0, 'needs 3 right bars');
  assert.ok(early.tentative.some((p) => p.kind === 'high' && p.i === 3));
  const later = pivots(bars, 3, 3, 900_000);
  const hi = later.confirmed.find((p) => p.kind === 'high' && p.i === 3)!;
  assert.ok(hi);
  assert.equal(hi.confirmedAt, bars[6].t + 900_000);
  const more = pivots([...bars, ...bars.map((b, i) => ({ ...b, t: b.t + 11 * 900_000 + i }))].slice(0, 15), 3, 3, 900_000);
  assert.ok(more.confirmed.some((p) => p.kind === 'high' && p.i === 3 && p.price === hi.price));
});

test('state machine: forward only, publish only from TRIGGERED, terminal states frozen', () => {
  assert.equal(canTransition('ARMED', 'WATCHING'), false);
  assert.equal(canTransition('WATCHING', 'PUBLISHED'), false);
  assert.equal(canTransition('TRIGGERED', 'PUBLISHED'), true);
  assert.equal(canTransition('PUBLISHED', 'REJECTED_BY_FLOW'), true);
  assert.equal(canTransition('EXPIRED', 'TRIGGERED'), false);
  assert.equal(canTransition('INVALIDATED', 'EXPIRED'), false);
});

const p = { setupKey: 'B:PDL:1', decisionClose: T0, side: 'BUY', entry: 4300.1, stop: 4296, target: 4308 };
test('idempotency: same inputs → same key and id; any change → different key', () => {
  assert.equal(idempotencyKey(p), idempotencyKey({ ...p }));
  assert.notEqual(idempotencyKey(p), idempotencyKey({ ...p, decisionClose: T0 + 300_000 }));
  assert.notEqual(idempotencyKey(p), idempotencyKey({ ...p, stop: 4295.99 }));
  assert.equal(stableUuid('x'), stableUuid('x'));
  assert.match(stableUuid('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

function goodSignal(): Genx3Signal {
  const key = idempotencyKey(p);
  return {
    signal_id: stableUuid(key), setup_id: stableUuid('s'), strategy: STRATEGY, strategy_version: STRATEGY_VERSION, symbol_canonical: 'XAUUSD', broker_symbol: XAUUSD.brokerSymbol,
    side: 'BUY', setup_type: 'SWEEP_RECLAIM', regime: 'ORDERLY_RANGE', created_at_utc: new Date(T0).toISOString(), expires_at_utc: new Date(T0 + 900_000).toISOString(),
    market_snapshot_id: 'snap', decision_candle_close_time: new Date(T0).toISOString(), entry_type: 'LIMIT', entry_price: 4300.1, entry_zone_low: 4299.9, entry_zone_high: 4300.3,
    stop_price: 4296, target_price: 4308, target_price_distance: 7.9, target_ticks: 790, target_points: 790, target_display_pips: 79, risk_price_distance: 4.1, gross_reward_risk: 1.93,
    estimated_net_reward_risk: 1.6, confidence: 70, score_components: {} as never, evidence: ['swept PDL'], contradictions: [], invalidation_conditions: ['close below 4296'],
    spread_at_decision: 0.3, spread_is_estimate: true, feed_latency_ms: 1000, data_quality: 'HEALTHY', news_state: 'CLEAR', idempotency_key: key, correlation_id: stableUuid('c'), instrument_spec_version: XAUUSD.specVersion,
  } as Genx3Signal;
}
test('signal schema: a well-formed signal validates', () => {
  assert.deepEqual(validateSignal(goodSignal()), []);
});
test('signal schema: wrong-side stop, stale data, news, expiry, bad key are rejected', () => {
  assert.ok(validateSignal({ ...goodSignal(), stop_price: 4301 }).length);
  assert.ok(validateSignal({ ...goodSignal(), data_quality: 'DEGRADED' as never }).length);
  assert.ok(validateSignal({ ...goodSignal(), news_state: 'UNKNOWN' as never }).length);
  assert.ok(validateSignal({ ...goodSignal(), expires_at_utc: new Date(T0).toISOString() }).length);
  assert.ok(validateSignal({ ...goodSignal(), idempotency_key: 'abc' }).length);
  assert.ok(validateSignal({ ...goodSignal(), entry_price: NaN }).length);
});

test('engine: stale / insufficient data never yields a signal', () => {
  const raw = Array.from({ length: 200 }, (_, i) => bar(i));
  const d = analyze({ raw1m: raw, asOf: T0 + 5 * 3_600_000, news: { state: 'CLEAR' } });
  assert.equal(d.signal, null);
  assert.ok(d.noTradeReasons.some((r) => r.startsWith('data_invalid') || r.startsWith('insufficient_history')));
});

test('engine: deterministic — same input gives the same decision', () => {
  const raw = Array.from({ length: 300 }, (_, i) => bar(i, 4300 + Math.sin(i / 7) * 3));
  const asOf = raw.at(-1)!.t + 61_000;
  const a = analyze({ raw1m: raw, asOf, news: { state: 'CLEAR' } });
  const b = analyze({ raw1m: raw, asOf, news: { state: 'CLEAR' } });
  assert.deepEqual(a, b);
});

test('config is internally consistent; engine selection defaults to genx1 (owner 09-16) and rollback is explicit', () => {
  assert.doesNotThrow(() => validateConfig());
  const prev = process.env.GENX_ENGINE;
  delete process.env.GENX_ENGINE; assert.equal(activeEngine(), 'genx1');
  process.env.GENX_ENGINE = 'genx2'; assert.equal(activeEngine(), 'genx2');
  process.env.GENX_ENGINE = 'genx3'; assert.equal(activeEngine(), 'genx3');
  process.env.GENX_ENGINE = 'garbage'; assert.equal(activeEngine(), 'genx1');
  if (prev === undefined) delete process.env.GENX_ENGINE; else process.env.GENX_ENGINE = prev;
});

test('scope: designated with no users is blocked; unknown scope values never widen to everyone', async () => {
  const { deliveryScope } = await import('../src/lib/genx3/runtime');
  assert.deepEqual(deliveryScope({ live_scope: 'designated', designated_user_ids: [] }), { onlyUserIds: [], blocked: true });
  const u = '3b5e06e5-258c-4880-b1f2-d1623cbca100';
  assert.deepEqual(deliveryScope({ live_scope: 'designated', designated_user_ids: [u, 'junk'] }), { onlyUserIds: [u], blocked: false });
  assert.deepEqual(deliveryScope({ live_scope: 'weird' as never, designated_user_ids: [] }), { onlyUserIds: [], blocked: true });
});
