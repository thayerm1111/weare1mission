import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../auric/config/defaults";
import { efficiency, confirmedPivots, atr, detectRange, checkRangeValidity } from "../auric/engine/features";
import { classify, stepRegime } from "../auric/engine/regime";
import { sizePosition } from "../auric/engine/sizing";
import { checkBreakers, freshRiskState, recordClose } from "../auric/engine/breakers";
import { roundDownToStep, decimalsOf, toUnits, cmpAtTick } from "../auric/core/decimal";
import { netRewardRisk } from "../auric/engine/costs";
import { stopBuffer, selectTarget, tightenedStop } from "../auric/engine/protection";
import { aggregate, closedBars, mergeBars } from "../auric/market/bars";
import { evaluate, emptyEngineState } from "../auric/engine/evaluate";
import type { Bar, Features, InstrumentSpec } from "../auric/core/types";

const spec: InstrumentSpec = { tradableInstrumentId: "1", tradeRouteId: "1", infoRouteId: "2", name: "XAUUSD", contractSize: 100, lotStep: 0.01, minLot: 0.01, maxLot: 100, tickSize: 0.01, tickValue: null, priceDecimals: 2, currency: "USD", minStopDistance: null, raw: null };

test("decimal helpers are exact at tick size", () => {
  assert.equal(decimalsOf(0.01), 2); assert.equal(decimalsOf(0.001), 3); assert.equal(decimalsOf(1), 0);
  assert.equal(roundDownToStep(0.0199, 0.01), 0.01);
  assert.equal(roundDownToStep(0.1 + 0.2, 0.1), 0.3);
  assert.equal(toUnits(2345.67, 0.01), 234567);
  assert.equal(cmpAtTick(2345.670000001, 2345.67, 0.01), 0);
});

test("efficiency handles zero denominator explicitly", () => {
  const e = efficiency([1, 1, 1, 1, 1], 4);
  assert.equal(e.defined, false);
  const f = efficiency([1, 2, 3, 4, 5], 4);
  assert.equal(f.defined, true); assert.equal(f.value, 1);
  const g = efficiency([1, 2, 1, 2, 1], 4);
  assert.equal(g.value, 0);
});

test("pivots are only known after the confirmation delay (no backdating)", () => {
  const bars: Bar[] = [];
  const hs = [1, 2, 3, 10, 3, 2, 1, 2, 3, 4];
  hs.forEach((h, i) => bars.push({ t: i * 60000, o: h - 0.5, h, l: h - 1, c: h - 0.2 }));
  const p = confirmedPivots(bars, 3, 3);
  assert.equal(p.highs.length, 1);
  assert.equal(p.highs[0].barIndex, 3);
  assert.equal(p.highs[0].confirmedAtIndex, 6);
});

test("sizing: rounds down, never forces the minimum lot", () => {
  const ok = sizePosition({ side: "buy", entry: 2400, stop: 2397, equity: 1000, riskFraction: 0.005, spec, cfg: DEFAULT_CONFIG.sizing, accountCurrency: "USD" });
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.qty, 0.01); assert.ok(ok.estLoss <= 5); }
  const bad = sizePosition({ side: "buy", entry: 2400, stop: 2390, equity: 500, riskFraction: 0.0025, spec, cfg: DEFAULT_CONFIG.sizing, accountCurrency: "USD" });
  assert.equal(bad.ok, false);
  if (!bad.ok) { assert.equal(bad.code, "MIN_QTY_EXCEEDS_RISK"); assert.match(bad.explanation, /Minimum broker size 0.01 would risk \$/); }
  const mismatch = sizePosition({ side: "buy", entry: 2400, stop: 2397, equity: 1000, riskFraction: 0.005, spec: { ...spec, currency: "EUR" }, cfg: DEFAULT_CONFIG.sizing, accountCurrency: "USD" });
  assert.equal(mismatch.ok, false);
  const noSpec = sizePosition({ side: "buy", entry: 2400, stop: 2397, equity: 1000, riskFraction: 0.005, spec: { ...spec, contractSize: null }, cfg: DEFAULT_CONFIG.sizing, accountCurrency: "USD" });
  assert.equal(noSpec.ok, false);
});

