import test from "node:test";
import assert from "node:assert/strict";
import { planEntry, protectionAfterFill, type InstrumentSpec, type OpenExposure } from "../src/lib/fxscalper/plan";
import { applySettingsPatch, DEFAULT_SETTINGS, settingsBlockers, settingsFrom, type Settings } from "../src/lib/fxscalper/settings";
import { convert, floorLots, pipValuePerLot, rate, snap } from "../src/lib/fxscalper/money";
import { eligibleLots, estimatedCompensation, lossStreak, streakPauseUntil, tradePnl } from "../src/lib/fxscalper/risk";
import { entryBlackout, fxDayKey, fxDayStart } from "../src/lib/fxscalper/clock";
import { pairOf } from "../src/lib/fxscalper/pairs";

/**
 * FX Scalper: the order arithmetic — target, stop, costs, size, the risk caps — and the settings rules.
 * Owner 10-23: target 10 executable pips, stop 3–5 pips, 120-second time exit, costs ≤ 1.5 pips.
 */

const withCosts = (over: Partial<Settings["costs"]> = {}): Settings => ({ ...DEFAULT_SETTINGS, costs: { ...DEFAULT_SETTINGS.costs, commissionPerLotPerSide: 3, confirmed: true, ...over } });

const EURUSD: InstrumentSpec = {
  pair: "EURUSD", brokerSymbol: "EURUSD", tradableInstrumentId: "1", tradeRouteId: "10", infoRouteId: "11",
  lotSize: 100_000, lotStep: 0.01, minLot: 0.01, maxLot: 100, tickSize: 0.00001, pipSize: 0.0001, decimals: 5,
  barSource: "BID", quote: "USD", base: "EUR", leverage: 500,
};
const USDJPY: InstrumentSpec = { ...EURUSD, pair: "USDJPY", brokerSymbol: "USDJPY", tickSize: 0.001, pipSize: 0.01, decimals: 3, quote: "JPY", base: "USD" };
const rates = { EURUSD: { bid: 1.08, ask: 1.0801 }, USDJPY: { bid: 150, ask: 150.01 } };
const account = { currency: "USD", equity: 100_000, eligibleEquity: 100_000, availableFunds: 90_000, grossNotional: 0 };

const base = (over: Partial<Parameters<typeof planEntry>[0]> = {}) => planEntry({
  side: "buy", spec: EURUSD, quote: { bid: 1.08, ask: 1.08004 }, atr: 0.00004, settings: withCosts(), slippagePips: 0.3,
  account, open: [], rates, ...over,
});

test("defaults are the owner's numbers: 10-pip target, 3-pip minimum stop, 5-pip maximum, 120 s, 1.5-pip costs", () => {
  const s = DEFAULT_SETTINGS;
  assert.equal(s.strategy.tpPips, 10);
  assert.equal(s.strategy.tpMode, "executable");
  assert.equal(s.strategy.stopMinPips, 3);
  assert.equal(s.strategy.stopAtrMult, 0.5);
  assert.equal(s.strategy.stopSpreadMult, 2);
  assert.equal(s.strategy.maxHoldSec, 120);
  assert.equal(s.strategy.signalExpirySec, 10);
  assert.equal(s.strategy.maxSignalDriftPips, 1);
  for (const p of Object.values(s.pairs)) { assert.equal(p.maxCostPips, 1.5); assert.equal(p.maxStopPips, 5); assert.equal(p.enabled, true); }
  assert.deepEqual([s.risk.riskPerTradePct, s.risk.maxOpenRiskPct, s.risk.maxConcurrent, s.risk.maxLotsPerTrade, s.risk.maxGrossNotionalX, s.risk.dailyLossLimitPct, s.risk.lossStreakCount, s.risk.lossStreakPauseMin, s.risk.maxSameCurrencyDirection], [0.1, 0.3, 3, 0.1, 5, 1, 3, 15, 2]);
  assert.equal(s.costs.slippageAllowancePips, 0.3);
  assert.equal(s.costs.commissionPerLotPerSide, null, "commission is never assumed to be zero");
});

test("BUY: target 10 pips above the ask it was priced from; stop 3 pips below (the minimum)", () => {
  const r = base();
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.plan.entryRef, 1.08004);
  assert.equal(r.plan.targetPrice, 1.08104);
  assert.equal(r.plan.targetPips, 10);
  assert.equal(r.plan.stopPrice, 1.07974);
  assert.equal(r.plan.stopPips, 3);
});

