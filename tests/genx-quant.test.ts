import test from 'node:test';
import assert from 'node:assert/strict';
import { features, slope, atr, type Bar } from '../src/lib/genx/quant/features';
import { labelPath, breakEvenRate, expectancy } from '../src/lib/genx/quant/label';
import { fitLogistic, standardise, probability, shouldTake, auc, sigmoid, type Model } from '../src/lib/genx/quant/model';

const bar = (c: number, w = 1): Bar => ({ o: c, h: c + w, l: c - w, c });
const trendUp = Array.from({ length: 200 }, (_, i) => bar(4300 + i * 0.5));
const chop = Array.from({ length: 200 }, (_, i) => bar(4300 + (i % 4) * 0.5));

test('slope and ATR measure what they claim', () => {
  assert.ok(Math.abs((slope(trendUp, 20) ?? 0) - 0.5) < 1e-6, 'half a dollar a bar');
  assert.ok(Math.abs((slope(chop, 20) ?? 0)) < 0.2, 'chop has no slope');
  assert.ok((atr(trendUp, 14) ?? 0) > 0);
  assert.equal(atr(trendUp.slice(0, 5), 14), null, 'not enough bars');
});

test('features are volatility-normalised, not price-level dependent', () => {
  const low = Array.from({ length: 200 }, (_, i) => bar(2000 + i * 0.25, 0.5));
  const high = Array.from({ length: 200 }, (_, i) => bar(4400 + i * 0.5, 1));
  const a = features(low)!, b = features(high)!;
  assert.ok(a && b);
  assert.ok(Math.abs(a.trend_fast - b.trend_fast) < 0.25, 'same shape at $2000 and $4400');
  assert.ok(a.range_pos > 0.8 && b.range_pos > 0.8, 'both at the top of their range');
});

test('labels walk the path: target before stop, and never both', () => {
  const g = { tpPips: 45, slPips: 35, horizonBars: 20, pip: 0.1 };
  const up: Bar[] = [bar(4350), ...Array.from({ length: 20 }, (_, i) => bar(4350 + (i + 1) * 0.5))];
  assert.equal(labelPath(up, 0, 'buy', g), 1, 'target hit first');
  assert.equal(labelPath(up, 0, 'sell', g), 0, 'the same path stops a short out');
  const nowhere: Bar[] = Array.from({ length: 25 }, () => bar(4350, 0.2));
  assert.equal(labelPath(nowhere, 0, 'buy', g), null, 'neither level reached → not a training row');
  const bothInOneBar: Bar[] = [bar(4350), { o: 4350, h: 4360, l: 4340, c: 4350 }];
  assert.equal(labelPath(bothInOneBar, 0, 'buy', g), 0, 'ambiguous bar counts as the loss');
});

test('break-even and expectancy are the honest bar for a trade', () => {
  assert.ok(Math.abs(breakEvenRate({ tpPips: 45, slPips: 35 }) - 0.4375) < 1e-9);
  assert.ok(expectancy(0.4375, { tpPips: 45, slPips: 35 }, 0) < 1e-9, 'break-even wins nothing');
  assert.ok(expectancy(0.55, { tpPips: 45, slPips: 35 }, 3) > 0, 'a real edge pays after costs');
  assert.ok(expectancy(0.45, { tpPips: 45, slPips: 35 }, 3) < 0, 'a thin edge does not survive costs');
});

test('the fit recovers a signal that is really there', () => {
  // y depends on feature 0; the fit should find it and score well out of sample.
  const rows: number[][] = [], y: number[] = [];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 600; i++) {
    const x0 = rnd() * 2 - 1, x1 = rnd() * 2 - 1;
    rows.push([x0, x1]);
    y.push(sigmoid(3 * x0) > rnd() ? 1 : 0);
  }
  const { mean, sd, z } = standardise(rows);
  const { weights, bias } = fitLogistic(z.slice(0, 450), y.slice(0, 450), { epochs: 400, lr: 0.3 });
  assert.ok(weights[0] > Math.abs(weights[1]), 'the real driver gets the weight');
  // score the held-out rows with the same standardisation the live model would apply
  const scores = z.slice(450).map((r) => sigmoid(bias + weights[0] * r[0] + weights[1] * r[1]));
  assert.ok(auc(scores, y.slice(450)) > 0.7, 'separates winners from losers out of sample');
  assert.equal(mean.length, 2); assert.equal(sd.length, 2);
});

test('no edge, no trade — the gate refuses a coin flip', () => {
  const zeros = new Array(11).fill(0), ones = new Array(11).fill(1);
  const flat: Model = { geometry: { tpPips: 45, slPips: 35, horizonBars: 20, pip: 0.1 }, side: 'buy', mean: zeros, sd: ones, weights: zeros, bias: 0, trained: { rows: 0, from: '', to: '', auc: 0.5, hitRate: 0.5, baseRate: 0.5 } };
  const f = features(chop)!;
  const d = shouldTake(flat, f);
  assert.equal(Math.abs(d.p - 0.5) < 1e-9, true, 'a zero model says 50/50');
  assert.equal(d.take, true, '50% beats the 43.75% break-even on a 45/35 geometry');
  const worse: Model = { ...flat, geometry: { tpPips: 30, slPips: 45, horizonBars: 20, pip: 0.1 } };
  assert.equal(shouldTake(worse, f).take, false, 'a 60% break-even geometry needs a real edge, not a coin flip');
});