test("risk fraction is clamped to the product range", () => {
  const r = sizePosition({ side: "buy", entry: 2400, stop: 2399, equity: 1000, riskFraction: 0.05, spec, cfg: DEFAULT_CONFIG.sizing, accountCurrency: "USD" });
  assert.ok(r.ok && r.riskBudget === 10);
});

test("breakers latch and persist through state; cooldown after 3 losses", () => {
  const cfg = DEFAULT_CONFIG.breakers; const now = Date.parse("2026-09-22T14:00:00Z");
  let s = freshRiskState(now, 1000, cfg);
  s = recordClose(s, -5, now, cfg); s = recordClose(s, -5, now, cfg); s = recordClose(s, -5, now, cfg);
  let v = checkBreakers(s, now + 1000, 985, cfg);
  assert.equal(v.verdict.ok, false); if (!v.verdict.ok) assert.equal(v.verdict.code, "COOLDOWN");
  s = recordClose(v.state, -10, now, cfg);
  v = checkBreakers(s, now + 31 * 60_000, 975, cfg);
  assert.equal(v.verdict.ok, false); if (!v.verdict.ok) { assert.equal(v.verdict.code, "DAILY_LOSS"); assert.equal(v.verdict.hard, true); }
  // next day the daily latch clears but a drawdown latch would not
  const tomorrow = now + 24 * 3600_000;
  v = checkBreakers(v.state, tomorrow, 975, cfg);
  assert.equal(v.verdict.ok, true);
  const dd = checkBreakers(freshRiskState(now, 1000, cfg), now + 1, 910, cfg);
  assert.equal(dd.verdict.ok, false); if (!dd.verdict.ok) assert.equal(dd.verdict.code, "DRAWDOWN");
  assert.equal(dd.state.latched?.needsReview, true);
});

test("net R:R does not double count spread; stop buffer = max(2 spread, 0.1 ATR, tick)", () => {
  assert.equal(stopBuffer(0.3, 2, 0.01, DEFAULT_CONFIG.protection), 0.6);
  assert.equal(stopBuffer(0.1, 5, 0.01, DEFAULT_CONFIG.protection), 0.5);
  const rr = netRewardRisk("buy", 2400.3, 2397.3, 2406.3, 0.15);
  assert.ok(rr > 1.8 && rr < 2);
});

test("target is capped by opposing structure and refused when room < $5", () => {
  const t = selectTarget("buy", 2400, 2412, 4, 0.01, DEFAULT_CONFIG.setups, 0.5);
  assert.ok(t && t.usd >= 4.8 && t.usd <= 5.5);
  const none = selectTarget("buy", 2400, 2404, 4, 0.01, DEFAULT_CONFIG.setups, 0.5);
  assert.equal(none, null);
});

test("stop modifications only tighten and never cross the market", () => {
  assert.equal(tightenedStop("buy", 2395, 2394, 2400, 2400.3, 0.01, 0.5), null);
  assert.equal(tightenedStop("buy", 2395, 2399.9, 2400, 2400.3, 0.01, 0.5), 2399.5);
});

test("regime hysteresis requires persistence", () => {
  const cfg = DEFAULT_CONFIG.regime;
  let s = stepRegime(null, { regime: "UPTREND", reasons: [] }, 1, cfg);
  s = stepRegime(s, { regime: "CHOP_OR_UNCERTAIN", reasons: [] }, 2, cfg);
  assert.equal(s.regime, "UPTREND"); assert.equal(s.pending, "CHOP_OR_UNCERTAIN");
  s = stepRegime(s, { regime: "CHOP_OR_UNCERTAIN", reasons: [] }, 3, cfg);
  assert.equal(s.regime, "CHOP_OR_UNCERTAIN");
});

