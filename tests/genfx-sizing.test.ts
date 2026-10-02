import { test } from "node:test";
import assert from "node:assert/strict";
import { PAIRS } from "../src/lib/genfx/pairs";
import { sizeFx, valuePerPrice, notionalPerLot, cappedRiskPct, usdJpyOk, FX_LOT_UNITS } from "../src/lib/genfx/sizing";
import { DEFAULT_CONFIG } from "../src/lib/genfx/control";

/*
 * How many lots. Every expected number below is worked by hand in the comment beside it, from two
 * facts: a standard lot is 100,000 units of the first currency, and a pip of GBP/JPY is paid in yen.
 */
const E = PAIRS.EURUSD, J = PAIRS.GBPJPY;
const limits = { maxMinLotRiskPct: DEFAULT_CONFIG.maxMinLotRiskPct, maxLots: DEFAULT_CONFIG.maxLots, maxLeverage: DEFAULT_CONFIG.maxLeverage };

test("what a pip is worth", () => {
  assert.equal(FX_LOT_UNITS, 100_000);
  assert.equal(valuePerPrice(E), 100_000);                         // 1.0 of EUR/USD on one lot = $100,000 → a pip = $10
  assert.ok(Math.abs((valuePerPrice(J, 150) as number) - 666.6667) < 0.001);   // ¥100,000 ÷ 150 → a pip (0.01) = $6.67
  assert.equal(valuePerPrice(J), null);
  assert.equal(valuePerPrice(J, 0), null);
  assert.equal(notionalPerLot(E, 1.08), 108_000);
  assert.ok(Math.abs((notionalPerLot(J, 201, 150) as number) - 134_000) < 0.01);   // £100,000 = ¥20.1M = $134,000
  assert.equal(notionalPerLot(J, 201), null);
  assert.equal(notionalPerLot(E, 0), null);
});

test("EUR/USD: 1% of $10,000 on a 20-pip stop is half a lot", () => {
  // $10 a pip per lot × 20 pips = $200 a lot. $100 ÷ $200 = 0.50.
  const s = sizeFx(E, { entry: 1.0850, stop: 1.0830, equity: 10_000, riskPct: 1, limits });
  assert.equal(s.ok, true);
  assert.equal(s.lots, 0.5);
  assert.equal(s.stopPips, 20);
  assert.equal(s.pipValue, 10);
  assert.equal(s.riskUsd, 100);
  assert.equal(s.estLossAtStop, 100);
  assert.equal(s.notionalUsd, 54_250);
  assert.equal(s.bound, "risk");
});

test("GBP/JPY: a 30-pip stop at USD/JPY 150 is $200 a lot, so $100 of risk is half a lot", () => {
  // 30 pips = ¥0.30 × 100,000 = ¥30,000 a lot = $200 at 150.
  const s = sizeFx(J, { entry: 201.50, stop: 201.20, equity: 10_000, riskPct: 1, usdJpy: 150, limits });
  assert.equal(s.ok, true);
  assert.equal(s.lots, 0.5);
  assert.equal(s.stopPips, 30);
  assert.ok(Math.abs(s.pipValue - 6.6667) < 0.0001);
  assert.ok(Math.abs(s.estLossAtStop - 100) < 0.01);
  // The same trade when the dollar buys ¥160: a lot loses less in dollars, so the size is a little larger.
  assert.equal(sizeFx(J, { entry: 201.50, stop: 201.20, equity: 10_000, riskPct: 1, usdJpy: 160, limits }).lots, 0.53);
});

test("a yen pair is never sized without a believable USD/JPY rate", () => {
  for (const usdJpy of [undefined, null, 0, NaN, 1.5, 15, 59.9, 401, 15000]) {
    const s = sizeFx(J, { entry: 201.50, stop: 201.20, equity: 10_000, riskPct: 1, usdJpy: usdJpy as number | null | undefined, limits });
    assert.equal(s.ok, false, String(usdJpy));
    assert.equal(s.reason, "no_usdjpy_rate");
    assert.equal(s.lots, 0);
  }
  assert.ok(usdJpyOk(150) && usdJpyOk(60) && usdJpyOk(400));
  // EUR/USD needs no rate at all.
  assert.equal(sizeFx(E, { entry: 1.085, stop: 1.083, equity: 10_000, riskPct: 1, usdJpy: null, limits }).ok, true);
});

test("the size is rounded DOWN to the broker's step, never up", () => {
  // $100 ÷ ($10 × 13 pips) = 0.769 lots → 0.76.
  assert.equal(sizeFx(E, { entry: 1.0850, stop: 1.0837, equity: 10_000, riskPct: 1, limits }).lots, 0.76);
  // A broker that trades in tenths: 0.7.
  assert.equal(sizeFx(E, { entry: 1.0850, stop: 1.0837, equity: 10_000, riskPct: 1, limits, broker: { quantityStep: 0.1, minQuantity: 0.1 } }).lots, 0.7);
  const s = sizeFx(E, { entry: 1.0850, stop: 1.0837, equity: 10_000, riskPct: 1, limits });
  assert.ok(s.estLossAtStop <= s.riskUsd + 1e-9, "never risks more than was asked for");
});

