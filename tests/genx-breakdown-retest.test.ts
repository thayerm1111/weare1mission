import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectBreakdownRetest, breakdownLimits, type Bar } from "../src/lib/genx/breakdownRetest";

/** Bars from a close path: open = previous close, 0.6 of wick each side. */
function path(closes: number[], last?: Partial<Bar>): Bar[] {
  const b: Bar[] = closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: `t${i}`, o, c, h: Math.max(o, c) + 0.6, l: Math.min(o, c) - 0.6 };
  });
  if (last) b[b.length - 1] = { ...b[b.length - 1], ...last };
  return b;
}
const ramp = (a: number, z: number, n: number) => Array.from({ length: n }, (_, i) => a + ((z - a) * (i + 1)) / n);

// 40 bars chopping at 4380, a swing low at 4371 that bounces to 4378, a grind back down,
// a decisive break, a push lower, a pullback to the old floor.
function scenario(): number[] {
  const chop = Array.from({ length: 36 }, (_, i) => 4380 + (i % 2 ? 0.8 : -0.8));
  return [
    ...chop,
    ...ramp(4380, 4371.6, 4),   // down into the low (pivot ~4371)
    ...ramp(4371.6, 4378, 6),   // bounce ≥ 1 ATR — the level held
    ...ramp(4378, 4372.5, 8),   // grind back down
    4369.0, 4368.2,             // break + acceptance
    ...ramp(4368.2, 4365.5, 5), // displacement
    ...ramp(4365.5, 4369.3, 4), // pullback toward the old floor (not touching yet)
  ];
}

describe("breakdown-retest sells", () => {
  it("fires on the first rejected retest of a broken support", () => {
    const c = scenario();
    const bars = path([...c, 4369.6], { o: 4369.9, h: 4371.2, c: 4369.6, l: 4369.3 });
    const r = detectBreakdownRetest(bars);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(Math.abs(r.setup.entry - 4369.6) < 0.05);
    assert.ok(r.setup.stop > r.setup.entry + 3.99);
    assert.ok(r.setup.stop - r.setup.entry <= 9);
    assert.ok(r.setup.tp1 < r.setup.entry);
    assert.ok(Math.abs((r.setup.entry - r.setup.tp1) / r.setup.risk - 1.6) < 0.05);
  });

  it("does not fire when the retest bar closes back above the level", () => {
    const c = scenario();
    const bars = path([...c, 4372.4], { o: 4369.5, h: 4372.6, c: 4372.4, l: 4369.2 });
    assert.equal(detectBreakdownRetest(bars).ok, false);
  });

  it("does not fire without a rejection (a bullish bar with no upper wick)", () => {
    const c = scenario();
    const bars = path([...c, 4370.2], { o: 4369.3, h: 4370.3, c: 4370.2, l: 4369.2 });
    assert.equal(detectBreakdownRetest(bars).ok, false);
  });

  it("does not fire on a failed breakdown (a close back above the level after the break)", () => {
    const c = scenario();
    c.splice(c.length - 6, 1, 4373.5); // mid-way, price closed back above the old floor
    const bars = path([...c, 4369.6], { o: 4369.9, h: 4371.2, c: 4369.6, l: 4369.3 });
    assert.equal(detectBreakdownRetest(bars).ok, false);
  });

  it("does not fire on a second retest", () => {
    const c = scenario();
    c.push(4370.9, 4368.5, 4367.9); // first touch already happened
    const bars = path([...c, 4369.6], { o: 4369.9, h: 4371.2, c: 4369.6, l: 4369.3 });
    assert.equal(detectBreakdownRetest(bars).ok, false);
  });

  it("does not fire in a plain chop with no broken support", () => {
    const chop = Array.from({ length: 80 }, (_, i) => 4380 + (i % 2 ? 0.8 : -0.8));
    assert.equal(detectBreakdownRetest(path(chop)).ok, false);
  });
});

describe("breakdown-retest limits", () => {
  const day = Date.parse("2026-09-21T00:00:00Z");
  const at = (h: number) => new Date(day + h * 3600_000).toISOString();
  it("allows the first call", () => {
    assert.equal(breakdownLimits([], { session: "Asian", dayStartMs: day }).ok, true);
  });
  it("caps two per session", () => {
    const calls = [{ createdAt: at(1), session: "Asian", outcome: "win" }, { createdAt: at(2), session: "Asian", outcome: "win" }];
    assert.deepEqual(breakdownLimits(calls, { session: "Asian", dayStartMs: day }), { ok: false, reason: "session_limit" });
    assert.equal(breakdownLimits(calls, { session: "London", dayStartMs: day }).ok, true);
  });
  it("caps three per day", () => {
    const calls = [
      { createdAt: at(1), session: "Asian", outcome: "win" }, { createdAt: at(8), session: "London", outcome: "win" },
      { createdAt: at(9), session: "London", outcome: "win" },
    ];
    assert.deepEqual(breakdownLimits(calls, { session: "New York", dayStartMs: day }), { ok: false, reason: "daily_limit" });
  });
  it("stops the session after a loss", () => {
    const calls = [{ createdAt: at(1), session: "Asian", outcome: "loss" }];
    assert.deepEqual(breakdownLimits(calls, { session: "Asian", dayStartMs: day }), { ok: false, reason: "session_loss_stop" });
  });
  it("ignores yesterday", () => {
    const calls = [1, 2, 3].map((h) => ({ createdAt: at(-h), session: "Asian", outcome: "loss" }));
    assert.equal(breakdownLimits(calls, { session: "Asian", dayStartMs: day }).ok, true);
  });
});
