/**
 * ATLAS FEED — one honest, timestamped market state behind the chart, the price header, the read, chat and voice.
 *
 *   1. The feed status matrix (core/feed.ts computeFeedState): DEMO, MARKET CLOSED, LIVE, DELAYED, RECONNECTING,
 *      STALE — and a subscribed socket that has gone silent is never LIVE.
 *   2. The forming candle (core/formingCandle.ts): buckets that match the server's bars, boundaries, duplicates,
 *      out-of-order ticks, gaps that stay gaps, and server bars replacing local candles by timestamp.
 *   3. ATLAS's chart actions (core/atlasContract.ts validateChartAction, hud/chartActions.ts): hallucinated
 *      levels, candles and scenarios are rejected; a candle on another timeframe is a note, never a guess.
 *   4. The browser's intake and screen state (ingestTick, needsPolling, screenFeedState), the /tick payload, the
 *      replay's DEMO status, and the chart's basis label as drawn.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeFeedState, feedOfSnapshot, analysisMeta, tickPayload, ingestTick, emptyTape, needsPolling, screenFeedState,
  feedBasisLabel, feedAgeShort, clockOffset,
  FEED_LIVE_MS, FEED_SILENT_MS, FEED_STALE_MS, FEED_SNAPSHOT_MAX_MS, FEED_POLL_MS,
  type FeedInput, type TickTape,
} from "../command-center/core/feed";
import {
  bucketOf, phaseOf, tickVerdict, applyTick, emptyBook, candlesFromTicks, mergeCandles, withLiveCandles,
  TF_MS, CONTINUITY_MS, type LiveTick, type LiveCandle,
} from "../command-center/core/formingCandle";
import {
  validateChartAction, levelIdOf, ATLAS_READ_VERSION, CHART_TFS,
  type ChartActionContext, type FeedStatus, type FeedState, type Scenario,
} from "../command-center/core/atlasContract";
import { parseSeries } from "../command-center/adapters/twelvedata";
import { bucketStart } from "../command-center/core/bars";
import { marketOpen } from "../command-center/core/sessions";
import { TF_MINUTES, type Bar, type MarketSnapshot } from "../command-center/core/types";
import {
  receiveChartAction, settleChartActions, markNotes, applyChartAction, NO_CHART_ACTIONS, MARK_PENDING_MS,
} from "../src/components/command-center/hud/chartActions";

const S = 1_000, M = 60_000, HR = 3_600_000;
/** Tuesday 10 November 2026, 14:07:30 UTC — 09:07 in New York: gold is open. */
const NOW = Date.UTC(2026, 10, 10, 14, 7, 30);
/** Saturday — gold is shut. */
const SATURDAY = Date.UTC(2026, 10, 14, 15, 0, 0);
/** Tuesday 22:30 UTC — 17:30 New York, inside the daily break. */
const DAILY_BREAK = Date.UTC(2026, 10, 10, 22, 30, 0);
const PX = 4047.43595;

const input = (o: Partial<FeedInput> = {}): FeedInput => ({
  marketOpen: true, transport: "websocket_relay", price: PX,
  providerTs: NOW - 57 * S,              // Twelve Data stamps gold to the minute: the provider time lags
  receivedTs: NOW - 1 * S, now: NOW, replay: false,
  channel: "subscribed", channelSince: NOW - 10 * M,
  ...o,
});
const status = (o: Partial<FeedInput>): FeedStatus => computeFeedState(input(o)).status;

/* ── 1. the feed status matrix ───────────────────────────────────────────────────────────────────────── */

test("the calendar used by the matrix: open on a Tuesday morning, shut on Saturday and in the daily break", () => {
  assert.equal(marketOpen(NOW), true);
  assert.equal(marketOpen(SATURDAY), false);
  assert.equal(marketOpen(DAILY_BREAK), false);
});

test("feed status matrix: every state, in rule order", () => {
  const rows: [string, Partial<FeedInput>, FeedStatus][] = [
    // DEMO beats everything
    ["replay flag, fresh tick", { replay: true }, "demo"],
    ["replay transport", { transport: "replay", channel: null }, "demo"],
    ["replay while the market is shut", { replay: true, marketOpen: false }, "demo"],
    // MARKET CLOSED beats any socket activity
    ["closed with a fresh streamed tick", { marketOpen: false }, "closed"],
    ["closed with the channel errored", { marketOpen: false, channel: "error" }, "closed"],
    // LIVE: a streamed tick received within FEED_LIVE_MS
    ["streamed 1 s ago", {}, "live"],
    ["streamed exactly at the live limit", { receivedTs: NOW - FEED_LIVE_MS }, "live"],
    ["server read of the relayed row (no channel)", { channel: null, channelSince: null }, "live"],
    // DELAYED
    ["streamed just past the live limit", { receivedTs: NOW - FEED_LIVE_MS - 1 }, "delayed"],
    ["streamed 12 s ago (gold quiet)", { receivedTs: NOW - 12 * S }, "delayed"],
    ["subscribed but silent 16 s", { receivedTs: NOW - 16 * S }, "delayed"],
    ["polled 1 s ago", { transport: "poll", pollMs: FEED_POLL_MS }, "delayed"],
    ["polled while the channel connects", { transport: "poll", channel: "connecting", channelSince: NOW - 2 * S, pollMs: FEED_POLL_MS }, "delayed"],
    ["polled while the channel is errored", { transport: "poll", channel: "error", pollMs: FEED_POLL_MS }, "delayed"],
    ["snapshot 50 s old", { transport: "snapshot", receivedTs: NOW - 50 * S, channel: null }, "delayed"],
    ["snapshot just inside two minutes", { transport: "snapshot", receivedTs: NOW - FEED_SNAPSHOT_MAX_MS, channel: null }, "delayed"],
    // RECONNECTING: the channel is down and nothing fresh carries the screen
    ["channel errored, last streamed tick 2 s old", { channel: "error", receivedTs: NOW - 2 * S }, "reconnecting"],
    ["channel closed, last streamed tick 30 s old", { channel: "closed", receivedTs: NOW - 30 * S }, "reconnecting"],
    ["connecting, nothing yet", { channel: "connecting", channelSince: NOW - 3 * S, price: null, receivedTs: null }, "reconnecting"],
    ["subscribed 3 s, waiting for the first tick", { channelSince: NOW - 3 * S, price: null, receivedTs: null }, "reconnecting"],
    // STALE
    ["streamed 61 s ago, socket still subscribed", { receivedTs: NOW - FEED_STALE_MS - S }, "stale"],
    ["polled price 61 s old", { transport: "poll", receivedTs: NOW - FEED_STALE_MS - S, pollMs: FEED_POLL_MS }, "stale"],
    ["snapshot past two minutes", { transport: "snapshot", receivedTs: NOW - FEED_SNAPSHOT_MAX_MS - S, channel: null }, "stale"],
    ["channel errored and the held tick is 70 s old", { channel: "error", receivedTs: NOW - 70 * S }, "stale"],
    ["connecting for 70 s with nothing", { channel: "connecting", channelSince: NOW - 70 * S, price: null, receivedTs: null }, "stale"],
    ["subscribed 70 s and nothing ever arrived", { channelSince: NOW - 70 * S, price: null, receivedTs: null }, "stale"],
    ["server with no price", { channel: null, price: null, receivedTs: null }, "stale"],
    ["received time 10 s in the future (clock fault)", { receivedTs: NOW + 10 * S }, "stale"],
  ];
  for (const [name, o, want] of rows) {
    const f = computeFeedState(input(o));
    assert.equal(f.status, want, `${name}: ${f.reason}`);
    assert.ok(f.reason.length > 0 && !/[\n\r]/.test(f.reason), `${name}: the reason is one plain line`);
    assert.equal(f.checkedAt, NOW);
  }
});

