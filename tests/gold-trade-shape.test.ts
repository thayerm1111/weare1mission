import test from "node:test";
import assert from "node:assert/strict";
import { goldTradeShape, GOLD_MAX_STOP_USD, GOLD_MIN_TARGET_R, isGold } from "../src/lib/flow/goldRules";
import { entryLimitPrice, ENTRY_FLOOR_RR } from "../src/lib/flow/executor";

/**
 * Owner 11-02: "I do not want trades like this... such a massive stop loss and small take profit."
 * The trade: GENX intraday BUY 3958.80, stop 3895.85, take-profit parked at 3967.05, 0.73 lots on his
 * live account. The rule: no gold stop more than $15 from the entry; the target never nearer than the stop.
 */

test("the defaults are the owner's: $15 stop limit, take-profit at least 1:1", () => {
  assert.equal(GOLD_MAX_STOP_USD, 15);
  assert.equal(GOLD_MIN_TARGET_R, 1);
});

test("the 11-02 trade is refused: a $62.95 stop", () => {
  const r = goldTradeShape("buy", 3958.8, 3895.85, 4009.62);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /^gold_stop_over_limit \(stop \$62\.95/);
  // and with the take-profit it actually carried
  assert.equal(goldTradeShape("buy", 3958.8, 3895.85, 3967.05).ok, false);
});

test("a stop of exactly $15 passes; a cent more does not — both sides", () => {
  assert.equal(goldTradeShape("buy", 4000, 3985, 4020).ok, true);
  assert.equal(goldTradeShape("buy", 4000, 3984.99, 4020).ok, false);
  assert.equal(goldTradeShape("sell", 4000, 4015, 3980).ok, true);
  assert.equal(goldTradeShape("sell", 4000, 4015.01, 3980).ok, false);
});

test("GENX's own target must be at least as far as the stop", () => {
  const short = goldTradeShape("buy", 4000, 3990, 4009);   // $9 target on a $10 stop
  assert.equal(short.ok, false);
  assert.match((short as { reason: string }).reason, /^gold_target_inside_stop/);
  assert.equal(goldTradeShape("buy", 4000, 3990, 4010).ok, true);   // exactly 1:1
  assert.equal(goldTradeShape("sell", 4000, 4010, 3991).ok, false);
  assert.equal(goldTradeShape("sell", 4000, 4010, 3990).ok, true);
  // no target: judged on the stop alone
  assert.equal(goldTradeShape("buy", 4000, 3990, null).ok, true);
});

test("no stop, or a stop on the wrong side, is never a gold trade", () => {
  assert.equal(goldTradeShape("buy", 4000, null, 4020).ok, false);
  assert.equal(goldTradeShape("buy", null, 3990, 4020).ok, false);
  assert.equal(goldTradeShape("buy", 4000, 4005, 4020).ok, false);
  assert.equal(goldTradeShape("sell", 4000, 3995, 3980).ok, false);
});

test("gold only", () => {
  assert.equal(isGold("XAUUSD"), true);
  assert.equal(isGold("XAU/USD"), true);
  assert.equal(isGold("EURUSD"), false);
  assert.equal(isGold(null), false);
});

test("the gold entry limit can never fill under 1:1 against GENX's target; other symbols keep 0.8", () => {
  // buy: stop 3990, GENX target 4020 → the worst 1:1 entry is 4005
  const px = entryLimitPrice("buy", 4012, 3990, 4020, 2, null, GOLD_MIN_TARGET_R);
  assert.equal(px, 4005);
  assert.ok((4020 - px) / (px - 3990) >= 1 - 1e-9);
  // a quote already better than the cap is not made worse: the limit is the cap itself (fills at the quote or better)
  assert.equal(entryLimitPrice("buy", 4001, 3990, 4020, 2, null, GOLD_MIN_TARGET_R), 4005);
  // the default floor is unchanged for everything else
  assert.equal(ENTRY_FLOOR_RR, 0.8);
  const fx = entryLimitPrice("buy", 1.09, 1.08, 1.1, 5);
  assert.ok((1.1 - fx) / (fx - 1.08) >= 0.8 - 1e-9 && (1.1 - fx) / (fx - 1.08) < 0.81);
  // and at the 1:1 limit the shape check passes
  assert.equal(goldTradeShape("buy", px, 3990, 4020).ok, true);
});

test("the shape is judged where the order fills: a marketable limit fills at the quote, a resting one at its limit", async () => {
  const { expectedFill } = await import("../src/lib/flow/goldRules");
  // buy, stop 3990, far target 4060: the 1:1 cap is 4025, but the ask is 4000 → fills at 4000, a $10 stop
  const cap = entryLimitPrice("buy", 4000, 3990, 4060, 2, null, GOLD_MIN_TARGET_R);
  assert.equal(cap, 4025);
  assert.equal(expectedFill("buy", 4000, cap), 4000);
  assert.equal(goldTradeShape("buy", expectedFill("buy", 4000, cap), 3990, 4060).ok, true);
  // the market already past the cap: it would rest and fill at 4025 — a $35 stop, refused
  assert.equal(expectedFill("buy", 4030, cap), 4025);
  assert.equal(goldTradeShape("buy", expectedFill("buy", 4030, cap), 3990, 4060).ok, false);
  // sells mirror
  assert.equal(expectedFill("sell", 4000, 3975), 4000);
  assert.equal(expectedFill("sell", 3970, 3975), 3975);
  assert.equal(expectedFill("buy", 4000, null), 4000);
});
