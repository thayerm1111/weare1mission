import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRapid, detectStructure, detectSwing, detectAll, RAPID, STRUCTURE, atrOf } from '../src/lib/genx/styles/detectors';
import { sessionOf, pipsBetween, type Bar, type StyleCtx } from '../src/lib/genx/styles/types';

const bar = (o: number, h: number, l: number, c: number): Bar => ({ o, h, l, c });
const flat = (n: number, px: number, w = 1): Bar[] => Array.from({ length: n }, () => bar(px, px + w, px - w, px));
const base = (over: Partial<StyleCtx> = {}): StyleCtx => ({
  price: 4350, atr: 2, pip: 0.1, nowMs: Date.UTC(2026, 8, 18, 13, 0),
  m5: flat(60, 4350, 2), m15: flat(60, 4350, 3), h1: flat(40, 4350, 6), h4: flat(40, 4350, 12), d1: flat(10, 4350, 20),
  session: 'ny', pdh: 4380, pdl: 4320, ...over,
});

test('every style declines a dead market', () => {
  const all = detectAll(base({ m5: flat(60, 4350, 0.1), m15: flat(60, 4350, 0.1) }));
  assert.equal(all.rapid, null); assert.equal(all.structure, null); assert.equal(all.swing, null);
});

test('RAPID: takes a 5-minute break of the session high with 40-50 pip targets', () => {
  const m5 = [...flat(50, 4350, 2), bar(4351.6, 4354.2, 4351.4, 4354.0)];  // closes through the 4352 session high
  const m15 = [...flat(50, 4350, 3), bar(4348, 4355, 4347, 4354)];
  const ctx = base({ m5, m15, price: 4354.1 });
  const s = detectRapid(ctx);
  assert.ok(s, 'a decisive break should produce a setup');
  assert.equal(s!.side, 'buy');
  assert.equal(pipsBetween(s!.entryHigh, s!.stop, 0.1) >= RAPID.stopPips, true);
  assert.equal(pipsBetween(4354.1, s!.tp1, 0.1), RAPID.tp1Pips, 'first target is 45 pips');
  assert.ok(s!.tp1 > 4354.1 && s!.stop < 4354.1);
});

test('RAPID: will not chase a level it has already run away from', () => {
  const m5 = [...flat(50, 4350, 2), bar(4352, 4360, 4351.8, 4359.8)];
  assert.equal(detectRapid(base({ m5, price: 4372 })), null);            // 200 pips past the level
});

test('RAPID: sits out when volatility is too low for a 45-pip target', () => {
  const m5 = [...flat(50, 4350, 0.2), bar(4350, 4350.9, 4349.9, 4350.8)];
  assert.equal(detectRapid(base({ m5, m15: flat(60, 4350, 0.15) })), null);
});

test('STRUCTURE: needs break AND retest — a break alone is not a trade', () => {
  const broken = [...flat(50, 4350, 3), bar(4352, 4362, 4351, 4361), bar(4361, 4364, 4360, 4363)];
  assert.equal(detectStructure(base({ m15: broken, price: 4363 })), null, 'no retest yet');
});

test('STRUCTURE: takes the retest that holds, stop beyond the wick', () => {
  const m15 = [
    ...flat(46, 4350, 3),
    bar(4352, 4362, 4351, 4361),          // break of the ~4353 range high
    bar(4361, 4363, 4360, 4362),
    bar(4362, 4362.5, 4353.2, 4360.5),    // comes back to the level and closes back above it
    bar(4360, 4364, 4359, 4355),
  ];
  const s = detectStructure(base({ m15, price: 4355 }));
  assert.ok(s, 'break + held retest should produce a setup');
  assert.equal(s!.side, 'buy');
  assert.ok(s!.stop < 4353.2, 'stop sits under the retest low');
  const r = 4355 - s!.stop;
  assert.ok(Math.abs((s!.tp1 - 4355) - r * STRUCTURE.tp1R) < 0.05, 'first target is 1.6R');
});

test('SWING: needs the sweep, the reclaim AND the 4-hour trend', () => {
  const d1 = [...flat(6, 4400, 25)];                                     // 3-day low ≈ 4375
  const h1 = [...flat(12, 4380, 5), bar(4380, 4381, 4370, 4379)];        // ran under it and came back
  const upTrend = Array.from({ length: 30 }, (_, i) => bar(4300 + i * 4, 4304 + i * 4, 4296 + i * 4, 4302 + i * 4));
  const s = detectSwing(base({ d1, h1, h4: upTrend, price: 4382 }));
  assert.ok(s && s.side === 'buy', 'sweep + reclaim + rising 4h = long');
  assert.ok(s!.stop < 4370, 'stop beyond the sweep');
  const downTrend = [...upTrend].reverse();
  assert.equal(detectSwing(base({ d1, h1, h4: downTrend, price: 4382 })), null, '4h trend disagrees → no trade');
});

test('the three styles are independent — one firing never forces another', () => {
  const m5 = [...flat(50, 4350, 2), bar(4351.6, 4354.2, 4351.4, 4354.0)];
  const all = detectAll(base({ m5, price: 4354.1 }));
  assert.ok(all.rapid, 'rapid fires');
  assert.equal(all.structure, null, 'structure has no retest here');
  assert.equal(all.swing, null, 'swing has no sweep here');
});

test('sessions map to New York hours', () => {
  assert.equal(sessionOf(Date.UTC(2026, 8, 18, 12, 0)), 'ny');       // 08:00 New York
  assert.equal(sessionOf(Date.UTC(2026, 8, 18, 8, 0)), 'london');    // 04:00 New York
  assert.equal(sessionOf(Date.UTC(2026, 8, 18, 2, 0)), 'asia');      // 22:00 NY
});

test('atr is a real average, not the last bar', () => {
  assert.equal(atrOf(flat(3, 4350, 1)), null, 'not enough bars');
  const a = atrOf(flat(30, 4350, 2));
  assert.ok(a != null && a > 3.9 && a < 4.1);
});
