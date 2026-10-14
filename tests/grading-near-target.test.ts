import test from "node:test";
import assert from "node:assert/strict";
import { classifyOutcome } from "../src/lib/flow/flowManage";

/**
 * Owner 10-14: "Fix whatever you gotta fix". A trade closed at its take-profit is booked where it closed.
 * FLOW parks gold's take-profit at the near target (half the risk, 30–80 pips) while tp1 stays GENX's plan,
 * and a take-profit fill used to be booked at tp1: 41 gold trades since the 10-11 reset at +92 on average.
 */
type Row = Parameters<typeof classifyOutcome>[0];
const gold = (o: Partial<Row> = {}): Row => ({
  symbol: "XAUUSD", side: "buy", entry: 4000, init_stop: 3990, tp1: 4020, best_price: 4006, cur_stop: 4001.7, be_done: true, partial_done: false, ...o,
}) as Row;

test("gold: a take-profit fill is booked at the broker's exit — the near target — not at the plan's tp1", () => {
  const r = classifyOutcome(gold(), 4005, "target");
  assert.deepEqual([r.outcome, r.result_pips, r.exit_price], ["target", 50, 4005]);
});

test("gold: with no exit price from the broker, at the take-profit that was parked (the near target)", () => {
  const r = classifyOutcome(gold(), null, "target");
  assert.deepEqual([r.outcome, r.result_pips, r.exit_price], ["target", 50, 4005]);
  // And when only the best price says the plan's target was touched, the near target came first.
  const touched = classifyOutcome(gold({ best_price: 4021 }), null, "unknown");
  assert.deepEqual([touched.outcome, touched.result_pips], ["target", 50]);
});

test("a take-profit fill with no exit price is not booked at the stop", () => {
  // Break-even not yet moved (a member can switch it off since 10-08). This used to read the initial stop: −100.
  const r = classifyOutcome(gold({ be_done: false, cur_stop: 3990 }), null, "target");
  assert.deepEqual([r.result_pips, r.exit_price], [50, 4005]);
  assert.notEqual(r.outcome, "stop");
});

test("a recorded partial blends with where the rest actually closed", () => {
  const r = classifyOutcome(gold({ partial_done: true, partial_px: 4002.5, partial_frac: 0.25 } as Partial<Row>), 4005, "target");
  assert.deepEqual([r.outcome, r.result_pips], ["target", 44]);   // 25% at +25, 75% at +50
});

test("a 10-14 08:27 sell booked +120 at the plan: with no broker exit, at the near target from its fill", () => {
  // The broker's own exit is used whenever its history gives one (about 96% of closes since the reset);
  // this is only the fallback. The plan's 4138.42 was never reached: the furthest price seen was 4142.35.
  const r = classifyOutcome(gold({ side: "sell", entry: 4150.45, init_stop: 4161.62, tp1: 4138.42, best_price: 4142.35, cur_stop: 4150.0 }), null, "target");
  assert.equal(r.outcome, "target");
  assert.equal(r.result_pips, 56);
  assert.ok(Math.abs(Number(r.exit_price) - 4144.865) < 1e-6);
});

test("a currency pair has no near target: its take-profit is the plan's", () => {
  const fx = { symbol: "EURUSD", side: "buy", entry: 1.084, init_stop: 1.0825, tp1: 1.087, best_price: 1.0869, cur_stop: 1.0841, be_done: true, partial_done: false } as Row;
  assert.deepEqual([classifyOutcome(fx, null, "target").result_pips, classifyOutcome(fx, null, "target").exit_price], [30, 1.087]);
  assert.deepEqual([classifyOutcome(fx, 1.087, "target").result_pips], [30]);
});

test("stops, trails and hand closes are booked exactly as before", () => {
  assert.deepEqual([classifyOutcome(gold({ be_done: false }), 3990, "stop").outcome, classifyOutcome(gold({ be_done: false }), 3990, "stop").result_pips], ["stop", -100]);
  assert.deepEqual([classifyOutcome(gold(), 4003, "stop").outcome, classifyOutcome(gold(), 4003, "stop").result_pips], ["trail", 30]);
  assert.deepEqual([classifyOutcome(gold(), 4001.7, "stop").outcome, classifyOutcome(gold(), 4001.7, "stop").result_pips], ["breakeven", 17]);
  assert.deepEqual([classifyOutcome(gold(), 4004, "manual").outcome, classifyOutcome(gold(), 4004, "manual").result_pips], ["manual", 40]);
});
