import assert from "node:assert/strict";
import test from "node:test";
import { NITROUS_AGGRESSIVE_CONFIG } from "../nitrous/config";
import { sizeNitrousPosition } from "../nitrous/sizing";
import { protectionMatches } from "../nitrous/submit";
import { sizePosition, type SizingInput } from "../rapid/risk/sizing";

const input: SizingInput = {
  side: "buy", executable: 3676.58, stop: 3672.48, equity: 300_000, riskPct: 3,
  remainingSessionRisk: 7638.40, conversionRate: 1, cfg: NITROUS_AGGRESSIVE_CONFIG,
  spec: {
    tradableInstrumentId: "gold", tradeRouteId: "trade", infoRouteId: "info", brokerSymbol: "XAUUSD",
    contractSize: 100, lotStep: 0.01, minLot: 0.01, maxLot: 1000, tickSize: 0.01, tickValue: null,
    priceDecimals: 2, currency: "USD", minStopDistance: null, raw: null,
  },
};
const band = { entryBandLow: 3676.4823548214285, entryBandHigh: 3677.495625178571 };

test("the November 27 in-band fill can retain its native protection within the original risk limit", () => {
  const sized = sizeNitrousPosition(input, band);
  const old = sizePosition(input);
  assert.ok(sized.ok && old.ok);
  assert.equal(old.qty, 17.36);
  assert.equal(sized.qty, 14.63);
  assert.equal(sized.entryWorst, 3677.50);
  assert.equal(sized.riskBudget, old.riskBudget);
  assert.ok(sized.estimatedRisk <= sized.riskBudget);

  const guard = { side: input.side, qty: sized.qty, stop: input.stop, target: 3691.98,
    strategyId: "NITROUS:test", tick: 0.01, riskBudget: sized.estimatedRisk, valuePerPricePerLot: sized.valuePerPricePerLot,
    commissionPerLot: 10, exitAllowance: 0.10 };
  const filled = { positionId: "position", strategyId: guard.strategyId, side: guard.side, qty: guard.qty,
    entry: 3676.73, stopLoss: guard.stop, takeProfit: guard.target };
  assert.equal(protectionMatches({ ...filled, qty: old.qty }, { ...guard, qty: old.qty, riskBudget: old.riskBudget }), false);
  assert.equal(protectionMatches(filled, guard), true);
  assert.equal(protectionMatches({ ...filled, entry: 3677.49 }, guard), true);
  assert.equal(protectionMatches({ ...filled, entry: 3677.52 }, guard), false);
  assert.equal(protectionMatches({ ...filled, stopLoss: null }, guard), false);
});

test("the earlier breakout retains its favorable fill and the same broker stop at the reserved risk", () => {
  const earlier = { ...input, executable: 3583.89, stop: 3576.87, remainingSessionRisk: 7700.64 };
  const sized = sizeNitrousPosition(earlier, { entryBandLow: 3582.415318428571, entryBandHigh: 3584.0895215714286 });
  const old = sizePosition(earlier);
  assert.ok(sized.ok && old.ok);
  assert.equal(old.qty, 10.52);
  assert.equal(sized.entryWorst, 3584.09);
  assert.equal(sized.qty, 10.37);
  const guard = { side: earlier.side, qty: sized.qty, stop: earlier.stop, target: 3598.25,
    strategyId: "NITROUS:test", tick: 0.01, riskBudget: sized.estimatedRisk, valuePerPricePerLot: sized.valuePerPricePerLot,
    commissionPerLot: 10, exitAllowance: 0.10 };
  assert.equal(protectionMatches({ positionId: "position", strategyId: guard.strategyId, side: guard.side,
    qty: guard.qty, entry: 3583.86, stopLoss: guard.stop, takeProfit: guard.target }, guard), true);
});

test("sells size to the lower edge and round outward on the instrument's own grid", () => {
  const sell = { ...input, side: "sell" as const, executable: 3650, stop: 3655,
    spec: { ...input.spec, tickSize: 0.05 } };
  const sized = sizeNitrousPosition(sell, { entryBandLow: 3648.527, entryBandHigh: 3650.25 });
  assert.ok(sized.ok);
  assert.equal(sized.entryWorst, 3648.50);
  assert.ok(sized.estimatedRisk <= sized.riskBudget);
});

test("near the adverse edge sizing retains the existing minimum slippage allowance", () => {
  const sized = sizeNitrousPosition(input, { entryBandLow: 3675, entryBandHigh: 3676.60 });
  assert.deepEqual(sized, sizePosition(input));
});

test("invalid bands, unavailable tick size and a minimum lot above budget block the order", () => {
  for (const invalid of [
    { ...band, entryBandHigh: NaN }, { ...band, entryBandLow: 3677 }, { ...band, entryBandHigh: 3675 },
  ]) assert.equal(sizeNitrousPosition(input, invalid).ok, false);
  assert.equal(sizeNitrousPosition({ ...input, spec: { ...input.spec, tickSize: null } }, band).ok, false);
  assert.equal(sizeNitrousPosition({ ...input, remainingSessionRisk: 5 }, band).ok, false);
});
