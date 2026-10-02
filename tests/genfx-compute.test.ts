import { test } from "node:test";
import assert from "node:assert/strict";
import { runEngine } from "../src/lib/omEngine";
import { MODES, GOLD, buildGenx, sessionNow, type Mode, type Row } from "../src/lib/genxCompute";
import { PAIRS } from "../src/lib/genfx/pairs";
import { buildGenfx, genfxOf, engineCfg, volLabel, stopRoom, readFromSeries, type GenfxCtx } from "../src/lib/genfx/compute";
import { aggregate } from "../src/lib/genfx/replay";
import { synthBars, MONDAY } from "./_genfx_fixture";

/*
 * GEN FX's result builder is a copy of GENX's, because GENX's writes "XAUUSD" and measures three
 * distances in gold pips. The promise is that the copy is the same function. These tests hold it to
 * that: handed gold's own numbers it must return exactly what buildGenx returns, field for field,
 * except for the one block GEN FX deliberately does not carry (the gold "right-now scalp").
 */
const GOLD_INST = { symbol: "XAUUSD", pip: GOLD.pip, dec: GOLD.dec, unit: 1 };

function both(read: Record<string, unknown>, ctx: GenfxCtx, m15: Row[] | null = null) {
  const gx = buildGenx(read, { ...ctx, pip: GOLD.pip, dec: GOLD.dec, m15 }) as Record<string, unknown>;
  const fx = buildGenfx(read, ctx, GOLD_INST) as Record<string, unknown>;
  const { scalp: _a, ...gxRest } = gx; void _a;
  const { scalp: fxScalp, ...fxRest } = fx;
  return { gxRest, fxRest, fxScalp };
}
const ctxOf = (mode: Mode, price: number, extra: Partial<GenfxCtx> = {}): GenfxCtx => ({
  mode, price, session: "London", dataStatus: "live", hold: MODES[mode].hold, triggerTf: MODES[mode].triggerTf, contextTf: MODES[mode].contextTf,
  marketStory: ["a", "b"], volatility: "Normal", atr: 3.2, ...extra,
});

test("on gold's own numbers the GEN FX builder returns exactly what GENX's returns — every branch", () => {
  const reads: [string, Record<string, unknown>, number][] = [
    ["trade ready, long", { state: "TRADE_READY", direction: "buy", strategy: "Trend pullback", market_regime: "Bullish trend", entry: { price: 4338.13, zone_low: 4337.4, zone_high: 4339.02 }, stop_loss: { price: 4332.54, reason: "Below the swing low." }, take_profits: [{ price: 4349.3, risk_reward: 2 }, { price: 4356.77 }, { price: 4361.2 }], levels: { support: 4335.1, resistance: 4358.9 }, scores: { overall: 78, directional: 81 }, proximity: { status: "Inside Setup Zone" }, what_next: ["Hold above 4335.", "Watch 4358."] }, 4338.4],
    ["developing, short, provisional levels", { state: "DEVELOPING_SETUP", direction: "sell", market_regime: "Bearish trend", provisional_trade: { entry: { price: 4348.2, zone_low: 4347.5, zone_high: 4349.4 }, stop_loss: { price: 4356.87 }, take_profits: [{ price: 4319.29, risk_reward: 3.3 }] }, levels: { support: 4320, resistance: 4350 }, confidence_breakdown: { overall: 66 }, scores: { directional: 58 }, proximity: { status: "Approaching Zone" }, trigger: { recheckInstruction: "Wait for a 5-minute close below 4347." }, entry_profile: "aggressive_only" }, 4341],
    ["watchlist, long", { state: "WATCHLIST", direction: "buy", market_regime: "Choppy", entry: { price: 4300.05 }, stop_loss: { price: 4291.5 }, take_profits: [{ price: 4312.4 }], levels: { support: 4298.5, resistance: 4321 }, scores: { overall: 55 }, setup_zone: { confirmation: "Bullish close above 4301.", invalidation: "Close under 4291." } }, 4306],
    ["no trade, no direction: range, price low → buy the support", { state: "NO_TRADE", levels: { support: 4300, resistance: 4320 }, scores: { overall: 40 } }, 4304],
    ["no trade, no direction: range, price high → sell the resistance", { state: "NO_TRADE", market_regime: "Range", levels: { support: 4300, resistance: 4320 }, scores: { overall: 61 } }, 4317],
    ["direction but no levels: range synthesised on the engine's side", { state: "DEVELOPING_SETUP", direction: "sell", levels: { support: 4300.4, resistance: 4302.1 }, scores: { overall: 70 } }, 4301],
    ["nothing at all", { state: "DATA_UNAVAILABLE" }, 4300],
    ["wide ATR sets the range stop", { state: "NO_TRADE", levels: { support: 4300, resistance: 4306 }, scores: {} }, 4301],
  ];
  for (const [name, read, price] of reads) {
    for (const mode of ["quick", "intraday", "swing"] as Mode[]) {
      const { gxRest, fxRest, fxScalp } = both(read, ctxOf(mode, price, name.startsWith("wide ATR") ? { atr: 9 } : {}));
      assert.deepEqual(fxRest, gxRest, `${name} · ${mode}`);
      assert.equal(fxScalp, null, "GEN FX never offers the gold scalp");
    }
  }
});