test("SELL: target 10 pips below the bid; stop above it", () => {
  const r = base({ side: "sell" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.plan.entryRef, 1.08);
  assert.equal(r.plan.targetPrice, 1.079);
  assert.equal(r.plan.stopPrice, 1.0803);
});

test("stop = max(3 pips, 0.5 × ATR, 2 × spread), rounded OUT to the tick; wider than 5 pips → no trade", () => {
  const atr = base({ atr: 0.0008 });                         // 0.5 × 8 pips = 4 pips
  assert.ok(atr.ok && atr.plan.stopPips === 4, "ATR sets the stop");
  // 2 × spread only binds when the spread is over 1.5 pips — i.e. past the default cost limit — so the
  // owner's limit is raised here to see it work: a 1.8-pip spread → a 3.6-pip stop.
  const loose = withCosts({ commissionPerLotPerSide: 0 });
  const spread = base({ quote: { bid: 1.08, ask: 1.08018 }, settings: { ...loose, pairs: { ...loose.pairs, EURUSD: { ...loose.pairs.EURUSD, maxCostPips: 3 } } } });
  assert.ok(spread.ok && Math.abs(spread.plan.stopPips - 3.6) < 1e-9, "the spread sets the stop");
  assert.ok(!base({ quote: { bid: 1.08, ask: 1.08018 } }).ok, "and with the default 1.5-pip cost limit that spread is no trade at all");
  const odd = base({ atr: 0.000623 });                        // 3.115 pips → rounded out to 3.2 (tick 0.1 pip)
  assert.ok(odd.ok && Math.abs(odd.plan.stopPips - 3.2) < 1e-9, `stop ${odd.ok && odd.plan.stopPips}`);
  const wide = base({ atr: 0.0012 });                         // 6 pips
  assert.ok(!wide.ok && wide.code === "stop_over_max");
  const maxed = base({ settings: { ...withCosts(), pairs: { ...DEFAULT_SETTINGS.pairs, EURUSD: { ...DEFAULT_SETTINGS.pairs.EURUSD, maxStopPips: 7 } } }, atr: 0.0012 });
  assert.ok(maxed.ok, "the pair's own maximum, when the owner raises it");
});

test("the target in 'after fees' mode is widened by the round-trip charges, and labelled", () => {
  const s = withCosts();
  const r = base({ settings: { ...s, strategy: { ...s.strategy, tpMode: "after_fees" } } });
  assert.ok(r.ok);
  if (!r.ok) return;
  // $6 round trip on a $10/pip lot = 0.6 pip.
  assert.ok(Math.abs(r.plan.targetPips - 10.6) < 1e-9);
  assert.equal(r.plan.tpMode, "after_fees");
});

test("costs: spread + round-trip commission + other + slippage must be ≤ 1.5 pips; the spread is not counted again in the target", () => {
  const ok = base();
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.plan.costs.spreadPips, 0.4);
    assert.equal(ok.plan.costs.commissionPips, 0.6);
    assert.equal(ok.plan.costs.totalPips, 1.3);
    assert.ok(Math.abs(ok.plan.estGrossAtTarget - 0.1 * 10 * 10) < 1e-9, "gross at target = lots × 10 pips × $10");
    assert.ok(Math.abs(ok.plan.estNetAtTarget - (10 - 0.6)) < 1e-9, "net = gross − commission only");
  }
  const wide = base({ quote: { bid: 1.08, ask: 1.08007 } }); // 0.7 + 0.6 + 0.3 = 1.6
  assert.ok(!wide.ok && wide.code === "cost_over_limit");
});

test("no commission entered, or costs not confirmed: no trade (never assumed zero)", () => {
  const unset = base({ settings: { ...DEFAULT_SETTINGS } });
  assert.ok(!unset.ok && unset.code === "costs_unset");
  const unconfirmed = base({ settings: withCosts({ confirmed: false }) });
  assert.ok(!unconfirmed.ok && unconfirmed.code === "costs_unconfirmed");
  assert.ok(settingsBlockers(DEFAULT_SETTINGS).length >= 2);
  assert.deepEqual(settingsBlockers(withCosts()), []);
  const zero = base({ settings: withCosts({ commissionPerLotPerSide: 0 }) });
  assert.ok(zero.ok, "an explicitly entered and confirmed zero is accepted");
});

