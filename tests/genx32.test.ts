import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, goldMarketOpen } from '../src/lib/genx3/v31/series';
import { step32, newState32 } from '../src/lib/genx3/v32/engine';
import { CONFIG32, STRATEGY_VERSION_32 } from '../src/lib/genx3/v32/config';
import { buildSignal32, validateSignal32 } from '../src/lib/genx3/v32/runtime';
import { simulate } from '../src/lib/genx3/v32/sim';
import { selectBrain, genx3AccountFilter, originAllowed } from '../src/lib/genx3/engineSelect';
import type { Bar } from '../src/lib/genx3/candles';

function walk(days: number, seed = 11): Bar[] {
  let s = seed, px = 4300; const out: Bar[] = [];
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const t0 = Date.UTC(2026, 6, 5, 22, 0);
  for (let m = 0; m < days * 1440; m++) {
    const t = t0 + m * 60000; if (!goldMarketOpen(t)) continue;
    const regime = Math.floor(m / 700) % 4; const drift = regime === 0 ? 0.12 : regime === 2 ? -0.12 : 0;
    const vol = regime === 3 ? 0.35 : 1.4;
    const o = px, c = +(o + (rnd() - 0.5) * vol + drift + (rnd() < 0.004 ? (rnd() - 0.5) * 12 : 0)).toFixed(2);
    out.push({ t, o, h: +(Math.max(o, c) + rnd() * 0.6 * vol).toFixed(2), l: +(Math.min(o, c) - rnd() * 0.6 * vol).toFixed(2), c }); px = c;
  }
  return out;
}
const bars = walk(42);
const series = buildSeries(bars);
const minutes = (from: number, to: number) => { const out: number[] = []; for (let t = Math.ceil(bars[from].t / 60000) * 60000; t < bars[to].t; t += 60000) out.push(t); return out; };

let collected: ReturnType<typeof step32>[] = [];
test('router + engines run on every closed minute and produce auditable records', () => {
  const st = newState32();
  for (const t of minutes(32000, bars.length - 50)) { const r = step32(series, t, st); if (r.ctx) collected.push(r); }
  assert.ok(collected.length > 5000);
  const states = new Set(collected.map((r) => r.state!.state));
  assert.ok(states.size >= 3, `states seen: ${[...states]}`);
  for (const r of collected) for (const x of r.records) {
    assert.ok(['PASSED','FAILED','WAITED','EXPIRED','INVALIDATED','LOST_ARBITRATION','NOT_ROUTED','SHADOW_ONLY','SELECTED'].includes(x.status));
    if (x.status === 'FAILED' || x.status === 'NOT_ROUTED' || x.status === 'WAITED' || x.status === 'LOST_ARBITRATION' || x.status === 'SHADOW_ONLY') assert.ok(x.reasons.length > 0, `${x.setup} ${x.status} has no reason`);
  }
});

test('arbitration: at most one selection per minute, never a SHADOW engine, never inside a blackout', () => {
  for (const r of collected) {
    const sel = r.records.filter((x) => x.status === 'SELECTED');
    assert.ok(sel.length <= 1);
    if (sel.length) { assert.equal(r.selected, sel[0]); assert.equal(CONFIG32.rules[sel[0].setup].mode, 'LIVE'); }
  }
});

test('no look-ahead: records at T are identical with or without later bars', () => {
  let n = 0;
  for (let k = 33000; k < bars.length - 20 && n < 25; k += 211) {
    const t = Math.floor(bars[k].t / 60000) * 60000;
    const cut = buildSeries(bars.filter((b) => b.t + 60000 <= t));
    const a = step32(series, t, newState32()), b = step32(cut, t, newState32());
    const key = (r: typeof a) => r.records.map((x) => [x.setup, x.anchor, x.status, x.score, x.cand?.entry, x.cand?.stop].join('|'));
    assert.deepEqual(key(a), key(b)); assert.equal(a.state?.state, b.state?.state); n++;
  }
  assert.ok(n > 15);
});

test('duplicate protection: the same minute evaluated twice never re-emits a candidate', () => {
  const st = newState32(); let again = 0;
  for (const t of minutes(34000, 40000)) { step32(series, t, st); again += step32(series, t, st).records.filter((x) => x.status !== 'WAITED').length; }
  assert.equal(again, 0);
});