test("…and on reads the real engine produces over a few hundred moments of a market", () => {
  const base = synthBars({ seed: 11, start: MONDAY, bars: 5200, price: 4300, pip: 0.1, dec: 2, volPips: 9 });
  const tfs = ["5min", "15min", "30min", "1h", "4h", "1day", "1week"];
  const S = new Map(tfs.map((tf) => [tf, aggregate(base, tf)]));
  const closedBy = (tf: string, T: number, n: number): Row[] => { const s = S.get(tf === "1min" ? "5min" : tf)!; let k = 0; while (k < s.end.length && s.end[k] <= T) k++; return s.rows.slice(Math.max(0, k - n), k); };
  const actions = new Set<string>();
  let compared = 0;
  for (let i = 3000; i < base.length; i += 9) {
    const T = base[i].t + 300_000, price = base[i].c;
    for (const mode of ["quick", "intraday"] as Mode[]) {
      const tf = MODES[mode].tf;
      const m15 = closedBy(tf.m15, T, 150);
      const read = runEngine({ ...GOLD, ...MODES[mode].eng }, { d1: closedBy(tf.d1, T, 90), h1: closedBy(tf.h1, T, 120), m30: closedBy(tf.m30, T, 120), m15, m5: closedBy(tf.m5, T, 150), price, nowMs: T, session: sessionNow(new Date(T)) }) as Record<string, unknown>;
      const { gxRest, fxRest } = both(read, ctxOf(mode, price, { atr: 2.9 }), m15);
      assert.deepEqual(fxRest, gxRest);
      actions.add(String(fxRest.action));
      compared++;
    }
  }
  assert.ok(compared > 400);
  assert.ok(actions.size >= 3, `the sample must reach more than one branch (saw ${[...actions].join(", ")})`);
});

test("a pair gets its own symbol, its own precision and the engine's forex settings", () => {
  for (const mode of ["quick", "intraday", "swing"] as Mode[]) {
    assert.deepEqual(engineCfg(PAIRS.EURUSD, mode), { symbol: "EUR/USD", label: "Euro (EUR/USD)", cat: "forex", pip: 0.0001, dec: 5, ...MODES[mode].eng });
    assert.deepEqual(engineCfg(PAIRS.GBPJPY, mode), { symbol: "GBP/JPY", label: "Pound-Yen (GBP/JPY)", cat: "forex", pip: 0.01, dec: 3, ...MODES[mode].eng });
  }
  const read = { state: "TRADE_READY", direction: "sell", entry: { price: 1.084321, zone_low: 1.08412, zone_high: 1.08455 }, stop_loss: { price: 1.085876 }, take_profits: [{ price: 1.08121 }], levels: { support: 1.0809, resistance: 1.0861 }, scores: { overall: 74 } };
  const g = genfxOf(PAIRS.EURUSD, read, ctxOf("quick", 1.08431));
  assert.equal(g.symbol, "EURUSD");
  assert.equal(g.action, "SELL_NOW");
  assert.equal(g.entry, 1.08432);            // five decimals, not gold's two
  assert.equal(g.stop_loss, 1.08588);
  assert.equal(g.stop_pips, 16);             // pips of 0.0001
  assert.equal(g.tp1_pips, 31);
  const j = genfxOf(PAIRS.GBPJPY, { state: "TRADE_READY", direction: "buy", entry: { price: 201.4567 }, stop_loss: { price: 201.1512 }, take_profits: [{ price: 202.0611 }], levels: {}, scores: { overall: 70 } }, ctxOf("intraday", 201.46));
  assert.equal(j.symbol, "GBPJPY");
  assert.equal(j.entry, 201.457);            // three decimals
  assert.equal(j.stop_pips, 31);             // pips of 0.01
});

