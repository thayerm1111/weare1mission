/**
 * THE DIRECTION MODEL — logistic regression, fitted on the desk's own two years of gold candles.
 *
 * For a given trade geometry (target and stop in pips) the model estimates the probability that price reaches
 * the TARGET before the STOP. That single number is what makes the call: it is compared against the geometry's
 * break-even rate, and a trade is only worth taking when the edge covers the spread and commission too.
 *
 * Deliberately a simple, inspectable model: 11 features, one weight each, L2-regularised, standardised inputs.
 * It can be read, argued with and re-fitted; nothing about it is a black box, and it never claims a probability
 * it did not measure. Fitting lives in research/trainQuant.ts; this file only defines the maths.
 */
import { FEATURE_NAMES, toVector, type Features } from "./features";
import { breakEvenRate, expectancy, type Geometry } from "./label";

export type Model = {
  geometry: Geometry;
  side: "buy" | "sell";
  mean: number[];
  sd: number[];
  weights: number[];
  bias: number;
  trained: { rows: number; from: string; to: string; auc: number; hitRate: number; baseRate: number };
};

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));

/** P(target before stop) for this bar, per the fitted model. */
export function probability(m: Model, f: Features): number {
  const x = toVector(f);
  let z = m.bias;
  for (let i = 0; i < x.length; i++) {
    const sd = m.sd[i] || 1;
    z += m.weights[i] * ((x[i] - (m.mean[i] ?? 0)) / sd);
  }
  return sigmoid(z);
}

/** The decision: take it only when the measured edge beats break-even by a margin AND pays for costs. */
export function shouldTake(m: Model, f: Features, opts: { marginPct?: number; costPips?: number } = {}): { take: boolean; p: number; edge: number; expectancyPips: number; breakEven: number } {
  const p = probability(m, f);
  const be = breakEvenRate(m.geometry);
  const margin = opts.marginPct ?? 0.04;                 // 4 points of probability above break-even
  const e = expectancy(p, m.geometry, opts.costPips ?? 3);
  return { take: p >= be + margin && e > 0, p, edge: p - be, expectancyPips: e, breakEven: be };
}

/** Standardise a dataset (returns the transform so the live model applies exactly the same one). */
export function standardise(rows: number[][]): { mean: number[]; sd: number[]; z: number[][] } {
  const n = rows.length, d = rows[0]?.length ?? 0;
  const mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of rows) for (let i = 0; i < d; i++) mean[i] += r[i] / n;
  for (const r of rows) for (let i = 0; i < d; i++) sd[i] += ((r[i] - mean[i]) ** 2) / n;
  for (let i = 0; i < d; i++) sd[i] = Math.sqrt(sd[i]) || 1;
  return { mean, sd, z: rows.map((r) => r.map((v, i) => (v - mean[i]) / sd[i])) };
}

/** Plain gradient-descent logistic fit with L2. Small, deterministic, no dependencies. */
export function fitLogistic(z: number[][], y: number[], opts: { epochs?: number; lr?: number; l2?: number } = {}): { weights: number[]; bias: number } {
  const epochs = opts.epochs ?? 300, lr = opts.lr ?? 0.1, l2 = opts.l2 ?? 1e-3;
  const n = z.length, d = z[0]?.length ?? 0;
  const w = new Array(d).fill(0); let b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let s = b; for (let j = 0; j < d; j++) s += w[j] * z[i][j];
      const err = sigmoid(s) - y[i];
      for (let j = 0; j < d; j++) gw[j] += (err * z[i][j]) / n;
      gb += err / n;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] + l2 * w[j]);
    b -= lr * gb;
  }
  return { weights: w, bias: b };
}

/** Area under the ROC curve — how well the scores separate winners from losers. 0.5 = no skill. */
export function auc(scores: number[], y: number[]): number {
  const pairs = scores.map((s, i) => ({ s, y: y[i] })).sort((a, b) => a.s - b.s);
  let pos = 0, neg = 0, rankSum = 0;
  pairs.forEach((p, i) => { if (p.y === 1) { pos += 1; rankSum += i + 1; } else neg += 1; });
  if (!pos || !neg) return 0.5;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export const FEATURES = FEATURE_NAMES;