test("a connected socket that stopped delivering is never LIVE, however long it stays subscribed", () => {
  for (let silentFor = FEED_LIVE_MS + 1; silentFor <= 10 * M; silentFor += 3_333) {
    const f = computeFeedState(input({ channel: "subscribed", receivedTs: NOW - silentFor }));
    assert.notEqual(f.status, "live", `silent ${silentFor} ms`);
  }
  const silent = computeFeedState(input({ receivedTs: NOW - (FEED_SILENT_MS + 2 * S) }));
  assert.equal(silent.status, "delayed");
  assert.match(silent.reason, /silent for 17 s/);
  assert.match(silent.reason, /polling every 2 s/);
  // A subscribed channel with NO price is not live either — whatever the socket says.
  assert.notEqual(status({ price: null, receivedTs: null }), "live");
  // A fresh tick that was POLLED is not live: a poll is not a stream, however fast.
  assert.equal(status({ transport: "poll", receivedTs: NOW - 100, pollMs: FEED_POLL_MS }), "delayed");
  // A fresh tick whose channel has just dropped cannot move any more: reconnecting, not live.
  assert.equal(status({ channel: "error", receivedTs: NOW - 100 }), "reconnecting");
});

test("freshness is judged on RECEIVED time; the provider's minute-resolution stamp is shown, never used", () => {
  // Observed live: tick_at 04:09:00, received 04:09:57, read 0.3 s later.
  const received = Date.UTC(2026, 10, 10, 4, 9, 57);
  const f = computeFeedState(input({ now: received + 300, receivedTs: received, providerTs: Date.UTC(2026, 10, 10, 4, 9, 0) }));
  assert.equal(f.status, "live");
  assert.equal(f.ageMs, 300);
  assert.equal(f.providerTs, Date.UTC(2026, 10, 10, 4, 9, 0), "the provider's time is kept beside the price");
  assert.equal(f.receivedTs, received);
  assert.equal(f.price, PX, "the 5-decimal composite is not rounded away");
  assert.deepEqual([f.provider, f.symbol, f.quoteType, f.transport], ["Twelve Data", "XAU/USD", "mid", "websocket_relay"]);
});

test("the reasons say the cadence and the cause, in plain words", () => {
  assert.match(computeFeedState(input({ transport: "poll", pollMs: 2_000 })).reason, /^Polled every 2 s — the stream is connected but not delivering; price received 1\.0 s ago\.$/);
  assert.match(computeFeedState(input({ transport: "poll", pollMs: 2_000, channel: "connecting" })).reason, /still connecting/);
  assert.match(computeFeedState(input({ transport: "poll", pollMs: null, channel: null })).reason, /^A requested quote — not streamed/);
  assert.match(computeFeedState(input({ transport: "snapshot", channel: null, receivedTs: NOW - 48 * S })).reason, /snapshot price \(written about once a minute\), 48 s old/);
  assert.match(computeFeedState(input({ marketOpen: false })).reason, /^Market closed — .*Last price 4047\.44, received 1\.0 s ago\.$/);
  assert.match(computeFeedState(input({ channel: "error", receivedTs: NOW - 2 * S })).reason, /^Reconnecting to the Twelve Data stream…/);
  assert.match(computeFeedState(input({ channel: "connecting", channelSince: NOW, price: null, receivedTs: null })).reason, /^Connecting to the Twelve Data stream…$/);
  assert.match(computeFeedState(input({ receivedTs: NOW + 10 * S })).reason, /clock problem/);
  assert.equal(computeFeedState(input({ receivedTs: NOW + 10 * S })).ageMs, null, "a future time has no age");
  assert.equal(computeFeedState(input({ receivedTs: NOW + 2 * S })).status, "live", "a small clock skew is tolerated as age 0");
  assert.match(computeFeedState(input({ replay: true })).reason, /^Demo — recorded XAU\/USD/);
});

