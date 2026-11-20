import test from 'node:test';
import assert from 'node:assert/strict';
import { realCandles, niceStep, priceText, agoText, chartFrame, type ChartCandle } from '../src/lib/floor/chart';

/*
 * THE FLOOR's chart draws what it is given and nothing else (owner specs: "Never replace real missing data
 * with fabricated candles"; "Never place moving decoration behind financial figures"). These pin the
 * arithmetic: which candles count, what the scale is, which levels fit, and what the time marks say.
 */
const candles = (n: number, base = 3550, stepMin = 15): ChartCandle[] => Array.from({ length: n }, (_, i) => {
  const o = base + Math.sin(i / 5) * 8, c = base + Math.sin((i + 1) / 5) * 8;
  const t = new Date(Date.parse('2026-11-20T06:00:00Z') + i * stepMin * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  return { t, o: +o.toFixed(2), h: +(Math.max(o, c) + 1.5).toFixed(2), l: +(Math.min(o, c) - 1.5).toFixed(2), c: +c.toFixed(2) };
});
const frame = (o: Partial<Parameters<typeof chartFrame>[0]> = {}) => chartFrame({ candles: candles(60), price: 3551, levels: [], zone: null, width: 900, height: 260, dec: 2, ...o });

test('a candle that is not a real candle is left out — never repaired', () => {
  const good = { t: '2026-11-20 06:00:00', o: 10, h: 12, l: 9, c: 11 };
  const out = realCandles([
    good,
    { ...good, h: NaN },
    { ...good, c: undefined },
    { ...good, h: 8 },                 // a high under its own open
    { ...good, l: 10.5 },              // a low above its own open
    null, 'x',
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(realCandles('not a list'), []);
});

test('with too little to draw there is no chart, rather than a made-up one', () => {
  assert.equal(frame({ candles: candles(1) }), null);
  assert.equal(frame({ candles: [] }), null);
  assert.equal(frame({ width: 80 }), null);
});

test('price steps are round numbers', () => {
  assert.equal(niceStep(46, 5), 10);
  assert.equal(niceStep(9, 5), 2);
  assert.equal(niceStep(0.012, 6), 0.002);
  assert.equal(niceStep(0, 6), 1);
  assert.equal(priceText(3550, 2), '3,550.00');
  assert.equal(priceText(1.08342, 5), '1.08342');
});

test('every candle is inside the frame and the latest price sits on the axis', () => {
  const f = frame()!;
  assert.equal(f.bars.length, 60);
  for (const b of f.bars) {
    assert.ok(b.x > 0 && b.x < f.plotW);
    assert.ok(b.yHigh >= f.top - 0.5 && b.yLow <= f.bottom + 0.5);
    assert.ok(b.yHigh <= b.yTop && b.yTop + b.bodyH <= b.yLow + 1.01, 'the body sits inside its wick');
    assert.ok(b.bodyH >= 1);
  }
  assert.equal(f.last!.text, '3,551.00');
  assert.ok(f.yTicks.length >= 3 && f.yTicks.every((t) => /^\d,\d{3}\.\d\d$/.test(t.text)));
  assert.ok(f.plotW + f.axisW === f.width);
});

test('only the last sixty candles are drawn', () => {
  assert.equal(frame({ candles: candles(140) })!.bars.length, 60);
});

test('a level near the market is drawn; one far away is left off rather than flattening the candles', () => {
  const near = frame({ levels: [{ kind: 'resistance', price: 3565.77, label: 'Resistance' }, { kind: 'support', price: 3532.8, label: 'Support' }] })!;
  assert.deepEqual(near.levels.map((l) => l.text).sort(), ['Resistance 3,565.77', 'Support 3,532.80']);
  for (const l of near.levels) assert.ok(l.y > near.top && l.y < near.bottom);
  const span = (f: NonNullable<ReturnType<typeof frame>>) => Math.max(...f.bars.map((b) => b.yLow)) - Math.min(...f.bars.map((b) => b.yHigh));
  const far = frame({ levels: [{ kind: 'target', price: 3900, label: 'Target' }] })!;
  assert.equal(far.levels.length, 0);
  assert.ok(Math.abs(span(far) - span(frame()!)) < 0.5, 'the candles keep their size');
});

test('two labels never land on top of each other', () => {
  const f = frame({ levels: [{ kind: 'resistance', price: 3560, label: 'Resistance' }, { kind: 'stop', price: 3560.6, label: 'Stop' }, { kind: 'entry', price: 3559.5, label: 'Entry' }] })!;
  const ys = f.levels.map((l) => l.labelY).sort((a, b) => a - b);
  assert.equal(f.levels.length, 3);
  assert.ok(new Set(ys.map((y) => Math.round(y))).size >= 2, 'at least one label moved beneath its line');
});

test('the entry zone is clipped to the frame, and a zone that is not a zone is not drawn', () => {
  const f = frame({ zone: { low: 3548, high: 3552 } })!;
  assert.ok(f.zone && f.zone.h > 0 && f.zone.y >= f.top && f.zone.y + f.zone.h <= f.bottom + 0.01);
  assert.equal(frame({ zone: { low: 3552, high: 3548 } })!.zone, null);
  assert.equal(frame({ zone: { low: 9000, high: 9010 } })!.zone, null);
});

test('time marks say how long before the latest candle — the same in every time zone', () => {
  const f = frame()!;                                   // 60 candles, 15 minutes apart: 14 h 45 min
  const texts = f.xTicks.map((t) => t.text);
  assert.equal(texts[texts.length - 1], 'Latest');
  assert.ok(texts.includes('3 h ago') && texts.includes('6 h ago'));
  assert.ok(texts.every((t) => t === 'Latest' || / ago$/.test(t)));
  assert.ok(!texts.some((t) => /\d\d:\d\d/.test(t)), 'no clock times: the feed\'s clock is not the member\'s');
  // The same candles stamped in another zone's clock give the same marks.
  const shifted = candles(60).map((k) => ({ ...k, t: new Date(Date.parse(k.t.replace(' ', 'T') + 'Z') + 11 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') }));
  assert.deepEqual(frame({ candles: shifted })!.xTicks.map((t) => t.text), texts);
  assert.equal(agoText(45 * 60_000), '45 min');
  assert.equal(agoText(3 * 3600_000), '3 h');
  assert.equal(agoText(90 * 60_000), '1.5 h');
  assert.equal(agoText(3 * 86_400_000), '3 d');
});

test('a gap in the candles (the market was shut) gets no mark invented for it', () => {
  // Thirty candles, a 20-hour gap, thirty more: no candle sits near "12 h ago", so nothing is marked there.
  const a = candles(30), b = candles(30).map((k) => ({ ...k, t: new Date(Date.parse(k.t.replace(' ', 'T') + 'Z') + (20 + 7.5) * 3600_000).toISOString().slice(0, 19).replace('T', ' ') }));
  const f = frame({ candles: [...a, ...b] })!;
  assert.ok(!f.xTicks.some((t) => t.text === '12 h ago'));
  assert.equal(f.xTicks[f.xTicks.length - 1].text, 'Latest');
});

test('candles with no readable times still draw — without time marks', () => {
  const f = frame({ candles: candles(40).map((k) => ({ ...k, t: '' })) })!;
  assert.equal(f.bars.length, 40);
  assert.deepEqual(f.xTicks, []);
});

test('on a narrow chart the price figures get the room they need', () => {
  const wide = frame()!, narrow = frame({ width: 330 })!;
  assert.ok(narrow.axisPad < wide.axisPad);
  assert.ok(narrow.axisW - narrow.axisPad >= 58, 'room for "3,550.00" at the axis size');
});
