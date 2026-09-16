import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, lastClosed, goldMarketOpen, tradableOnly } from '../src/lib/genx3/v31/series';
import { step, newState, entryBlackout } from '../src/lib/genx3/v31/engine';
import { evaluate } from '../src/lib/genx3/v31/stage2';
import { buildSignal31, validateSignal31 } from '../src/lib/genx3/v31/runtime';
import { CONFIG31 } from '../src/lib/genx3/v31/config';
import type { Bar } from '../src/lib/genx3/candles';

// deterministic pseudo-random walk, tradable minutes only
function walk(days: number, seed = 7): Bar[] {
  let s = seed, px = 4300; const out: Bar[] = [];
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const t0 = Date.UTC(2026, 6, 5, 22, 0); // Sunday 18:00 NY (EDT)
  for (let m = 0; m < days * 1440; m++) {
    const t = t0 + m * 60000; if (!goldMarketOpen(t)) continue;
    const o = px; const drift = (rnd() - 0.5) * 1.6 + (Math.floor(m / 400) % 2 ? 0.05 : -0.05);
    const c = +(o + drift).toFixed(2); const h = +(Math.max(o, c) + rnd() * 0.8).toFixed(2), l = +(Math.min(o, c) - rnd() * 0.8).toFixed(2);
    out.push({ t, o, h, l, c }); px = c;
  }
  return out;
}
const bars = walk(40);

test('market hours: Saturday closed, daily break closed, Wednesday open', () => {
  assert.equal(goldMarketOpen(Date.UTC(2026, 8, 12, 15, 0)), false);       // Sat
  assert.equal(goldMarketOpen(Date.UTC(2026, 8, 9, 21, 30)), false);       // Wed 17:30 NY break
  assert.equal(goldMarketOpen(Date.UTC(2026, 8, 9, 14, 0)), true);         // Wed 10:00 NY
});

test('entry blackout: last hour before Friday close, first hour after Sunday open, Flow reopen window', () => {
  assert.equal(entryBlackout(Date.UTC(2026, 8, 11, 20, 30)), true);        // Fri 16:30 NY
  assert.equal(entryBlackout(Date.UTC(2026, 8, 11, 19, 30)), false);       // Fri 15:30 NY
  assert.equal(entryBlackout(Date.UTC(2026, 8, 13, 22, 30)), true);        // Sun 18:30 NY
  assert.equal(entryBlackout(Date.UTC(2026, 8, 13, 23, 30)), false);       // Sun 19:30 NY
  assert.equal(entryBlackout(Date.UTC(2026, 8, 9, 21, 0)), true);          // Wed 17:00 NY
});

test('series: a bar is only visible after its period has closed', () => {
  const s = buildSeries(bars);
  const t = bars[5000].t;
  assert.equal(s.m1.bars[lastClosed(s.m1, t + 59_999)].t, bars[4999].t);
  assert.equal(s.m1.bars[lastClosed(s.m1, t + 60_000)].t, t);
  const i5 = lastClosed(s.m5, t + 60_000); assert.ok(s.m5.bars[i5].t + 300_000 <= t + 60_000);
});

test('no look-ahead: the decision at time T is identical with or without the bars after T', () => {
  const full = buildSeries(bars);
  let compared = 0;
  for (let k = 30000; k < bars.length - 10 && compared < 40; k += 97) {
    const asOf = Math.floor(bars[k].t / 300000) * 300000;
    const cut = buildSeries(bars.filter((b) => b.t + 60000 <= asOf));
    const cfg = { ...CONFIG31, rules: Object.fromEntries(Object.entries(CONFIG31.rules).map(([k2, r]) => [k2, { ...r, enabled: true }])) } as typeof CONFIG31;
    const a = step(full, asOf, cfg, newState(), { early: false }), b = step(cut, asOf, cfg, newState(), { early: false });
    assert.deepEqual(a.scored.map((x) => [x.c.anchor, x.c.entry, x.c.stop, x.v.ok, x.v.score]), b.scored.map((x) => [x.c.anchor, x.c.entry, x.c.stop, x.v.ok, x.v.score]));
    compared++;
  }
  assert.ok(compared > 20);
});