test("the server's view of a snapshot: streamed tick, direct quote, the snapshot itself, the replay", () => {
  const snap = { price: 4040.1, at: NOW - 40 * S } as Pick<MarketSnapshot, "price" | "at" | "live">;
  const streamed = feedOfSnapshot({ ...snap, live: { price: 4041.2, at: NOW - 900, source: "stream" } }, { now: NOW, marketOpen: true, providerTs: NOW - 50 * S });
  assert.deepEqual([streamed.status, streamed.transport, streamed.price, streamed.providerTs], ["live", "websocket_relay", 4041.2, NOW - 50 * S]);
  const quoted = feedOfSnapshot({ ...snap, live: { price: 4041.3, at: NOW - 300, source: "quote" } }, { now: NOW, marketOpen: true, providerTs: NOW - 50 * S });
  assert.deepEqual([quoted.status, quoted.transport, quoted.providerTs], ["delayed", "poll", null], "a direct quote is a request, never live, and has no provider stamp");
  const bare = feedOfSnapshot(snap, { now: NOW, marketOpen: true });
  assert.deepEqual([bare.status, bare.transport, bare.price, bare.ageMs], ["delayed", "snapshot", 4040.1, 40 * S]);
  assert.equal(feedOfSnapshot(snap, { now: NOW, marketOpen: false }).status, "closed");
  assert.equal(feedOfSnapshot(snap, { now: NOW, marketOpen: true, replay: true }).status, "demo");
  assert.equal(feedOfSnapshot(null, { now: NOW, marketOpen: true }).status, "stale");
});

test("analysis meta: which persisted snapshot, which engine version, how old — on its own clock", () => {
  const a = analysisMeta({ snapshotVersion: "cc-1.0.0", at: NOW - 63 * S }, 98765, NOW);
  assert.deepEqual(a, { snapshotId: 98765, analysisVersion: "cc-1.0.0", analysisAt: NOW - 63 * S, analysisAgeMs: 63 * S, readVersion: ATLAS_READ_VERSION });
  assert.deepEqual(analysisMeta(null, null, NOW), { snapshotId: null, analysisVersion: "none", analysisAt: null, analysisAgeMs: null, readVersion: ATLAS_READ_VERSION });
});

test("the /tick payload: the relayed row, the server's clock, and the feed as a POLL (never live)", () => {
  const p = tickPayload({ price: PX, tickAt: NOW - 57 * S, receivedAt: NOW - 400, updatedAt: NOW - 350 }, { now: NOW, marketOpen: true });
  assert.equal(p.ok, true);
  assert.equal(p.serverTime, NOW);
  assert.deepEqual(p.tick, { symbol: "XAU/USD", price: PX, tickAt: NOW - 57 * S, receivedAt: NOW - 400, updatedAt: NOW - 350 });
  assert.deepEqual([p.feed.status, p.feed.transport, p.feed.providerTs, p.feed.ageMs], ["delayed", "poll", NOW - 57 * S, 400]);
  assert.match(p.feed.reason, /^Polled every 2 s — not streamed/);
  const none = tickPayload(null, { now: NOW, marketOpen: true });
  assert.equal(none.tick, null);
  assert.equal(none.feed.status, "stale");
  assert.equal(tickPayload(null, { now: SATURDAY, marketOpen: false }).feed.status, "closed");
  assert.equal(tickPayload({ price: PX, tickAt: Number.NaN, receivedAt: NOW, updatedAt: null }, { now: NOW, marketOpen: true }).tick?.tickAt, null);
});

test("the chart's basis label: provider, instrument, quote type, status and age", () => {
  const live = computeFeedState(input({ receivedTs: NOW - 1_200 }));
  assert.equal(feedBasisLabel(live), "Twelve Data · XAU/USD composite (mid) · LIVE · 1s");
  assert.equal(feedBasisLabel(null), "Twelve Data · XAU/USD composite (mid)", "no feed: no claim about being live");
  assert.equal(feedBasisLabel(computeFeedState(input({ marketOpen: false }))), "Twelve Data · XAU/USD composite (mid) · MARKET CLOSED");
  assert.equal(feedBasisLabel(computeFeedState(input({ receivedTs: NOW - 75 * S }))), "Twelve Data · XAU/USD composite (mid) · STALE · 1m");
  assert.deepEqual([feedAgeShort(300), feedAgeShort(4_900), feedAgeShort(3 * M + 1), feedAgeShort(2 * HR), feedAgeShort(3 * 86_400_000)], ["<1s", "4s", "3m", "2h", "3d"]);
  assert.equal(clockOffset(10_500, 10_000, 10_200), 400);
});

/* ── 2. the browser: intake, polling decision, the one state the screen shows ───────────────────────────── */

const tk = (sec: number, price = PX): LiveTick => ({ price, receivedTs: NOW + sec * S, providerTs: NOW - 60 * S });

test("intake: dedupe by received time, out-of-order dropped, future and bad prints refused, counters kept", () => {
  let tape: TickTape = emptyTape();
  const step = (t: LiveTick | null, via: "realtime" | "poll", now = NOW + 30 * S) => {
    const r = ingestTick(tape, t, via, { now });
    tape = r.tape;
    return r.verdict;
  };
  assert.equal(step(tk(0), "poll"), "accept");
  assert.equal(tape.via, "poll");
  assert.equal(step(tk(0), "realtime"), "duplicate", "the same row from Realtime after the poll counts once");
  assert.equal(tape.via, "realtime", "…and shows the stream is delivering");
  assert.equal(tape.ticks.length, 1);
  assert.equal(step(tk(2, PX + 0.5), "realtime"), "accept");
  assert.equal(step(tk(1, PX - 9), "poll"), "out_of_order", "an older tick never overwrites a newer one");
  assert.equal(tape.last?.price, PX + 0.5);
  assert.equal(step(tk(3, PX * 1.2), "realtime"), "outlier", "a 20% jump in a second is a bad print");
  assert.equal(step(tk(500), "realtime", NOW), "future", "a tick from the future is a clock fault");
  assert.equal(step(null, "poll"), "invalid");
  assert.equal(step(tk(9, PX + 1), "realtime"), "accept");
  assert.deepEqual(tape.ticks.map((t) => t.receivedTs - NOW), [0, 2_000, 9_000]);
  const s = tape.stats;
  assert.deepEqual(
    [s.ticksReceived, s.duplicates, s.outOfOrder, s.rejected, s.lastGapMs, s.maxGapMs, s.lastTickAt],
    [3, 1, 1, 3, 7_000, 7_000, NOW + 9 * S],
  );
  // The tape keeps only the recent edge.
  let t2 = emptyTape();
  for (let i = 0; i < 10; i++) t2 = ingestTick(t2, tk(i * 60), "realtime", { now: NOW + HR, keepMs: 5 * M }).tape;
  assert.deepEqual(t2.ticks.map((t) => (t.receivedTs - NOW) / M), [4, 5, 6, 7, 8, 9]);
});

