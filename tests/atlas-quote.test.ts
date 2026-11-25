import test from "node:test";
import assert from "node:assert/strict";
import { atlasQuote, type AtlasTick } from "../src/lib/floor/atlasQuote";
import { buildAtlasMarketSnapshot } from "../src/lib/floor/marketIntelligence";

const NOW = Date.parse("2026-11-24T20:05:45Z"), TF = 300_000, CLOSED = NOW - 45_000;
const tick = (at: number, price = 3550): AtlasTick => ({ symbol: "XAU/USD", price, receivedAt: new Date(at).toISOString(), providerAt: new Date(at).toISOString() });
const bar = (t: number, price: number) => ({ t, o: price, h: price + 1, l: price - 1, c: price });
type SnapshotOptions = { now?: number; fetchedAt?: number; closedAt?: number; closedPrice?: number; formingPrice?: number; formingOnly?: boolean };
const snapshot = ({ now: observedNow = NOW, fetchedAt = observedNow, closedAt = CLOSED, closedPrice = 3554, formingPrice = 3590, formingOnly = false }: SnapshotOptions = {}) =>
  buildAtlasMarketSnapshot({
    symbol: "XAUUSD", now: observedNow, marketOpen: true,
    frames: { "5m": { timeKnown: true, fetchedAt, closedBefore: closedAt,
      bars: [...(formingOnly ? [] : [bar(closedAt - TF, closedPrice)]), bar(closedAt, formingPrice)] } },
  });

test("a newly retrieved cached forming candle cannot rewind a delayed reliable tick", () => {
  // The response arrives now, but its forming close may have been cached before this tick.
  const s = snapshot(), q = atlasQuote(s, "XAUUSD", tick(NOW - 8000), NOW, true);
  assert.equal(q.price, 3550);
  assert.equal(q.source, "tick");
  assert.equal(q.live, false);
  assert.equal(q.at, NOW - 8000);
  assert.equal(q.ageMs, 8000);
  assert.equal(q.providerTimed, true);
  assert.equal(s.frames["5m"].bars.at(-1)!.c, 3590, "the forming OHLC remains intact for the chart");
});

test("a genuinely newer verified candle close can replace an older tick", () => {
  const old = { ...tick(NOW), providerAt: new Date(NOW - 90_000).toISOString() };
  const q = atlasQuote(snapshot(), "XAUUSD", old, NOW, true);
  assert.equal(q.price, 3554);
  assert.equal(q.source, "candle");
  assert.equal(q.at, CLOSED);
  assert.equal(q.ageMs, 45_000, "age is the verified candle close, never its fresh retrieval time");
  assert.equal(q.live, false);
  assert.equal(q.providerTimed, true);
});

test("a fresh receipt cannot make an old provider quote live", () => {
  const old = { ...tick(NOW), providerAt: new Date(NOW - 90_000).toISOString() };
  const q = atlasQuote(null, "XAUUSD", old, NOW, true);
  assert.equal(q.live, false);
  assert.equal(q.ageMs, 90_000);
  assert.equal(q.at, NOW - 90_000);
});

test("time passage alone never promotes retained partial OHLC into a newer candle quote", () => {
  const saved = snapshot(), later = NOW + TF;
  const q = atlasQuote(saved, "XAUUSD", undefined, later, true);
  assert.equal(q.price, 3554);
  assert.equal(q.at, CLOSED);
  assert.equal(q.ageMs, later - CLOSED);
  const refreshed = snapshot({ now: later, closedAt: CLOSED + TF, closedPrice: 3548 });
  const updated = atlasQuote(refreshed, "XAUUSD", tick(NOW - 8000), later, true);
  assert.equal(updated.price, 3548);
  assert.equal(updated.at, CLOSED + TF);
  assert.equal(updated.source, "candle");
});

test("forming-only fallback has no fabricated age and never outranks a timestamped tick", () => {
  const s = snapshot({ formingOnly: true });
  const unknownAge = atlasQuote(s, "XAUUSD", undefined, NOW, true);
  assert.equal(unknownAge.price, 3590);
  assert.equal(unknownAge.source, "candle");
  assert.equal(unknownAge.at, null);
  assert.equal(unknownAge.ageMs, null);
  assert.equal(unknownAge.live, false);
  assert.equal(unknownAge.providerTimed, false);
  assert.equal(atlasQuote(s, "XAUUSD", tick(NOW - 90_000), NOW, true).source, "tick");
});

test("fresh ticks need the selected market, valid timestamps and an open market", () => {
  assert.equal(atlasQuote(null, "XAUUSD", tick(NOW - 1000), NOW, true).live, true);
  assert.equal(atlasQuote(null, "XAUUSD", tick(NOW - 1000), NOW, false).live, false);
  assert.equal(atlasQuote(null, "EURUSD", tick(NOW - 1000), NOW, true).price, null);
  assert.equal(atlasQuote(null, "XAUUSD", tick(NOW + 60_000), NOW, true).price, null);
  assert.equal(atlasQuote(null, "XAUUSD", { ...tick(NOW), providerAt: "invalid" }, NOW, true).price, null);
  assert.equal(atlasQuote(null, "XAUUSD", { ...tick(NOW), price: NaN }, NOW, true).price, null);
  const receiptOnly = atlasQuote(null, "XAUUSD", { ...tick(NOW - 1000), providerAt: null }, NOW, true);
  assert.equal(receiptOnly.providerTimed, false);
  assert.equal(receiptOnly.at, NOW - 1000);
});

test("wrong-market, future, unverified and malformed candle data cannot supply a timed quote", () => {
  assert.equal(atlasQuote(snapshot(), "EURUSD", undefined, NOW, true).price, null);
  for (const alter of [
    (s: ReturnType<typeof snapshot>) => { s.frames["5m"].timeKnown = false; },
    (s: ReturnType<typeof snapshot>) => { s.frames["5m"].dateOnly = true; },
    (s: ReturnType<typeof snapshot>) => { s.frames["5m"].fetchedAt = NOW + 60_000; },
    (s: ReturnType<typeof snapshot>) => { s.frames["5m"].closedAt = NOW + 60_000; },
    (s: ReturnType<typeof snapshot>) => { s.asOf = NOW + 60_000; },
    (s: ReturnType<typeof snapshot>) => { s.frames["5m"].bars.forEach((b) => { b.c = NaN; }); },
    (s: ReturnType<typeof snapshot>) => { s.frames["5m"].bars.forEach((b) => { b.l = b.h + 1; }); },
  ]) {
    const s = snapshot(); alter(s);
    assert.equal(atlasQuote(s, "XAUUSD", undefined, NOW, true).price, null);
    assert.equal(atlasQuote(s, "XAUUSD", tick(NOW - 1000), NOW, true).source, "tick", "invalid snapshots cannot displace a valid selected-market tick");
  }
});