test("a tight stop cannot turn into an absurd position: leverage and lot ceilings", () => {
  // The August run: a fixed % over a 4-pip stop. 2% of $50,000 = $1,000 ÷ ($10 × 4) = 25 lots = $2.7M on a $50k account.
  // Here one position may control at most 20× the account: $1,000,000 ÷ $108,500 a lot = 9.21 lots.
  const s = sizeFx(E, { entry: 1.0850, stop: 1.0846, equity: 50_000, riskPct: 2, limits });
  assert.equal(s.ok, true);
  assert.equal(s.bound, "leverage");
  assert.equal(s.lots, 9.21);
  assert.ok(s.notionalUsd <= 50_000 * 20 + 1);
  assert.ok(s.estLossAtStop < s.riskUsd, "the cap can only lower the risk");
  // A very large account: the lot ceiling binds before leverage does.
  const big = sizeFx(E, { entry: 1.0850, stop: 1.0840, equity: 2_000_000, riskPct: 1, limits });
  assert.equal(big.bound, "max_lots");
  assert.equal(big.lots, 50);
  // The owner's setting moves both.
  assert.equal(sizeFx(E, { entry: 1.0850, stop: 1.0846, equity: 50_000, riskPct: 2, limits: { ...limits, maxLeverage: 5 } }).lots, 2.3);
  assert.equal(sizeFx(E, { entry: 1.0850, stop: 1.0840, equity: 2_000_000, riskPct: 1, limits: { ...limits, maxLots: 10 } }).lots, 10);
});

test("small accounts: the desk's caps, and the minimum lot only where it is still a small trade", () => {
  assert.equal(cappedRiskPct(5, 10_000), 5);
  assert.equal(cappedRiskPct(5, 1_999), 2);
  assert.equal(cappedRiskPct(1, 1_999), 1);
  assert.equal(cappedRiskPct(5, 600), 0.5);
  assert.equal(cappedRiskPct(0.25, 600), 0.25);

  // $1,500 at 5% → capped to 2% = $30 on a 20-pip stop ($200 a lot) = 0.15 lots.
  const a = sizeFx(E, { entry: 1.0850, stop: 1.0830, equity: 1_500, riskPct: 5, limits });
  assert.equal(a.riskPct, 2);
  assert.equal(a.lots, 0.15);

  // $500 at 1% → capped to 0.5% = $2.50; 0.0125 lots → 0.01. It fits without the minimum-lot rule.
  const b = sizeFx(E, { entry: 1.0850, stop: 1.0830, equity: 500, riskPct: 1, limits });
  assert.equal(b.lots, 0.01);
  assert.equal(b.bound, "risk");

  // $300 at 0.5% = $1.50 asks for 0.0075 lots — less than the broker places. The minimum lot would
  // lose $2 = 0.67% of the account: over the ask, well under the 5% line. Taken, and said so.
  const c = sizeFx(E, { entry: 1.0850, stop: 1.0830, equity: 300, riskPct: 0.5, limits });
  assert.equal(c.ok, true);
  assert.equal(c.lots, 0.01);
  assert.equal(c.bound, "min_lot");
  assert.equal(c.estLossAtStop, 2);

  // $250 on a 150-pip stop: the minimum lot loses $15 = 6% of the account. Sits out.
  const d = sizeFx(E, { entry: 1.0850, stop: 1.0700, equity: 250, riskPct: 0.5, limits });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "min_lot_over_risk");
  assert.equal(d.estLossAtStop, 15);

  // $40: even the minimum lot is $1,085 of exposure — 27× the account. Sits out.
  const e = sizeFx(E, { entry: 1.0850, stop: 1.0830, equity: 40, riskPct: 0.5, limits });
  assert.equal(e.ok, false);
  assert.equal(e.reason, "min_lot_over_leverage");
});

test("it refuses to guess", () => {
  assert.equal(sizeFx(E, { entry: 1.085, stop: 1.085, equity: 10_000, riskPct: 1, limits }).reason, "no_stop_distance");
  assert.equal(sizeFx(E, { entry: 0, stop: 1.085, equity: 10_000, riskPct: 1, limits }).reason, "no_stop_distance");
  assert.equal(sizeFx(E, { entry: 1.085, stop: NaN, equity: 10_000, riskPct: 1, limits }).reason, "no_stop_distance");
  assert.equal(sizeFx(E, { entry: 1.085, stop: 1.083, equity: 0, riskPct: 1, limits }).reason, "no_equity");
  assert.equal(sizeFx(E, { entry: 1.085, stop: 1.083, equity: -5, riskPct: 1, limits }).reason, "no_equity");
  assert.equal(sizeFx(E, { entry: 1.085, stop: 1.083, equity: 10_000, riskPct: 0, limits }).reason, "no_risk_pct");
});

test("a sell is sized the same as a buy over the same distance", () => {
  const buy = sizeFx(J, { entry: 201.50, stop: 201.25, equity: 25_000, riskPct: 1, usdJpy: 152.4, limits });
  const sell = sizeFx(J, { entry: 201.50, stop: 201.75, equity: 25_000, riskPct: 1, usdJpy: 152.4, limits });
  assert.equal(buy.lots, sell.lots);
  assert.equal(buy.stopPips, 25);
});