test("polling runs whenever the channel is not SUBSCRIBED or has gone silent — while gold is open", () => {
  assert.equal(needsPolling({ channel: "subscribed", marketOpen: true, quietForMs: 3 * S }), false);
  assert.equal(needsPolling({ channel: "subscribed", marketOpen: true, quietForMs: FEED_SILENT_MS + 1 }), true, "silent");
  for (const ch of ["connecting", "error", "closed", null] as const) assert.equal(needsPolling({ channel: ch, marketOpen: true, quietForMs: 0 }), true, String(ch));
  assert.equal(needsPolling({ channel: "error", marketOpen: false, quietForMs: 0 }), false, "nothing moves while gold is shut");
  assert.equal(needsPolling({ channel: "error", marketOpen: true, quietForMs: 0, refused: true }), false, "refused: nothing is asked");
});

test("the screen's one state: the stream's tick, or the /live answer's price when that is fresher", () => {
  const base = { now: NOW, marketOpen: true, demo: false, channel: "subscribed" as const, channelSince: NOW - 10 * M };
  const viaRt = { last: { price: PX, receivedTs: NOW - 800 }, via: "realtime" as const };
  assert.equal(screenFeedState({ ...base, tape: viaRt }).status, "live");
  assert.equal(screenFeedState({ ...base, tape: { ...viaRt, via: "poll" } }).status, "delayed");
  assert.equal(screenFeedState({ ...base, channel: "error", tape: viaRt }).status, "reconnecting");
  // The stream went quiet 3 minutes ago; the engine's snapshot is 20 s old → that is the price, DELAYED, said so.
  const old = { last: { price: 4030, receivedTs: NOW - 3 * M }, via: "realtime" as const };
  const snap = computeFeedState(input({ transport: "snapshot", channel: null, price: 4041, receivedTs: NOW - 20 * S }));
  const s1 = screenFeedState({ ...base, tape: old, server: snap });
  assert.deepEqual([s1.status, s1.transport, s1.price], ["delayed", "snapshot", 4041]);
  // A streamed price inside the /live answer reached the browser by a 5-second poll: DELAYED, never LIVE here.
  const srvStream = computeFeedState(input({ channel: null, price: 4042, receivedTs: NOW - 700 }));
  assert.equal(srvStream.status, "live", "LIVE on the server at the moment it answered");
  const s2 = screenFeedState({ ...base, tape: old, server: srvStream });
  assert.deepEqual([s2.status, s2.transport, s2.price], ["delayed", "poll", 4042]);
  assert.match(s2.reason, /Polled every 5 s/);
  // An older server price never displaces a fresher streamed one.
  assert.equal(screenFeedState({ ...base, tape: viaRt, server: snap }).price, PX);
  // The replay: DEMO, whatever arrives.
  assert.equal(screenFeedState({ ...base, demo: true, tape: viaRt }).status, "demo");
  assert.equal(screenFeedState({ ...base, tape: emptyTape(), server: computeFeedState(input({ replay: true })) }).status, "demo");
  // Shut: MARKET CLOSED, with the last price.
  const closed = screenFeedState({ ...base, marketOpen: false, tape: viaRt });
  assert.deepEqual([closed.status, closed.price], ["closed", PX]);
});

/* ── 3. the forming candle ─────────────────────────────────────────────────────────────────────────────── */

const T0 = Date.UTC(2026, 10, 10, 14, 0, 0);
const at = (min: number, sec = 0) => T0 + min * M + sec * S;
const bar = (t: number, o: number, h: number, l: number, c: number, v?: number): Bar => ({ t, o, h, l, c, ...(v != null ? { v } : {}) });
const tick = (min: number, sec: number, price: number): LiveTick => ({ price, receivedTs: at(min, sec) });

test("buckets match how the server stamps its bars: Twelve Data open times under timezone=UTC, core/bars.ts", () => {
  const td = parseSeries({ values: [
    { datetime: "2026-11-10 14:05:00", open: "1", high: "1", low: "1", close: "1" },
    { datetime: "2026-11-10 14:00:00", open: "1", high: "1", low: "1", close: "1" },
  ] });
  assert.deepEqual(td.map((b) => b.t), [at(0), at(5)], "parsed oldest first, at the bar's OPEN time in UTC");
  assert.equal(bucketOf(at(7, 59), "5m"), at(5), "a tick inside 14:05–14:10 belongs to the 14:05 bar");
  for (const tf of CHART_TFS) {
    for (const t of [at(7, 13), at(59, 59), Date.UTC(2026, 10, 10, 23, 31), Date.UTC(2026, 10, 11, 0, 0, 0)]) {
      assert.equal(bucketOf(t, tf), bucketStart(t, TF_MINUTES[tf]), `${tf} on the same grid as core/bars.ts`);
    }
  }
  assert.equal(bucketOf(Date.UTC(2026, 10, 10, 15, 30), "4h"), Date.UTC(2026, 10, 10, 12, 0), "4h at 00/04/08/12/16/20 UTC");
  assert.equal(bucketOf(Date.UTC(2026, 10, 10, 15, 30), "1d"), Date.UTC(2026, 10, 10, 0, 0), "1d at 00:00 UTC");
  assert.equal(TF_MS["15m"], 15 * M);
});

