import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hourlyStack, stackAgrees, trendGateFrom1m } from "../src/lib/genx/trendGate";

const ramp = (from: number, step: number, n: number) => Array.from({ length: n }, (_, i) => from + i * step);

describe("GENX trend gate", () => {
  it("reads a rising market as stacked up", () => {
    assert.equal(hourlyStack(ramp(4000, 1, 300))?.stack, "up");
  });
  it("reads a falling market as stacked down", () => {
    assert.equal(hourlyStack(ramp(4400, -1, 300))?.stack, "down");
  });
  it("reads a turn as mixed", () => {
    const up = ramp(4000, 1, 260), down = ramp(4260, -3, 40);
    assert.equal(hourlyStack([...up, ...down])?.stack, "mixed");
  });
  it("needs enough history", () => {
    assert.equal(hourlyStack(ramp(4000, 1, 100)), null);
  });
  it("only lets the stacked side through", () => {
    assert.equal(stackAgrees("buy", "up"), true);
    assert.equal(stackAgrees("sell", "up"), false);
    assert.equal(stackAgrees("sell", "down"), true);
    assert.equal(stackAgrees("buy", "mixed"), false);
    assert.equal(stackAgrees("sell", "mixed"), false);
  });
  it("is off by default (straight GENX, 09-21)", () => {
    delete process.env.GENX_TREND_GATE;
    assert.equal(trendGateFrom1m("buy", []).ok, true);
  });
  it("works from 1-minute bars (the PDH/PDL loop) when switched on", () => {
    process.env.GENX_TREND_GATE = "on";
    const bars = Array.from({ length: 300 * 60 }, (_, i) => ({ t: 1_700_000_000_000 - (1_700_000_000_000 % 3_600_000) + i * 60_000, c: 4400 - i / 60 }));
    assert.equal(trendGateFrom1m("sell", bars).ok, true);
    assert.equal(trendGateFrom1m("buy", bars).ok, false);
    delete process.env.GENX_TREND_GATE;
  });
});