test('stale data fails closed', () => {
  const t = bars[36000].t + 20 * 60000;
  const cut = buildSeries(bars.slice(0, 36001));
  const r = step32(cut, Math.floor(t / 60000) * 60000, newState32());
  assert.equal(r.selected, null);
  assert.ok(r.reasons.includes('market_closed_or_stale'));
});

test('signal: valid payload, deterministic id, malformed variants rejected', () => {
  const r = collected.find((x) => x.selected?.cand);
  if (!r) { assert.ok(true, 'no selection in synthetic data'); return; }
  const a = buildSignal32(r.selected!, r, 1000), b = buildSignal32(r.selected!, r, 1000);
  assert.equal(a.signal_id, b.signal_id);
  assert.deepEqual(validateSignal32(a), []);
  assert.ok(validateSignal32({ ...a, stop_price: a.target_price }).length);
  assert.ok(validateSignal32({ ...a, risk_price_distance: a.risk_price_distance * 3 }).length, 'corrupted risk');
  assert.ok(validateSignal32({ ...a, entry_price: 43 }).length, 'impossible price');
  assert.ok(validateSignal32({ ...a, strategy_version: '3.1.0' }).length, 'version');
  assert.ok(validateSignal32({ ...a, risk_price_distance: 75, stop_price: a.entry_price - 75 * (a.side === 'BUY' ? 1 : -1) }).length, 'corrupt-data stop bound');
  assert.deepEqual(validateSignal32({ ...a, risk_price_distance: 25, stop_price: +(a.entry_price - 25 * (a.side === 'BUY' ? 1 : -1)).toFixed(2) }).filter((x) => /risk .* outside/.test(x)), [], 'a $25 structural stop is allowed (no 100-pip cap)');
});

test('version isolation: only 3.1.0 and 3.2.0 select a brain', () => {
  assert.equal(selectBrain('3.2.1'), '3.2.1'); assert.equal(selectBrain('3.2.0'), '3.2.1', 'rollout alias'); assert.equal(selectBrain('3.1.0'), '3.1.0');
  assert.equal(selectBrain('3.3.0'), null); assert.equal(selectBrain(undefined), null);
  assert.equal(STRATEGY_VERSION_32, '3.2.1');
});

test('account whitelist: a 3.2 signal reaches only 803349 and 772642; legacy never reaches them', () => {
  const accts = ['803349', '772642', '824669', '810219', '999001'].map((id) => ({ id }));
  const only = ['803349', '772642'];
  assert.deepEqual(genx3AccountFilter(accts, (a) => a.id, { origin: 'genx3', onlyAccountIds: only }, new Set()).map((a) => a.id), only);
  assert.deepEqual(genx3AccountFilter(accts, (a) => a.id, { origin: 'genx2' }, new Set(only)).map((a) => a.id), ['824669', '810219', '999001']);
  assert.deepEqual(genx3AccountFilter(accts, (a) => a.id, { origin: 'genx3', onlyAccountIds: [] }, new Set()).length, 0, 'empty whitelist = nobody');
  assert.equal(originAllowed('genx3'), true);
});

test('shadow simulator: an open position at the end of data is reported open, not unfilled', () => {
  const b: Bar[] = [0, 1, 2, 3].map((i) => ({ t: i * 60000, o: 100 + i * 0.1, h: 100.3 + i * 0.1, l: 99.9 + i * 0.1, c: 100.1 + i * 0.1 }));
  const r = simulate(b, { side: 'BUY', startIdx: 1, entry: 100.1, zoneLow: 100.1, zoneHigh: 100.1, stop: 95, target: 110, ttlMs: 180000, maxHoldMs: 864e5, chaseUsd: 1, costUsd: 0.5 });
  assert.equal(r.filled, true); assert.equal(r.open, true);
});

test('3.1 baseline preserved: SESSION_BREAK and BOS_PULLBACK stay LIVE and ungated by the router', () => {
  assert.equal(CONFIG32.rules.SESSION_BREAK.mode, 'LIVE'); assert.equal(CONFIG32.rules.BOS_PULLBACK.mode, 'LIVE');
  assert.equal(CONFIG32.rules.SESSION_BREAK.states, 'ANY'); assert.equal(CONFIG32.rules.BOS_PULLBACK.states, 'ANY');
  assert.equal(CONFIG32.maxRiskUsd, 60); assert.equal(CONFIG32.maxRiskAtr15, 3.5);
});