test("a server series on another phase is followed, and one odd bar cannot shift the grid", () => {
  const h4 = [2, 6, 10, 14].map((h) => bar(Date.UTC(2026, 10, 10, h), 1, 1, 1, 1));
  assert.equal(phaseOf(h4, "4h"), 2 * HR);
  assert.equal(bucketOf(Date.UTC(2026, 10, 10, 15, 30), "4h", phaseOf(h4, "4h")), Date.UTC(2026, 10, 10, 14), "a 15:30 tick joins the 14:00 bar of a 02/06/10/14 series");
  const daily = [9, 10, 11, 12].map((d) => bar(Date.UTC(2026, 10, d), 1, 1, 1, 1));
  const withOdd = [...daily.slice(0, 3), bar(Date.UTC(2026, 10, 11, 23), 1, 1, 1, 1), daily[3]];
  assert.equal(phaseOf(withOdd, "1d"), 0, "the majority sets the phase");
  assert.equal(phaseOf([], "1h"), 0);
});

test("the forming candle: moves with every tick, opens a new candle at the boundary with open = first tick", () => {
  let book = emptyBook("5m");
  const seen: number[] = [];
  for (const k of [tick(3, 0, 4040), tick(3, 1, 4041.2), tick(4, 58, 4039.6), tick(5, 1, 4039.9), tick(5, 2, 4040.4)]) {
    book = applyTick(book, k);
    seen.push(book.candles[book.candles.length - 1].c);
  }
  assert.deepEqual(seen, [4040, 4041.2, 4039.6, 4039.9, 4040.4], "the close follows every tick, not the candle close");
  assert.equal(book.candles.length, 2);
  const [a, b] = book.candles;
  assert.deepEqual([a.t, a.o, a.h, a.l, a.c, a.n], [at(0), 4040, 4041.2, 4039.6, 4039.6, 3]);
  assert.deepEqual([b.t, b.o, b.h, b.l, b.c, b.n], [at(5), 4039.9, 4040.4, 4039.9, 4040.4, 2], "the new candle opens at its first tick");
  assert.equal(a.partialOpen, true, "the first candle's open is only the first price we saw");
  assert.equal(b.partialOpen, false, "a boundary crossed within seconds: the open is the real one");
});

test("duplicates and out-of-order ticks change nothing", () => {
  let book = applyTick(applyTick(emptyBook("1h"), tick(1, 0, 4040)), tick(1, 5, 4042));
  const before = book;
  book = applyTick(book, tick(1, 5, 4042));
  assert.equal(book, before, "the same tick twice is ignored (the same book comes back)");
  book = applyTick(book, tick(1, 5, 4050));
  assert.equal(book, before, "a different price at an already-seen received time is ignored too");
  book = applyTick(book, tick(1, 2, 4030));
  assert.equal(book, before, "a tick received before the last applied one cannot rewrite the close or the low");
  assert.equal(tickVerdict({ price: 4040, receivedTs: at(1) }, { price: 4040, receivedTs: at(1) }), "duplicate");
  assert.equal(tickVerdict({ price: 4040, receivedTs: at(1) }, { price: 4040, receivedTs: at(0) }), "out_of_order");
  assert.equal(tickVerdict(null, { price: Number.NaN, receivedTs: at(0) }), "invalid");
  const folded = candlesFromTicks([tick(1, 0, 4040), tick(1, 5, 4042), tick(1, 5, 4042), tick(1, 2, 4030), tick(1, 9, 4041)], "1h");
  assert.deepEqual(folded.map((c) => [c.o, c.h, c.l, c.c, c.n]), [[4040, 4042, 4040, 4041, 3]]);
});

test("a gap stays a gap: no flat candles, no carried-forward closes", () => {
  const cs = candlesFromTicks([tick(1, 0, 4040), tick(2, 0, 4041), tick(17, 0, 4046), tick(18, 0, 4045)], "5m");
  assert.deepEqual(cs.map((c) => c.t), [at(0), at(15)], "14:05 and 14:10 had no ticks: they are not drawn");
  assert.equal(cs[1].o, 4046, "the candle after the gap opens at its own first tick, not the last close before the gap");
  assert.equal(cs[1].partialOpen, true, "and says its open is only the first price seen");
  assert.ok(CONTINUITY_MS < 15 * M);
  // Merged with server bars that stop at 14:00, the gap is still a gap.
  const merged = withLiveCandles([bar(at(-5), 4038, 4040, 4037, 4039.5), bar(at(0), 4039.5, 4040.5, 4039, 4040)], [tick(1, 0, 4040), tick(17, 0, 4046)], "5m");
  assert.deepEqual(merged.map((c) => (c.t - T0) / M), [-5, 0, 15]);
});

