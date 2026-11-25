import test from "node:test";
import assert from "node:assert/strict";
import {
  STRATA_FRAMES, StrataFeedError, createStrataCandleFeed, delayedStrataFrames, strataTickQuote,
  type StrataCandles, type StrataTick,
} from "../src/lib/strata/feedData";
import type { Bar } from "../src/lib/strata/engine";

const NOW = Date.parse("2026-11-24T20:06:00Z"), MINUTE = 60_000;
type Frame = typeof STRATA_FRAMES[number];
const frameFor = (interval: string): Frame => STRATA_FRAMES.find((frame) => frame.interval === interval)!;
const candle = (t: number, c = 3550): Bar => ({ t, o: c - .1, h: c + 1, l: c - 1, c });
const row = (bar: Bar) => ({ datetime: new Date(bar.t).toISOString(), open: String(bar.o), high: String(bar.h), low: String(bar.l), close: String(bar.c) });
function history(frame: Frame, at: number, count: number = frame.count): Bar[] {
  const end = Math.floor((at - MINUTE) / frame.ms) * frame.ms;
  return Array.from({ length: count }, (_, i) => candle(end - (count - i) * frame.ms, 3550 + Math.sin(i / 4) * 3));
}
const rows = (interval: string, at: number, count?: number) => history(frameFor(interval), at, count).map(row);
function rawWithCloses(closedAt: number): StrataCandles {
  return { computedAt: closedAt, ...Object.fromEntries(STRATA_FRAMES.map((frame) =>
    [frame.key, [candle(closedAt - frame.ms)]])) } as StrataCandles;
}

test("STRATA requests each native timeframe and count once for concurrent readers, then uses its bounded cache", async () => {
  let clock = NOW;
  const calls: { interval: string; count: number }[] = [];
  const feed = createStrataCandleFeed(async (interval, count) => {
    calls.push({ interval, count });
    return rows(interval, clock);
  }, { clock: () => clock, deadlineMs: 100, providerCacheMs: 30_000 });
  const [first, second] = await Promise.all([feed.read(), feed.read()]);
  assert.deepEqual(calls, [
    { interval: "5min", count: 220 }, { interval: "15min", count: 220 },
    { interval: "1h", count: 130 }, { interval: "4h", count: 90 },
  ]);
  assert.equal(first, second, "concurrent readers share the same completed snapshot");
  for (const frame of STRATA_FRAMES) {
    assert.equal(first[frame.key].length, frame.count);
    assert.equal(first[frame.key][1].t - first[frame.key][0].t, frame.ms);
    assert.deepEqual(first[frame.key], history(frame, NOW));
  }
  clock += 24_999;
  assert.equal(await feed.read(), first);
  assert.equal(calls.length, 4);
  clock += 2;
  const renewed = await feed.read();
  assert.equal(calls.length, 8);
  assert.equal(renewed.computedAt, clock);
});

test("explicit Generate rechecks a locally cached snapshot while concurrent refreshes still coalesce", async () => {
  let clock = NOW, calls = 0;
  const feed = createStrataCandleFeed(async (interval) => { calls++; return rows(interval, clock); },
    { clock: () => clock, deadlineMs: 100 });
  const first = await feed.read();
  clock += 1000;
  const [next, same] = await Promise.all([feed.read(true), feed.read(true)]);
  assert.equal(calls, 8, "refresh bypasses only the four-frame local cache");
  assert.notEqual(next, first);
  assert.equal(next, same);
  assert.equal(next.computedAt, clock);
  assert.equal(await feed.read(), next);
  assert.equal(calls, 8);
});

test("provider failures report the failing timeframe and clear the in-flight read for a successful retry", async () => {
  for (const failure of ["rate", "unavailable", "throw", "short"] as const) {
    let failing = true, calls = 0;
    const feed = createStrataCandleFeed(async (interval) => {
      calls++;
      if (failing && interval === "1h") {
        if (failure === "rate") return "ratelimit";
        if (failure === "unavailable") return null;
        if (failure === "throw") throw new Error("private upstream failure details");
        return rows(interval, NOW, frameFor(interval).minimum - 1);
      }
      return rows(interval, NOW);
    }, { clock: () => NOW, deadlineMs: 100 });
    const code = failure === "rate" ? "marketdata_rate_limited"
      : failure === "short" ? "insufficient_history" : "marketdata_unavailable";
    await assert.rejects(feed.read(), (error: unknown) => {
      assert.ok(error instanceof StrataFeedError);
      assert.equal(error.code, code);
      assert.equal(error.timeframe, "1h");
      assert.doesNotMatch(error.message, /private upstream/);
      return true;
    });
    failing = false;
    assert.ok((await feed.read()).h1.length >= 50);
    assert.equal(calls, 8, failure + " cannot leave a rejected promise cached");
  }
});