test("size: risk budget, the 0.10-lot cap, notional and margin caps, rounded DOWN to the lot step", () => {
  const r = base();
  assert.ok(r.ok);
  if (!r.ok) return;
  // 0.10% of $100,000 = $100; loss per lot = (3 + 0.3) × $10 + $6 = $39 → 2.56 lots, capped at 0.10.
  assert.equal(r.plan.lots, 0.1);
  assert.equal(r.plan.bound, "lot_cap");
  const small = base({ account: { ...account, equity: 3000, eligibleEquity: 3000, availableFunds: 3000 } });
  // $3 budget / $39 per lot = 0.0769 → 0.07 (rounded down, never up).
  assert.ok(small.ok && small.plan.lots === 0.07 && small.plan.bound === "risk");
  assert.ok(small.ok && Math.abs(small.plan.riskCash - 0.07 * 39) < 1e-9, "the cash at risk counts slippage and both sides' commission");
  const tiny = base({ account: { ...account, equity: 300, eligibleEquity: 300, availableFunds: 300 } });
  // $0.30 budget / $39 = 0.0077 lots < 0.01 minimum → no trade (the minimum is not forced).
  assert.ok(!tiny.ok && tiny.code === "below_min_lot");
  const notional = base({ account: { ...account, grossNotional: 499_000 } });
  // Room = 5 × 100k − 499k = $1,000 → 1,000 / 108,004 per lot = 0.009 → below the minimum.
  assert.ok(!notional.ok && notional.code === "below_min_lot" && (notional.detail as { bound: string }).bound === "notional");
  const margin = base({ account: { ...account, availableFunds: 50_100 } });
  // Keep 50% of $100k free → $100 of room; margin per lot = 108,004 / 500 = $216 → 0.46 lots → still capped at 0.10.
  assert.ok(margin.ok && margin.plan.lots === 0.1);
  const noMargin = base({ account: { ...account, availableFunds: 50_000 } });
  assert.ok(!noMargin.ok && (noMargin.detail as { bound: string }).bound === "margin");
});

test("open-risk cap: what is already at risk leaves less room", () => {
  const open: OpenExposure[] = [{ pair: "GBPJPY", side: "buy", riskCash: 150 }, { pair: "EURJPY", side: "sell", riskCash: 149 }];
  const r = base({ open });
  // Cap 0.30% = $300; $299 used → $1 room → 0.025 lots → 0.02.
  assert.ok(r.ok && r.plan.lots === 0.02 && r.plan.bound === "open_risk");
});

test("at most 3 bot trades, one per pair, and at most 2 the same way in one currency", () => {
  const three: OpenExposure[] = [{ pair: "GBPUSD", side: "buy", riskCash: 1 }, { pair: "USDJPY", side: "buy", riskCash: 1 }, { pair: "AUDUSD", side: "sell", riskCash: 1 }];
  assert.ok(!base({ open: three }).ok);
  const busy = base({ open: [{ pair: "EURUSD", side: "sell", riskCash: 1 }] });
  assert.ok(!busy.ok && busy.code === "pair_busy");
  // Already short USD twice (long GBPUSD, long AUDUSD): a long EURUSD is a third short USD.
  const usd = base({ open: [{ pair: "GBPUSD", side: "buy", riskCash: 1 }, { pair: "AUDUSD", side: "buy", riskCash: 1 }] });
  assert.ok(!usd.ok && usd.code === "currency_exposure");
  // A short EURUSD is long USD: allowed.
  assert.ok(base({ side: "sell", open: [{ pair: "GBPUSD", side: "buy", riskCash: 1 }, { pair: "AUDUSD", side: "buy", riskCash: 1 }] }).ok);
});

test("yen pairs: a pip is 0.01 and is worth 1,000 yen per lot, converted at the live USD/JPY", () => {
  const pv = pipValuePerLot({ lotSize: 100_000, pipSize: 0.01, quote: "JPY", base: "USD", leverage: 500 }, "USD", rates);
  assert.ok(pv != null && Math.abs(pv - 1000 / 150.005) < 1e-9);
  const r = base({ spec: USDJPY, quote: { bid: 150, ask: 150.002 }, atr: 0.004 });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  if (r.ok) {
    assert.equal(r.plan.targetPrice, 150.102);
    assert.equal(r.plan.stopPrice, 149.972);
    assert.ok(Math.abs(r.plan.costs.commissionPips - 0.9) < 0.01, "$6 round trip is 0.9 pip on a yen pair at 150");
  }
  assert.equal(pipValuePerLot({ lotSize: 100_000, pipSize: 0.01, quote: "JPY", base: "USD", leverage: 500 }, "USD", {}), null, "no rate, no number");
  const none = base({ spec: USDJPY, quote: { bid: 150, ask: 150.004 }, rates: {} });
  assert.ok(!none.ok && none.code === "no_rate");
});