test("server bars replace local candles by timestamp (backfill and repair); the newest server bar is extended", () => {
  const server: Bar[] = [
    bar(at(0), 4040, 4042, 4039, 4041, 310),
    bar(at(5), 4041, 4043, 4040.5, 4042.5, 280),
    bar(at(15), 4044, 4045, 4043.5, 4044.2, 120),   // the newest server bar — possibly still forming
  ];
  const local: LiveCandle[] = [
    { t: at(-10), o: 4030, h: 4031, l: 4029, c: 4030, n: 3, firstAt: at(-10), lastAt: at(-9), partialOpen: true },   // before the window
    { t: at(5), o: 4000, h: 4100, l: 3900, c: 4001, n: 5, firstAt: at(5), lastAt: at(9), partialOpen: true },         // server has it
    { t: at(10), o: 4042.6, h: 4043.9, l: 4042.1, c: 4043.8, n: 9, firstAt: at(10), lastAt: at(14, 59), partialOpen: false }, // a hole in the server's series
    { t: at(15), o: 4043.9, h: 4046.25, l: 4043.7, c: 4045.9, n: 40, firstAt: at(15), lastAt: at(19, 50), partialOpen: false },
    { t: at(20), o: 4046, h: 4046.4, l: 4045.8, c: 4046.1, n: 6, firstAt: at(20, 1), lastAt: at(20, 9), partialOpen: false },
  ];
  const out = mergeCandles(server, local, "5m");
  assert.deepEqual(out.map((c) => (c.t - T0) / M), [0, 5, 10, 15, 20], "sorted; the candle before the window is dropped");
  assert.deepEqual(out[1], { t: at(5), o: 4041, h: 4043, l: 4040.5, c: 4042.5, v: 280 }, "the server's bar is the record for 14:05");
  assert.deepEqual(out[2], { t: at(10), o: 4042.6, h: 4043.9, l: 4042.1, c: 4043.8, live: true }, "real ticks where the server has no bar are kept, marked unconfirmed");
  assert.deepEqual(out[3], { t: at(15), o: 4044, h: 4046.25, l: 4043.5, c: 4045.9, v: 120, live: true }, "server open, wider range, newest close");
  assert.deepEqual(out[4], { t: at(20), o: 4046, h: 4046.4, l: 4045.8, c: 4046.1, live: true });

  // Once the server's newest bar is known closed, it wins outright.
  const final = mergeCandles(server, local, "5m", { serverAsOf: at(20, 5) });
  assert.deepEqual(final[3], { t: at(15), o: 4044, h: 4045, l: 4043.5, c: 4044.2, v: 120 });
  // Ticks older than the server's read do not override its close (but the range still widens).
  const olderTicks = mergeCandles(server, local, "5m", { serverAsOf: at(19, 55) });
  assert.deepEqual([olderTicks[3].c, olderTicks[3].h], [4044.2, 4046.25]);

  // The backfill arrives: local candles for 14:10 and 14:20 are replaced by the server's.
  const backfilled = mergeCandles([...server, bar(at(10), 4042.5, 4044, 4042, 4043.7, 200), bar(at(20), 4045.8, 4046.6, 4045.6, 4046, 90)], local, "5m");
  assert.deepEqual(backfilled.map((c) => [(c.t - T0) / M, c.c, !!c.live]), [[0, 4041, false], [5, 4042.5, false], [10, 4043.7, false], [15, 4044.2, false], [20, 4046.1, true]]);
  // A repaired server bar (same open time, later in the list) replaces the earlier one.
  const repaired = mergeCandles([bar(at(0), 4040, 4042, 4039, 4041), bar(at(0), 4040, 4042.4, 4039, 4041.6)], [], "5m");
  assert.deepEqual(repaired, [{ t: at(0), o: 4040, h: 4042.4, l: 4039, c: 4041.6 }]);
});

test("prices are rounded for display; the merge never invents a candle", () => {
  const out = withLiveCandles([bar(at(0), 4040.123456, 4041.98765, 4039.004, 4040.5)], [{ price: PX, receivedTs: at(6) }, { price: 4047.4449, receivedTs: at(6, 1) }], "5m");
  assert.deepEqual(out, [
    { t: at(0), o: 4040.12, h: 4041.99, l: 4039, c: 4040.5 },
    { t: at(5), o: 4047.44, h: 4047.44, l: 4047.44, c: 4047.44, live: true, partialOpen: true },
  ]);
  // Ten minutes of ticks on 1h opens exactly one candle per hour bucket that saw a tick.
  const ticks: LiveTick[] = Array.from({ length: 600 }, (_, i) => ({ price: 4040 + Math.sin(i / 9), receivedTs: at(55) + i * S }));
  const cs = withLiveCandles([bar(at(-60), 4030, 4041, 4029, 4040)], ticks, "1h");
  assert.deepEqual(cs.map((c) => (c.t - T0) / HR), [-1, 0, 1]);
});

/* ── 4. ATLAS's chart actions ──────────────────────────────────────────────────────────────────────────── */

const LEVELS = [
  { kind: "pdh", price: 4061.2, label: "yesterday's high" },
  { kind: "asia_low", price: 4031.75, label: "asia low" },
];
const CTX: ChartActionContext = {
  levels: LEVELS,
  candles: { "15m": [at(0), at(15), at(30)] },
  scenarios: [{ id: "base-1" }, { id: "alt-1" }],
  price: 4047.4,
};

test("validateChartAction: real levels, candles and scenarios pass; hallucinated ones are rejected", () => {
  assert.equal(levelIdOf(LEVELS[0]), "pdh@4061.20");
  // levels — the ID must match a real level, and the price drawn is the level's, never the action's
  assert.deepEqual(validateChartAction({ type: "highlight_level", levelId: "pdh@4061.20", price: 9999, label: "" }, CTX),
    { type: "highlight_level", levelId: "pdh@4061.20", price: 4061.2, label: "yesterday's high" });
  assert.equal(validateChartAction({ type: "highlight_level", levelId: "pdh@4070.00", price: 4070, label: "PDH" }, CTX), null, "a level that does not exist");
  assert.equal(validateChartAction({ type: "highlight_level", levelId: "pwh@4061.20", label: "weekly high" }, CTX), null, "a real price under a made-up kind");
  // candles — a known open time on that timeframe only
  assert.deepEqual(validateChartAction({ type: "mark_candle", tf: "15m", t: at(15), label: "sweep" }, CTX), { type: "mark_candle", tf: "15m", t: at(15), label: "sweep" });
  assert.equal(validateChartAction({ type: "mark_candle", tf: "15m", t: at(20), label: "x" }, CTX), null, "not a 15m open time");
  assert.equal(validateChartAction({ type: "mark_candle", tf: "1h", t: at(0), label: "x" }, CTX), null, "a timeframe the chart does not hold");
  assert.equal(validateChartAction({ type: "mark_candle", tf: "2h", t: at(0), label: "x" }, CTX), null, "not a timeframe");
  // scenarios
  assert.deepEqual(validateChartAction({ type: "scenario", scenarioId: "alt-1" }, CTX), { type: "scenario", scenarioId: "alt-1" });
  assert.equal(validateChartAction({ type: "scenario", scenarioId: "moon-shot" }, CTX), null, "a scenario that does not exist");
  assert.deepEqual(validateChartAction({ type: "scenario", scenarioId: null }, CTX), { type: "scenario", scenarioId: null }, "null hides the overlay");
  // zones — ordered, finite, near the price
  assert.deepEqual(validateChartAction({ type: "show_zone", from: 4052, to: 4049, label: "supply" }, CTX), { type: "show_zone", from: 4049, to: 4052, label: "supply" });
  assert.equal(validateChartAction({ type: "show_zone", from: 4450, to: 4460, label: "far" }, CTX), null, "10% from the price");
  assert.equal(validateChartAction({ type: "show_zone", from: 3950, to: 4100, label: "wide" }, CTX), null, "wider than 3% of the price");
  assert.equal(validateChartAction({ type: "show_zone", from: "abc", to: 4050, label: "nan" }, CTX), null);
  // timeframe, clear, junk
  assert.deepEqual(validateChartAction({ type: "timeframe", tf: "1h" }, CTX), { type: "timeframe", tf: "1h" });
  assert.equal(validateChartAction({ type: "timeframe", tf: "3m" }, CTX), null);
  assert.deepEqual(validateChartAction({ type: "clear" }, CTX), { type: "clear" });
  assert.equal(validateChartAction({ type: "draw_anything", x: 1 }, CTX), null);
  assert.equal(validateChartAction("highlight_level", CTX), null);
  assert.equal(validateChartAction(null, CTX), null);
});

