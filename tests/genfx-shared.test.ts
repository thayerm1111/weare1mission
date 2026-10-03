import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyOutcome } from "../src/lib/flow/flowManage";

/*
 * Two shared files learned something for GEN FX. Both changes are held to the same line: currency
 * pairs get the right answer, and gold gets exactly the answer it got before.
 */
const row = (o: Record<string, unknown>) => ({ symbol: "EURUSD", side: "buy", entry: 1.084, init_stop: 1.0825, tp1: 1.087, best_price: 1.0869, cur_stop: 1.0866, be_done: true, partial_done: false, ...o }) as Parameters<typeof classifyOutcome>[0];

test("a trail exit a few pips short of the target is not booked as the target — on a currency pair", () => {
  // Trailed out 4 pips under a 30-pip target. Five pips of tolerance called this a full target, at the target's price.
  const short = classifyOutcome(row({}), 1.0866, "stop");
  assert.deepEqual([short.outcome, short.result_pips, short.exit_price], ["trail", 26, 1.0866]);
  // At the target, or within half a pip of it: a target.
  assert.deepEqual(classifyOutcome(row({}), 1.087, "unknown").outcome, "target");
  assert.deepEqual(classifyOutcome(row({}), 1.08696, "unknown").outcome, "target");
  assert.deepEqual(classifyOutcome(row({}), 1.0869, "unknown").outcome, "trail");
  // The broker saying "take-profit" is always a target.
  assert.deepEqual([classifyOutcome(row({}), 1.0866, "target").outcome, classifyOutcome(row({}), 1.0866, "target").result_pips], ["target", 30]);
  // A sell, and GBP/JPY (pips of 0.01).
  const s = classifyOutcome(row({ side: "sell", entry: 1.084, init_stop: 1.0855, tp1: 1.081, cur_stop: 1.0814 }), 1.0814, "stop");
  assert.deepEqual([s.outcome, s.result_pips], ["trail", 26]);
  const j = classifyOutcome(row({ symbol: "GBPJPY", entry: 201.4, init_stop: 201.0, tp1: 202.2, cur_stop: 202.16 }), 202.16, "stop");
  assert.deepEqual([j.outcome, j.result_pips], ["trail", 76]);
  assert.equal(classifyOutcome(row({ symbol: "GBPJPY", entry: 201.4, init_stop: 201.0, tp1: 202.2 }), 202.196, "unknown").outcome, "target");
});

test("gold is graded exactly as it was: five gold pips of tolerance", () => {
  const g = (exit: number) => classifyOutcome(row({ symbol: "XAUUSD", entry: 4300, init_stop: 4292, tp1: 4316, cur_stop: 4315 }), exit, "unknown");
  assert.deepEqual([g(4315.6).outcome, g(4315.6).result_pips], ["target", 160]);       // 40 cents short: inside the 50-cent tolerance
  assert.equal(g(4315.5).outcome, "target");
  assert.equal(g(4315.4).outcome, "trail");
  const src = readFileSync("src/lib/flow/flowManage.ts", "utf8");
  assert.match(src, /const tpTol = \(getInstrument\(sym\)\.assetClass === "forex" \? 0\.5 : 5\) \* pip;/);
  assert.equal((src.match(/tpTol/g) ?? []).length, 3);
});

test("the size alarm reads a yen cross in yen", () => {
  const src = readFileSync("src/app/api/cron/flow-monitor/route.ts", "utf8");
  const fn = src.slice(src.indexOf("function valuePerPrice("), src.indexOf("/** Fire an alert at most once"));
  // USD/JPY keeps its own exact line, ahead of the cross; gold and the dollar pairs are untouched.
  assert.ok(fn.indexOf('if (s === "USDJPY")') < fn.indexOf('if (s.endsWith("JPY"))'));
  assert.match(fn, /if \(s === "XAUUSD" \|\| s === "GOLD"\) return \{ pip: 0\.1, vpp: 100 \};/);
  assert.match(fn, /if \(s\.endsWith\("JPY"\)\) return \{ pip: 0\.01, vpp: 100000 \/ 150 \};/);
  assert.match(fn, /return \{ pip: 0\.0001, vpp: 100000 \};/);
  // Half a lot of GBP/JPY on a 40-pip stop is about $133 at risk — not the $20,000 the dollar-pair line made of it.
  assert.ok(Math.abs(0.5 * 0.4 * (100000 / 150) - 133.33) < 0.01);
  assert.equal(0.5 * 0.4 * 100000, 20000);
});