test("currency conversion goes through USD when no pair joins the two currencies", () => {
  const r = { EURUSD: { bid: 1.1, ask: 1.1 }, USDCAD: { bid: 1.4, ask: 1.4 } };
  assert.ok(Math.abs((rate("EUR", "CAD", r) as number) - 1.54) < 1e-12);
  assert.ok(Math.abs((convert(10, "CAD", "USD", r) as number) - 10 / 1.4) < 1e-12);
  assert.equal(rate("XAU", "USD", r), null);
});

test("prices snap to the tick without floating-point leftovers; lots round down to the step", () => {
  assert.equal(snap(1.08 + 0.001, 0.00001, "nearest"), 1.081);
  assert.equal(snap(1.0800049, 0.00001, "down"), 1.08);
  assert.equal(snap(1.0800001, 0.00001, "up"), 1.08001);
  assert.equal(floorLots(0.129999, 0.01), 0.12);
  assert.equal(floorLots(0.13, 0.01), 0.13);
});

test("after the fill: the target moves to fill ± 10 pips; the stop only ever tightens", () => {
  // Filled 0.5 pip WORSE than planned: the stop comes up to the planned 3-pip distance.
  const worse = protectionAfterFill({ side: "buy", fill: 1.08009, attachedStop: 1.07974, plannedStopPips: 3, targetPips: 10, pipSize: 0.0001, tickSize: 0.00001 });
  assert.deepEqual(worse, { stop: 1.07979, target: 1.08109, stopMoved: true });
  // Filled BETTER: the attached stop stays (moving it down to keep 3 pips would widen it).
  const better = protectionAfterFill({ side: "buy", fill: 1.08, attachedStop: 1.07974, plannedStopPips: 3, targetPips: 10, pipSize: 0.0001, tickSize: 0.00001 });
  assert.deepEqual(better, { stop: 1.07974, target: 1.081, stopMoved: false });
  const sell = protectionAfterFill({ side: "sell", fill: 1.07995, attachedStop: 1.0803, plannedStopPips: 3, targetPips: 10, pipSize: 0.0001, tickSize: 0.00001 });
  assert.deepEqual(sell, { stop: 1.08025, target: 1.07895, stopMoved: true });
});

test("results come from fills: the spread is in the prices, commission is deducted once", () => {
  const p = tradePnl({ side: "buy", lots: 0.1, lotSize: 100_000, fill: 1.08004, exit: 1.08104, quoteCcy: "USD", accountCcy: "USD", rates, commissionPerLotPerSide: 3, otherRtPerLot: 0 });
  assert.ok(p);
  if (!p) return;
  assert.ok(Math.abs(p.gross - 10) < 1e-6);
  assert.ok(Math.abs(p.commission - 0.6) < 1e-12);
  assert.ok(Math.abs(p.net - 9.4) < 1e-6);
  const jpy = tradePnl({ side: "sell", lots: 0.1, lotSize: 100_000, fill: 150.0, exit: 150.03, quoteCcy: "JPY", accountCcy: "USD", rates, commissionPerLotPerSide: 3, otherRtPerLot: 0 });
  // 3 pips × 1,000 yen per pip per lot × 0.1 lot = 300 yen, at USD/JPY 150.005.
  assert.ok(jpy && jpy.gross < 0 && Math.abs(jpy.gross + 300 / 150.005) < 1e-6, "3 pips against a short, in dollars");
});

test("loss streak: 3 losses in a row pause entries 15 minutes from the last; a win resets; unknown counts as a loss", () => {
  const now = Date.UTC(2026, 9, 23, 14, 0);
  const at = (m: number) => now - m * 60_000;
  const closed = [{ closedAt: at(30), net: 5 }, { closedAt: at(10), net: -2 }, { closedAt: at(8), net: -1 }, { closedAt: at(5), net: null }];
  assert.equal(lossStreak(closed).count, 3);
  assert.equal(streakPauseUntil(closed, DEFAULT_SETTINGS.risk, now), at(5) + 15 * 60_000);
  assert.equal(streakPauseUntil(closed, DEFAULT_SETTINGS.risk, at(5) + 16 * 60_000), null, "the pause ends");
  assert.equal(streakPauseUntil([...closed, { closedAt: at(1), net: 3 }], DEFAULT_SETTINGS.risk, now), null, "a win resets the streak");
});