test("the chart's overlay: validated actions drawn, other-timeframe candles as a note, timeframe left to the screen", () => {
  const now = at(40);
  // drawn
  let o = receiveChartAction(NO_CHART_ACTIONS, { type: "highlight_level", levelId: "asia_low@4031.75", label: "" }, CTX, "15m", now);
  assert.equal(o.outcome, "drawn");
  assert.deepEqual(o.overlay.highlights, [{ levelId: "asia_low@4031.75", price: 4031.75, label: "asia low" }]);
  o = receiveChartAction(o.overlay, { type: "scenario", scenarioId: "base-1" }, CTX, "15m", now);
  assert.equal(o.overlay.scenarioId, "base-1");
  // hallucinations are rejected and change nothing
  for (const raw of [
    { type: "highlight_level", levelId: "pdh@4099.00", label: "made up" },
    { type: "scenario", scenarioId: "invented" },
    { type: "mark_candle", tf: "15m", t: at(15) + 7, label: "not a minute" },
    { type: "mark_candle", tf: "1h", t: now + 5 * HR, label: "the future" },
    { type: "show_zone", from: 1, to: 2, label: "nowhere" },
  ]) {
    const r = receiveChartAction(o.overlay, raw, CTX, "15m", now);
    assert.equal(r.outcome, "rejected", JSON.stringify(raw));
    assert.equal(r.overlay, o.overlay);
  }
  // the timeframe action is the screen's job: the chart reports it and leaves its overlay alone
  const tfA = receiveChartAction(o.overlay, { type: "timeframe", tf: "1h" }, CTX, "15m", now);
  assert.deepEqual([tfA.outcome, tfA.overlay], ["timeframe", o.overlay]);
  // a candle on another timeframe: a note, not a guess
  const hourT = Date.UTC(2026, 10, 10, 13, 0);
  const el = receiveChartAction(o.overlay, { type: "mark_candle", tf: "1h", t: hourT, label: "sweep candle" }, CTX, "15m", now);
  assert.equal(el.outcome, "elsewhere");
  assert.equal(el.overlay.marks.length, 0, "nothing drawn on the 15m chart");
  assert.equal(receiveChartAction(o.overlay, { type: "mark_candle", tf: "1h", t: hourT, label: "x" }, CTX, undefined, now).outcome, "rejected",
    "a chart that does not know its timeframe cannot say where to look");
  const notes = markNotes(el.overlay, "15m");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, "ATLAS · sweep candle: the 1h candle of 13:00 UTC — switch to 1h to see it");
  // the screen switches to 1h and the candle is really there → drawn, the note goes
  const ctx1h: ChartActionContext = { ...CTX, candles: { "1h": [hourT - HR, hourT, hourT + HR] } };
  const settled = settleChartActions(el.overlay, ctx1h, "1h", now + 2 * S);
  assert.deepEqual(settled.marks, [{ tf: "1h", t: hourT, label: "sweep candle" }]);
  assert.equal(settled.elsewhere.length, 0);
  assert.equal(markNotes(settled, "1h").length, 0);
  // …and if it is not there, it is dropped after a short wait rather than placed somewhere near
  const ctxWithout: ChartActionContext = { ...CTX, candles: { "1h": [hourT - HR, hourT + HR] } };
  const waiting = settleChartActions(el.overlay, ctxWithout, "1h", now + 2 * S);
  assert.equal(waiting.marks.length, 0);
  assert.equal(markNotes(waiting, "1h").length, 0, "no note telling you to switch to the timeframe you are on");
  const dropped = settleChartActions(waiting, ctxWithout, "1h", now + 2 * S + MARK_PENDING_MS + 1);
  assert.deepEqual([dropped.marks.length, dropped.elsewhere.length], [0, 0]);
  // clear
  assert.equal(applyChartAction(settled, { type: "clear" }), NO_CHART_ACTIONS);
  assert.equal(settleChartActions(NO_CHART_ACTIONS, CTX, "15m", now), NO_CHART_ACTIONS, "nothing waiting: the same object");
});

/* ── 5. the chart, drawn ───────────────────────────────────────────────────────────────────────────────── */