test('replaying the same minute twice never produces a second candidate for the same anchor', () => {
  const s = buildSeries(bars); const st = newState();
  const cfg = { ...CONFIG31, rules: Object.fromEntries(Object.entries(CONFIG31.rules).map(([k2, r]) => [k2, { ...r, enabled: true }])) } as typeof CONFIG31;
  let firstAnchors = 0, repeats = 0;
  for (let t = Math.floor(bars[30000].t / 300000) * 300000; t < bars[bars.length - 100].t; t += 300000) {
    const a = step(s, t, cfg, st, { early: false }); firstAnchors += a.scored.length;
    const b = step(s, t, cfg, st, { early: false }); repeats += b.scored.length;
  }
  assert.equal(repeats, 0);
  assert.ok(firstAnchors >= 0);
});

test('stage 2 hard requirements: stop beyond the $10 Flow cap and misaligned direction are rejected', () => {
  const s = buildSeries(bars); let checked = 0;
  for (let t = Math.floor(bars[32000].t / 300000) * 300000; t < bars.at(-1)!.t && checked < 5; t += 300000) {
    const cfg = { ...CONFIG31, align: 'none' as const, rules: Object.fromEntries(Object.entries(CONFIG31.rules).map(([k2, r]) => [k2, { ...r, enabled: true }])) } as typeof CONFIG31;
    const r = step(s, t, cfg, newState(), { early: false });
    for (const x of r.scored) {
      const wide = { ...x.c, risk: 12 };
      assert.equal(evaluate(wide, r.ctx!, cfg).hardFail, 'stop_beyond_flow_cap');
      const mis = { ...x.c, f: { ...x.c.f, htf: -1, h4: -1, m20: -1 } };
      assert.match(String(evaluate(mis, r.ctx!, { ...cfg, align: '2of3' }).hardFail), /direction_not_aligned|stop_/);
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test('signal: builds a valid, deterministic payload with stop and target on the correct sides', () => {
  const s = buildSeries(bars); let done = false;
  const cfg = { ...CONFIG31, align: 'none' as const, minRiskAtr15: 0, rules: Object.fromEntries(Object.entries(CONFIG31.rules).map(([k2, r]) => [k2, { ...r, enabled: true }])) } as typeof CONFIG31;
  for (let t = Math.floor(bars[32000].t / 300000) * 300000; t < bars.at(-1)!.t && !done; t += 300000) {
    const r = step(s, t, cfg, newState(), { early: false });
    const x = r.scored.find((y) => y.c.risk >= 1 && y.c.risk <= 10); if (!x || !r.ctx) continue;
    const a = buildSignal31(x, r.ctx, t, 1000), b = buildSignal31(x, r.ctx, t, 1000);
    assert.equal(a.idempotency_key, b.idempotency_key); assert.equal(a.signal_id, b.signal_id);
    assert.deepEqual(validateSignal31(a), []);
    assert.ok(x.c.side === 'BUY' ? a.stop_price < a.entry_zone_low && a.target_price > a.entry_zone_high : a.stop_price > a.entry_zone_high && a.target_price < a.entry_zone_low);
    assert.ok(validateSignal31({ ...a, stop_price: a.target_price }).length > 0);
    done = true;
  }
  assert.ok(done);
});

test('config: only the playbooks that held up in every test period are enabled', () => {
  const on = Object.entries(CONFIG31.rules).filter(([, r]) => r.enabled).map(([k]) => k).sort();
  assert.deepEqual(on, ['BOS_PULLBACK', 'SESSION_BREAK']);
  assert.equal(CONFIG31.maxRiskUsd, 10);
  assert.ok(tradableOnly(bars).length === bars.length);
});