test("compensation: unknown terms count as zero; per-side doubles; a minimum hold excludes short trades", () => {
  const p = DEFAULT_SETTINGS.payout;
  assert.equal(eligibleLots(1, 60, p), 0);
  assert.equal(estimatedCompensation(10, p), 0);
  const known = { ...p, termsEntered: true, ratePerLot: 2, basis: "per_side" as const, minHoldSec: 120 };
  assert.equal(eligibleLots(0.1, 119, known), 0);
  assert.equal(eligibleLots(0.1, 121, known), 0.2);
  assert.equal(estimatedCompensation(0.2, known), 0.4);
});

test("settings edits are validated as a whole and refused, never clamped", () => {
  const ok = applySettingsPatch(DEFAULT_SETTINGS, { strategy: { tpPips: 12 }, costs: { commissionPerLotPerSide: 3.5, confirmed: true } });
  assert.ok(ok.ok && ok.settings.strategy.tpPips === 12 && ok.settings.costs.commissionPerLotPerSide === 3.5);
  const bad = applySettingsPatch(DEFAULT_SETTINGS, { risk: { riskPerTradePct: 5 } });
  assert.ok(!bad.ok && bad.errors.some((e) => e.includes("riskPerTradePct")));
  const cross = applySettingsPatch(DEFAULT_SETTINGS, { strategy: { stopMinPips: 6 } });
  assert.ok(!cross.ok && cross.errors.some((e) => e.includes("maximum stop")), "the minimum stop cannot pass a pair's maximum");
  const unknown = applySettingsPatch(DEFAULT_SETTINGS, { strategy: { lotsOfMoney: 1 } });
  assert.ok(!unknown.ok && unknown.errors[0].includes("unknown"));
  const hhmm = applySettingsPatch(DEFAULT_SETTINGS, { session: { rolloverStart: "25:00" } });
  assert.ok(!hhmm.ok);
  const read = settingsFrom({ strategy: { tpPips: 999, maxHoldSec: 90 }, risk: { maxConcurrent: 2 } });
  assert.equal(read.settings.strategy.tpPips, 10, "an invalid stored value falls back to the default");
  assert.equal(read.settings.strategy.maxHoldSec, 90, "valid neighbours are kept");
  assert.equal(read.settings.risk.maxConcurrent, 2);
  assert.ok(read.warnings.length === 1);
});

test("New York clock: the FX day starts 17:00 New York across daylight-saving changes", () => {
  // 2026-11-01 is the US fall-back Sunday. 17:00 New York is 21:00Z in summer and 22:00Z in winter.
  assert.equal(new Date(fxDayStart(Date.UTC(2026, 9, 23, 20, 0))).toISOString(), "2026-10-22T21:00:00.000Z");
  assert.equal(new Date(fxDayStart(Date.UTC(2026, 9, 23, 21, 30))).toISOString(), "2026-10-23T21:00:00.000Z");
  assert.equal(new Date(fxDayStart(Date.UTC(2026, 10, 2, 23, 0))).toISOString(), "2026-11-02T22:00:00.000Z");
  assert.equal(fxDayKey(Date.UTC(2026, 9, 23, 21, 30)), "2026-10-24", "a day that starts Friday 17:00 is labelled by the date it ends");
});

test("New York clock: no new entries at the rollover, after the Friday cutoff, on Saturday, or before Sunday's reopen + delay", () => {
  const s = DEFAULT_SETTINGS.session;
  assert.equal(entryBlackout(Date.UTC(2026, 9, 21, 14, 0), s), null, "Wednesday 10:00 New York");
  assert.match(entryBlackout(Date.UTC(2026, 9, 21, 21, 0), s) ?? "", /rollover/, "Wednesday 17:00 New York");
  assert.match(entryBlackout(Date.UTC(2026, 9, 23, 20, 50), s) ?? "", /Friday/, "Friday 16:50 New York");
  assert.match(entryBlackout(Date.UTC(2026, 9, 24, 15, 0), s) ?? "", /weekend/);
  assert.match(entryBlackout(Date.UTC(2026, 9, 25, 21, 5), s) ?? "", /reopens/, "Sunday 17:05 New York");
  assert.equal(entryBlackout(Date.UTC(2026, 9, 25, 21, 15), s), null, "Sunday 17:15 New York");
});

test("the owner's 'CAD USD' is the market's USDCAD", () => {
  assert.equal(pairOf("CAD USD")?.key, "USDCAD");
  assert.equal(pairOf("usd/cad")?.key, "USDCAD");
  assert.equal(pairOf("EURGBP"), null);
});