test("a hanging provider request times out for all shared readers and permits another attempt", async () => {
  let hang = true, calls = 0;
  const feed = createStrataCandleFeed(async (interval) => {
    calls++;
    if (hang && interval === "5min") return new Promise<never>(() => {});
    return rows(interval, NOW);
  }, { clock: () => NOW, deadlineMs: 15 });
  const check = (error: unknown) => {
    assert.ok(error instanceof StrataFeedError);
    assert.equal(error.code, "marketdata_timeout");
    assert.equal(error.timeframe, "5m");
    return true;
  };
  await Promise.all([assert.rejects(feed.read(), check), assert.rejects(feed.read(), check)]);
  assert.equal(calls, 4);
  hang = false;
  assert.ok((await feed.read(true)).m5.length >= 30);
  assert.equal(calls, 8);
});

test("response latency cannot confirm a cached partial candle past request start minus cache grace", async () => {
  const boundary = Date.parse("2026-11-24T20:05:00Z");
  const startedAt = boundary + 29_000;
  let clock = startedAt;
  const resolvers: (() => void)[] = [];
  const feed = createStrataCandleFeed((interval) => new Promise((resolve) => {
    const frame = frameFor(interval);
    const payload = rows(interval, startedAt, interval === "5min" ? frame.count - 1 : frame.count);
    if (interval === "5min") payload.push(row(candle(boundary - frame.ms, 4000)));
    resolvers.push(() => resolve(payload));
  }), { clock: () => clock, providerCacheMs: 30_000, deadlineMs: 100 });
  const reading = feed.read();
  clock += 8_000;
  resolvers.forEach((resolve) => resolve());
  const result = await reading;
  assert.equal(result.computedAt, startedAt);
  assert.equal(result.m5.at(-1)!.t + 300_000, boundary - 300_000);
  assert.ok(result.m5.every((bar) => bar.c !== 4000), "a pre-close cached value is never accepted as completed OHLC");
  assert.equal(await feed.read(), result, "later wall-clock time cannot advance a cached snapshot's closure evidence");
});

test("freshness checks every required frame, including stale 4h data beside fresh 15m data", () => {
  const fresh = rawWithCloses(NOW - MINUTE);
  assert.deepEqual(delayedStrataFrames(fresh, NOW), []);
  for (const frame of STRATA_FRAMES) {
    const raw = rawWithCloses(NOW - MINUTE);
    const oldClose = Math.floor((NOW - frame.ms * 2 - 3 * MINUTE) / frame.ms) * frame.ms;
    raw[frame.key] = [candle(oldClose - frame.ms)];
    assert.deepEqual(delayedStrataFrames(raw, NOW), [frame.label]);
  }
  const missing = rawWithCloses(NOW - MINUTE); missing.h4 = [];
  assert.deepEqual(delayedStrataFrames(missing, NOW), ["4h"]);
});

test("normal weekend and daily session breaks do not count as feed delay, including the DST weekend", () => {
  for (const [close, reopen] of [
    ["2026-11-20T22:00:00Z", "2026-11-22T23:00:00Z"],
    ["2026-10-30T21:00:00Z", "2026-11-01T23:00:00Z"],
    ["2026-11-24T22:00:00Z", "2026-11-24T23:00:00Z"],
  ]) {
    const raw = rawWithCloses(Date.parse(close)), openAt = Date.parse(reopen);
    assert.deepEqual(delayedStrataFrames(raw, openAt + 4 * MINUTE), []);
    assert.deepEqual(delayedStrataFrames(raw, openAt + 13 * MINUTE), ["5m"], "actual trading minutes after reopening still age the shortest frame");
  }
});

test("a fresh receipt with an old provider timestamp is delayed, never a current stream", () => {
  const received = new Date(NOW - 1000).toISOString(), provider = new Date(NOW - 43_000).toISOString();
  const quote = strataTickQuote({ price: "3551", received_at: received, tick_at: provider }, 3550, NOW);
  assert.deepEqual(quote, { price: 3551, quoteSource: "delayed", quoteReceivedAt: received, quoteProviderAt: provider });
  const fresh = strataTickQuote({ price: 3551, received_at: received, tick_at: new Date(NOW - 2000).toISOString() }, 3550, NOW);
  assert.equal(fresh?.quoteSource, "stream");
  const receiptOnly = strataTickQuote({ price: 3551, received_at: received }, 3550, NOW);
  assert.equal(receiptOnly?.quoteProviderAt, null, "no provider timestamp is invented");
});

test("malformed, future, too-old and implausible streaming quotes are rejected", () => {
  const valid: StrataTick = { price: 3551, received_at: new Date(NOW - 1000).toISOString(), tick_at: new Date(NOW - 2000).toISOString() };
  const invalid: (StrataTick | null)[] = [
    null, ...[0, -1, NaN, Infinity, "bad", 3700].map((price) => ({ ...valid, price })),
    { ...valid, received_at: "invalid" }, { ...valid, tick_at: "invalid" },
    { ...valid, received_at: new Date(NOW + 4000).toISOString() },
    { ...valid, tick_at: new Date(NOW + 4000).toISOString() },
    { ...valid, received_at: new Date(NOW - 60_001).toISOString() },
    { ...valid, tick_at: new Date(NOW - 60_001).toISOString() },
  ];
  for (const value of invalid) assert.equal(strataTickQuote(value, 3550, NOW), null);
});
