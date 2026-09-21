import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRangeFade, readRegime, efficiency, rangeFadeLimits, inNewYorkHours, RNG, type Bar } from "../src/lib/genx/rangeFade";

/** 24h+ of 5m bars oscillating between ~4350 and ~4390 (a clean range), then a chosen last bar. */
function rangeBars(last: Partial<Bar>): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < RNG.lookback + 40; i++) {
    const c = 4370 + 18 * Math.sin(i / 25);
    const o = i ? out[i - 1].c : c;
    out.push({ t: `t${i}`, o, c, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1 });
  }
  const hi = Math.max(...out.slice(-RNG.lookback).map((b) => b.h));
  const lo = Math.min(...out.slice(-RNG.lookback).map((b) => b.l));
  out.push({ t: "sig", o: 4370, h: 4370, l: 4370, c: 4370, ...last });
  (out as unknown as { hi: number; lo: number }).hi = hi;
  (out as unknown as { hi: number; lo: number }).lo = lo;
  return out;
}

describe("range fade detector", () => {
  it("sells a rejection of the top of the range, target the middle", () => {
    const b = rangeBars({});
    const hi = (b as unknown as { hi: number }).hi;
    b[b.length - 1] = { t: "sig", o: hi - 2.2, h: hi + 0.4, l: hi - 4.2, c: hi - 3.8 };
    const d = detectRangeFade(b);
    assert.ok(d.ok, JSON.stringify(d));
    if (!d.ok) return;
    assert.equal(d.setup.side, "sell");
    assert.ok(d.setup.stop > hi);
    assert.ok(d.setup.tp1 < d.setup.entry && d.setup.tp2 < d.setup.tp1);
    assert.ok(d.setup.rr >= RNG.minRr);
  });
  it("buys a rejection of the bottom", () => {
    const b = rangeBars({});
    const lo = (b as unknown as { lo: number }).lo;
    b[b.length - 1] = { t: "sig", o: lo + 2.2, h: lo + 4.2, l: lo - 0.4, c: lo + 3.8 };
    const d = detectRangeFade(b);
    assert.ok(d.ok && d.setup.side === "buy", JSON.stringify(d));
  });
  it("does not fade a bar that closes through the edge (a breakout)", () => {
    const b = rangeBars({});
    const hi = (b as unknown as { hi: number }).hi;
    b[b.length - 1] = { t: "sig", o: hi - 1, h: hi + 3, l: hi - 1.5, c: hi + 2.5 };
    assert.equal(detectRangeFade(b).ok, false);
  });
  it("does nothing in the middle of the range", () => {
    assert.equal(detectRangeFade(rangeBars({ o: 4371, h: 4372, l: 4368, c: 4369 })).ok, false);
  });
  it("needs 24h of history", () => {
    assert.deepEqual(detectRangeFade(rangeBars({}).slice(-100)), { ok: false, reason: "not_enough_bars" });
  });
});

describe("regime router", () => {
  const chop = Array.from({ length: 20 }, (_, i) => 4370 + (i % 2 ? 5 : -5));
  const trend = Array.from({ length: 20 }, (_, i) => 4300 + i * 5);
  it("efficiency: chop ≈ 0, straight line = 1", () => {
    assert.ok((efficiency(chop) ?? 1) < 0.1);
    assert.equal(efficiency(trend), 1);
  });
  it("range only when EMAs are mixed AND price is going nowhere", () => {
    assert.equal(readRegime("mixed", chop).regime, "range");
    assert.equal(readRegime("mixed", trend).regime, "trend");
    assert.equal(readRegime("up", chop).regime, "trend");
    assert.equal(readRegime(null, chop).regime, "unknown");
  });
});

describe("limits and session", () => {
  const now = Date.parse("2026-09-21T03:00:00Z");
  it("one hour between range calls, three a day", () => {
    assert.equal(rangeFadeLimits([{ createdAt: new Date(now - 30 * 60_000).toISOString() }], { nowMs: now, dayStartMs: now - 5 * 3600_000 }).ok, false);
    const three = [2, 3, 4].map((h) => ({ createdAt: new Date(now - h * 3600_000).toISOString() }));
    assert.equal(rangeFadeLimits(three, { nowMs: now, dayStartMs: now - 5 * 3600_000 }).reason, "range_fade_daily_limit");
    assert.equal(rangeFadeLimits([], { nowMs: now, dayStartMs: now }).ok, true);
  });
  it("skips New York hours", () => {
    assert.equal(inNewYorkHours(new Date("2026-09-21T14:00:00Z")), true);  // 10:00 NY
    assert.equal(inNewYorkHours(new Date("2026-09-21T03:00:00Z")), false); // 23:00 NY
    assert.equal(inNewYorkHours(new Date("2026-09-21T09:00:00Z")), false); // 05:00 NY, London
  });
});