test("classify: low efficiency alone is never a tradable range", () => {
  const base: Features = { asOf: 0, m1AsOf: 0, atrM5: 2, atrM1: 0.5, atrPercentile: 0.5, efficiency: 0.1, efficiencyDefined: true, emaSlopeAtr: 0, bodyRatioMean: 0.5, overlapMean: 0.4, pivotsHigh: [], pivotsLow: [], structure: "MIXED", range: null, spread: 0.2, quoteAgeMs: 100, h1Bias: "flat", m15Structure: "MIXED" };
  assert.equal(classify(base, DEFAULT_CONFIG.regime).regime, "CHOP_OR_UNCERTAIN");
  const withRange = { ...base, range: { id: "r", support: 2390, resistance: 2400, createdAtIndex: 0, createdAt: 0, touchesHigh: [1, 9], touchesLow: [4, 12], failedBreaks: 0, invalidated: false } };
  assert.equal(classify(withRange, DEFAULT_CONFIG.regime).regime, "ORDERLY_RANGE");
  const trend = { ...base, efficiency: 0.5, emaSlopeAtr: 0.4, structure: "HH_HL" as const };
  assert.equal(classify(trend, DEFAULT_CONFIG.regime).regime, "UPTREND");
  const conflict = { ...trend, emaSlopeAtr: -0.4 };
  assert.equal(classify(conflict, DEFAULT_CONFIG.regime).regime, "CHOP_OR_UNCERTAIN");
});

test("range boundaries are frozen and invalidated, never redrawn", () => {
  const bars: Bar[] = []; let t = 0;
  const pattern = [2400, 2405, 2410, 2405, 2400, 2395, 2390, 2395, 2400, 2405, 2410, 2405, 2400, 2395, 2390, 2395, 2400, 2405, 2410, 2405, 2400, 2395, 2390, 2395, 2400];
  for (const p of pattern) bars.push({ t: t += 300000, o: p, h: p + 1, l: p - 1, c: p });
  const piv = confirmedPivots(bars, 3, 3);
  const a = atr(bars, 14);
  const r = detectRange(bars, piv.highs, piv.lows, a, DEFAULT_CONFIG.regime, bars.length - 1);
  assert.ok(r, "range detected");
  const inv = checkRangeValidity(r!, { t: 1, o: 2420, h: 2425, l: 2419, c: 2424 }, a);
  assert.equal(inv.invalidated, true); assert.equal(inv.support, r!.support);
});

test("bars: aggregate returns closed buckets only; merge handles duplicates and out-of-order", () => {
  const m1: Bar[] = []; for (let i = 0; i < 12; i++) m1.push({ t: i * 60000, o: 1, h: 2, l: 0.5, c: 1.5 });
  assert.equal(aggregate(m1, 5, true, 12 * 60000).length, 2);
  assert.equal(aggregate(m1, 5, false).length, 3);
  const m = mergeBars(m1, [{ t: 3 * 60000, o: 1, h: 3, l: 0.5, c: 2 }, { t: 12 * 60000, o: 1, h: 2, l: 0.5, c: 1 }, { t: 2 * 60000, o: 1, h: 2, l: 0.5, c: 1.5 }]);
  assert.equal(m.added, 1); assert.equal(m.replaced, 1); assert.equal(m.bars.length, 13);
  assert.equal(closedBars(m1, 60000, 5 * 60000 + 1000).length, 5);
});

test("evaluate: no broker quote → no candidate, explicit rejection", () => {
  const m1: Bar[] = []; for (let i = 0; i < 600; i++) { const p = 2400 + Math.sin(i / 20) * 5; m1.push({ t: i * 60000, o: p, h: p + 0.4, l: p - 0.4, c: p + 0.1 }); }
  const out = evaluate({ cfg: DEFAULT_CONFIG, m1, m5: aggregate(m1, 5, true, 600 * 60000), m15: aggregate(m1, 15, true, 600 * 60000), h1: aggregate(m1, 60, true, 600 * 60000), quote: null, tick: 0.01, contractSize: 100, now: 600 * 60000 }, emptyEngineState());
  assert.equal(out.decision.kind, "none");
  assert.ok(out.decision.rejections.some((r) => r.code === "NO_BROKER_QUOTE"));
  assert.ok(out.computeMs < 50);
});