test("the chart: the forming candle follows the ticks, and the basis label says exactly what the price is", async () => {
  const React = await import("react");
  (globalThis as unknown as { React: unknown }).React = React;     // the test runner compiles JSX the classic way
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { GoldChart, ScenarioOverlay } = await import("../src/components/command-center/hud/GoldChart");
  const server: Bar[] = Array.from({ length: 30 }, (_, i) => bar(at(-150 + i * 5), 4040 + i * 0.1, 4040.6 + i * 0.1, 4039.6 + i * 0.1, 4040.2 + i * 0.1));
  const props = {
    bars: server, price: 4043.1, markers: [], zones: [], lines: [], path: null, pathLabel: "Atlas scenario",
    showOverlays: true, showLiquidity: true, tfLabel: "XAUUSD · 5m", activityLabel: "Activity",
  };
  const plain = renderToStaticMarkup(React.createElement(GoldChart, props));
  assert.ok(plain.includes("Twelve Data · XAU/USD composite (mid)"), "the basis is always said");
  assert.ok(!/\bLIVE\b/.test(plain), "without a feed state the chart claims nothing about being live");
  assert.ok(!plain.includes("Return to live"), "following the newest candle: no return button");

  const feed: FeedState = computeFeedState({ marketOpen: true, transport: "websocket_relay", price: 4052.31, providerTs: at(5), receivedTs: at(5, 40), now: at(5, 41, ), replay: false, channel: "subscribed", channelSince: at(-30) });
  const ticks: LiveTick[] = [{ price: 4051.2, receivedTs: at(5, 2) }, { price: 4053.05, receivedTs: at(5, 20) }, { price: 4052.31, receivedTs: at(5, 40) }];
  const live = renderToStaticMarkup(React.createElement(GoldChart, { ...props, tf: "5m", ticks, feed }));
  assert.ok(live.includes("Twelve Data · XAU/USD composite (mid) · LIVE · 1s"), live.match(/data-basis[^>]*>([^<]*)/)?.[1]);
  assert.ok(live.includes("4,052.31"), "the readout shows the forming candle's close — the newest tick");
  assert.ok(live.includes("forming"), "and says the candle is still forming");
  assert.ok(live.includes(">4052.31<"), "the price tag carries the feed's price");

  const sc: Scenario = {
    id: "base-1", role: "base", title: "Hold above the Asia low, retest 4,061", tf: "1h", direction: "up", evidence: [],
    trigger: { text: "15m close above 4,055", price: 4055 }, invalidation: { text: "below 4,031.75", price: 4031.75 },
    status: "watching", since: at(0), updatedAt: at(5), history: [],
  };
  const overlay = renderToStaticMarkup(React.createElement("svg", null, React.createElement(ScenarioOverlay, {
    scenario: sc, x0: 700, x1: 840, fromX: 690, fromY: 200, y: (p: number) => 400 - (p - 4000), priceH: 380, compact: false,
  })));
  assert.ok(overlay.includes("CONDITIONAL SCENARIO"), "labelled as conditional, never as a forecast");
  assert.ok(/stroke-dasharray="6 4"/.test(overlay), "the path is dashed — visually distinct from price history");
  assert.ok(overlay.includes("Trigger 4,055.00") && overlay.includes("Invalidation 4,031.75"));
});

/* ── 6. the replay is DEMO ─────────────────────────────────────────────────────────────────────────────── */

test("the replay endpoint's state reports DEMO and names its analysis", async () => {
  const { replay } = await import("../command-center/engines/replay");
  const r = replay(46);
  assert.equal(r.state.feed.status, "demo");
  assert.equal(r.state.feed.transport, "replay");
  assert.equal(r.state.live, false);
  assert.deepEqual(r.state.analysis, { snapshotId: null, analysisVersion: r.snapshot.snapshotVersion, analysisAt: r.snapshot.at, analysisAgeMs: 0, readVersion: ATLAS_READ_VERSION });
});

/* ── 7. the plumbing: the Realtime migration and the hook's contract ───────────────────────────────────── */

test("the realtime migration: added to the publication idempotently; the gold row readable by signed-in members only", () => {
  const up = readFileSync("supabase/migrations/20261111020000_market_live_ticks_realtime.sql", "utf8");
  const down = readFileSync("supabase/migrations/20261111020000_market_live_ticks_realtime_down.sql", "utf8");
  const code = (sql: string) => sql.replace(/--.*$/gm, "");
  assert.match(up, /if exists \(select 1 from pg_publication where pubname = 'supabase_realtime'\)/);
  assert.match(up, /alter publication supabase_realtime add table public\.market_live_ticks';\s+exception when duplicate_object then null;/);
  assert.match(up, /drop policy if exists market_live_ticks_gold_read on public\.market_live_ticks;\s+create policy market_live_ticks_gold_read on public\.market_live_ticks\s+for select to authenticated\s+using \(symbol = 'XAU\/USD'\);/);
  assert.ok(!/for (insert|update|delete|all)\b/i.test(code(up)) && !/\banon\b/.test(code(up)), "select only, and nothing for anon");
  assert.match(down, /drop policy if exists market_live_ticks_gold_read on public\.market_live_ticks;/);
  assert.match(down, /alter publication supabase_realtime drop table public\.market_live_ticks/);
});

test("the hook listens to the one gold row, falls back to /tick, and tears everything down", () => {
  const src = readFileSync("src/components/command-center/hud/useLiveFeed.ts", "utf8");
  for (const must of [
    '"postgres_changes", { event: "INSERT", schema: "public", table: TABLE, filter }',
    '"postgres_changes", { event: "UPDATE", schema: "public", table: TABLE, filter }',
    'const TABLE = "market_live_ticks"', "const filter = `symbol=eq.${SYMBOL}`", 'endpoint = "/api/command-center/tick"',
    "ingestTick(", "needsPolling(", "screenFeedState(", "setInterval(evaluate, WATCHDOG_MS)",
    "clearInterval(watchdog)", "clearInterval(pollTimer)", "clearTimeout(resubTimer)", "clearTimeout(retryTimer)",
    "inflight?.abort()", "sb.removeChannel(rt)", 'removeEventListener("visibilitychange"',
  ]) assert.ok(src.includes(must), must);
  assert.ok(!/service_role|SERVICE_ROLE|TWELVEDATA_API_KEY/.test(src), "no credential reaches the browser");
});
