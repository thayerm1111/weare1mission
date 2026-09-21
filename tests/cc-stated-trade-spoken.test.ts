import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { statedTradeFrom, tradeGuidanceLines } from "../command-center/brain/statedTrade";

describe("stated trade: spoken gold prices", () => {
  it("reads 43.43 / 43.21 / 43.50 as 4343 / 4321 / 4350 when gold is in the 43s", () => {
    const t = statedTradeFrom(["So I'm in a sell right now on gold at 43.43, and I have a take profit at 43.21 with a stop at 43.50. How's that look?"], 4343.29);
    assert.deepEqual([t?.side, t?.entry, t?.target, t?.stop], ["sell", 4343, 4321, 4350]);
  });
  it("leaves real decimals alone", () => {
    const t = statedTradeFrom(["short from 4343.43 stop 4350.5"], 4343.29);
    assert.deepEqual([t?.entry, t?.stop], [4343.43, 4350.5]);
  });
  it("a sell below entry is in profit, with one-decimal pips when small", () => {
    const l = tradeGuidanceLines("T", { side: "sell", entry: 4343.43, stop: 4343.5, target: 4343.21 }, 4343.29, [], []).join("\n");
    assert.match(l, /\+1\.4 pips IN PROFIT/);
    assert.match(l, /stop 4343\.50 — 2\.1 pips/);
    assert.match(l, /target 4343\.21 — 0\.8 pips/);
  });
});