test("the range setup's three gold-pip distances are the pair's units, not gold's digits", () => {
  // Gold: zone 5 pips under / 8 over the level ($0.50 / $0.80), stop at least 15 pips ($1.50) away.
  // EUR/USD: 0.5 / 0.8 / 1.5 pips. Copying gold's digits would have put the stop $1.50 — 15,000 pips — away.
  const wide = genfxOf(PAIRS.EURUSD, { state: "NO_TRADE", levels: { support: 1.08, resistance: 1.086 }, scores: {} }, ctxOf("quick", 1.081, { atr: null }));
  assert.equal(wide.action, "WAIT_FOR_BUY_TRIGGER");
  assert.equal(wide.entry, 1.08);
  assert.equal(wide.entry_low, 1.07995);
  assert.equal(wide.entry_high, 1.08008);
  assert.equal(wide.stop_loss, 1.0791);      // 15% of the 60-pip range = 9 pips
  assert.equal(wide.tp1, 1.083);
  assert.equal(wide.tp2, 1.086);
  const narrow = genfxOf(PAIRS.EURUSD, { state: "NO_TRADE", levels: { support: 1.08, resistance: 1.0804 }, scores: {} }, ctxOf("quick", 1.0803, { atr: null }));
  assert.equal(narrow.action, "WAIT_FOR_SELL_TRIGGER");
  assert.equal(narrow.stop_loss, 1.08055);   // the 1.5-unit floor: 1.5 pips above 1.0804
  const yen = genfxOf(PAIRS.GBPJPY, { state: "NO_TRADE", levels: { support: 201, resistance: 201.1 }, scores: {} }, ctxOf("quick", 201.02, { atr: null }));
  assert.equal(yen.entry_low, 200.988);      // 0.5 units = 1.25 pips under
  assert.equal(yen.entry_high, 201.02);      // 0.8 units = 2 pips over
  assert.equal(yen.stop_loss, 200.963);      // 1.5 units = 3.75 pips (rounded to the pair's 3 decimals)
});

test("volatility is judged in the pair's units", () => {
  const rows = (range: number, base: number): Row[] => Array.from({ length: 40 }, (_, i) => ({ datetime: `2026-03-02 00:${String(i).padStart(2, "0")}:00`, open: String(base), high: String(base + range / 2), low: String(base - range / 2), close: String(base) }));
  assert.equal(volLabel(PAIRS.EURUSD, rows(0.0009, 1.08)).label, "High");     // 9 pips a bar
  assert.equal(volLabel(PAIRS.EURUSD, rows(0.0005, 1.08)).label, "Normal");
  assert.equal(volLabel(PAIRS.EURUSD, rows(0.0002, 1.08)).label, "Low");
  assert.equal(volLabel(PAIRS.GBPJPY, rows(0.21, 201)).label, "High");        // 21 pips = 8.4 units
  assert.equal(volLabel(PAIRS.GBPJPY, rows(0.1, 201)).label, "Normal");       // 10 pips = 4 units
  assert.equal(volLabel(PAIRS.GBPJPY, rows(0.05, 201)).label, "Low");         // 5 pips = 2 units
  assert.deepEqual(volLabel(PAIRS.EURUSD, rows(0.0009, 1.08).slice(0, 10)), { label: "Normal", atr: null });
});

test("the page says whether auto-trade would take a stop, with no floating-point surprises", () => {
  assert.deepEqual(stopRoom(PAIRS.EURUSD, 1.0843, 1.0833), { ok: true, pips: 10, min: 10 });     // exactly ten is ten
  assert.deepEqual(stopRoom(PAIRS.EURUSD, 1.0843, 1.0834), { ok: false, pips: 9, min: 10 });
  assert.deepEqual(stopRoom(PAIRS.GBPJPY, 201.5, 201.3), { ok: true, pips: 20, min: 20 });
  assert.deepEqual(stopRoom(PAIRS.GBPJPY, 201.5, 201.31), { ok: false, pips: 19, min: 20 });
  assert.deepEqual(stopRoom(PAIRS.EURUSD, 1.0843, 1.0836, 6), { ok: true, pips: 7, min: 6 });    // the owner's setting wins
  assert.deepEqual(stopRoom(PAIRS.EURUSD, null, 1.08), { ok: false, pips: null, min: 10 });
});

test("the read is a pure function of the candles and the moment it is given", () => {
  const base = synthBars({ seed: 3, start: MONDAY, bars: 2600, price: 1.085, pip: 0.0001, dec: 5, volPips: 2.2 });
  const rowsOf = (tf: string, n: number) => aggregate(base, tf).rows.slice(-n);
  const s = { d1: rowsOf("1h", 90), h1: rowsOf("15min", 120), m30: rowsOf("15min", 120), m15: rowsOf("5min", 150), m5: rowsOf("5min", 150) };
  const T = base[base.length - 1].t + 300_000;
  const a = readFromSeries(PAIRS.EURUSD, "quick", s, base[base.length - 1].c, T);
  const b = readFromSeries(PAIRS.EURUSD, "quick", s, base[base.length - 1].c, T);
  assert.deepEqual(a, b);
  assert.equal(a.session, sessionNow(new Date(T)));
});
