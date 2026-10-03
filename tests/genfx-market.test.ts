import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * The desk's market reads, against a feed stubbed at the network. Two things are held here:
 *   • a price comes with the moment it was OBSERVED, and asking again does not make it a new one;
 *   • candles shared between the watch and the scan are never older than the last candle close.
 */
process.env.TWELVEDATA_API_KEY = "test-key";

const realFetch = globalThis.fetch;
type Hit = { url: string; at: number };
function stubFeed(price: () => number): Hit[] {
  const hits: Hit[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    hits.push({ url, at: Date.now() });
    if (url.includes("/price?")) return new Response(JSON.stringify({ price: String(price()) }), { status: 200 });
    const values = Array.from({ length: 30 }, (_, i) => ({ datetime: `2026-10-06 ${String(10 + Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}:00`, open: "1.0840", high: "1.0845", low: "1.0835", close: "1.0841" })).reverse();
    return new Response(JSON.stringify({ status: "ok", values }), { status: 200 });
  }) as typeof fetch;
  return hits;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a quote carries when it was observed: the same quote handed back twice is one observation", async () => {
  const { fxQuote, fxPrice } = await import("../src/lib/genfx/market");
  let px = 1.0841;
  const hits = stubFeed(() => px);
  try {
    const a = await fxQuote("TEST/ONE", 3_000);
    px = 1.09;                                                  // the market moves, but nobody has asked the feed again
    const b = await fxQuote("TEST/ONE", 3_000);
    assert.deepEqual([a?.px, b?.px, a?.at === b?.at, hits.length], [1.0841, 1.0841, true, 1]);
    assert.equal(await fxPrice("TEST/ONE", 3_000), 1.0841);
    await sleep(60);
    const c = await fxQuote("TEST/ONE", 50);                    // older than the caller will accept: asked again
    assert.deepEqual([c?.px, (c?.at ?? 0) > (a?.at ?? 0), hits.length], [1.09, true, 2]);
  } finally { globalThis.fetch = realFetch; }
});

test("a streamed tick is observed when it arrived, however often it is read", async () => {
  const { fxQuote } = await import("../src/lib/genfx/market");
  const { pushLiveTick } = await import("../src/lib/flow/liveTicks");
  const hits = stubFeed(() => 9.99);
  try {
    pushLiveTick("TEST/TWO", 1.085, Date.now());
    const a = await fxQuote("TEST/TWO");
    await sleep(30);
    const b = await fxQuote("TEST/TWO");
    assert.deepEqual([a?.px, b?.px, a?.at === b?.at, hits.length], [1.085, 1.085, true, 0]);
    await sleep(20);
    pushLiveTick("TEST/TWO", 1.085, Date.now());                // the same price again is still a NEW observation
    const c = await fxQuote("TEST/TWO");
    assert.ok((c?.at ?? 0) > (a?.at ?? 0));
  } finally { globalThis.fetch = realFetch; }
});

test("candles on hand are shared — but never ones fetched before the last candle closed", async () => {
  const { fxSeries, candleFloorMs } = await import("../src/lib/genfx/market");
  const hits = stubFeed(() => 1);
  try {
    const first = await fxSeries("TEST/THREE", "5min", 24, { maxAgeMs: 20_000 });
    const again = await fxSeries("TEST/THREE", "5min", 24, { maxAgeMs: 20_000 });
    assert.ok(Array.isArray(first) && first.length === 24 && Array.isArray(again));
    assert.equal(hits.length, 1);                               // shared
    // The same call a moment later, by a reader that will only take candles fetched after NOW: asked again.
    await sleep(15);
    await fxSeries("TEST/THREE", "5min", 24, { maxAgeMs: 20_000, notBeforeMs: Date.now() });
    assert.equal(hits.length, 2);
    // …and one fetched after the floor is shared again.
    await fxSeries("TEST/THREE", "5min", 24, { maxAgeMs: 20_000, notBeforeMs: Date.now() - 5 });
    assert.equal(hits.length, 2);
    // The floor: eight seconds after the last five-minute boundary, as it stood eight seconds ago.
    const b = Date.UTC(2026, 9, 6, 14, 5, 0);
    assert.equal(candleFloorMs(b + 8_000), b + 8_000);          // the scan's own moment: only candles fetched from now on
    assert.equal(candleFloorMs(b + 200_000), b + 8_000);
    assert.equal(candleFloorMs(b + 3_000), b - 300_000 + 8_000); // three seconds after a close the feed may not have it yet
  } finally { globalThis.fetch = realFetch; }
});
