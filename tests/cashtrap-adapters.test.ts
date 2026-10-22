import test from "node:test";
import assert from "node:assert/strict";
import { checkHistory, liveFreshness, M5, normalizeRows, splitCompleted, type Candle } from "../src/lib/cashtrap/candles";
import { isOpen, tolerated } from "../src/lib/cashtrap/marketHours";
import { configVersion, DEFAULT_ASSUMPTIONS, resolveAssumptions } from "../src/lib/cashtrap/config";
import { normalizeSymbol, parseDmiEvent, secretMatches } from "../src/lib/cashtrap/dmiIngest";
import { cardStatus } from "../src/lib/cashtrap/snapshot";
import { parseReplayParams } from "../src/lib/cashtrap/jobs";
import type { SignalRecord } from "../src/lib/cashtrap/signals";

/* ── market data: parsing, boundaries, duplicates, order, freshness ───────────────────────────── */
test("feed rows: UTC open times on 5-minute boundaries; impossible prices and conflicting duplicates are refused; order does not matter", () => {
  const r = normalizeRows([
    { datetime: "2026-10-21 14:05:00", open: "1.1", high: "1.2", low: "1.0", close: "1.15" },
    { datetime: "2026-10-21 14:00:00", open: "1.1", high: "1.2", low: "1.0", close: "1.1" },
    { datetime: "2026-10-21 14:00:00", open: "1.1", high: "1.2", low: "1.0", close: "1.1" },      // same again: merged
    { datetime: "2026-10-21 14:10:00", open: "1.1", high: "1.2", low: "1.0", close: "1.1" },
    { datetime: "2026-10-21 14:10:00", open: "1.1", high: "1.2", low: "1.0", close: "1.19" },     // differs: both refused
    { datetime: "2026-10-21 14:12:00", open: "1.1", high: "1.2", low: "1.0", close: "1.1" },      // not a boundary
    { datetime: "2026-10-21 14:15:00", open: "1.1", high: "1.05", low: "1.0", close: "1.1" },     // high below open
  ]);
  assert.deepEqual(r.candles.map((k) => new Date(k.t).toISOString()), ["2026-10-21T14:00:00.000Z", "2026-10-21T14:05:00.000Z"]);
  assert.equal(r.issues.length, 3);
});

test("a candle is completed only once the feed has had time to settle it; the forming one is separate", () => {
  const t = Date.UTC(2026, 9, 21, 14, 0);
  const c = (k: number): Candle => ({ t: t + k * M5, o: 1, h: 1, l: 1, c: 1 });
  const s = splitCompleted([c(0), c(1), c(2)], t + 2 * M5 + 3_000, 8_000);
  assert.deepEqual(s.completed.map((k) => k.t), [t], "the candle that closed 3 s ago is not yet complete");
  assert.equal(s.developing?.t, t + 2 * M5);
});

test("trading hours: weekend closure, the fx rollover and gold's daily break are not data gaps — a mid-week hole is", () => {
  const fri = Date.UTC(2026, 9, 23, 20, 55);   // Friday 16:55 New York (EDT)
  assert.equal(isOpen("fx", fri), true);
  assert.equal(isOpen("fx", fri + M5), false, "Friday 17:00 New York: closed");
  assert.equal(isOpen("fx", Date.UTC(2026, 9, 25, 21, 0)), true, "Sunday 17:00 New York: fx open");
  assert.equal(isOpen("metal", Date.UTC(2026, 9, 25, 21, 0)), false, "gold opens an hour later");
  assert.equal(isOpen("metal", Date.UTC(2026, 9, 21, 21, 30)), false, "gold's daily break, 17:00–18:00 New York");
  assert.equal(tolerated("fx", Date.UTC(2026, 9, 21, 21, 5)), true, "fx rollover candle may be missing");
  const before: Candle[] = Array.from({ length: 20 }, (_, i) => ({ t: fri - (19 - i) * M5, o: 1, h: 1, l: 1, c: 1 }));
  const monday = Date.UTC(2026, 9, 25, 21, 0);
  const after: Candle[] = [...before, { t: monday, o: 1, h: 1, l: 1, c: 1 }];
  assert.deepEqual(checkHistory("EURUSD", after, after.length - 1, 5, 12), { ok: true }, "the weekend is not a gap");
  const holed = [...before.slice(0, 15), ...before.slice(16)];
  assert.equal(checkHistory("EURUSD", holed, holed.length - 1, 5, 12).ok, false, "a missing Friday-afternoon candle is");
});

test("live freshness: closed market, and a feed that is behind, are both DATA UNAVAILABLE", () => {
  const now = Date.UTC(2026, 9, 21, 14, 7, 30);                   // Wednesday
  assert.equal(liveFreshness("EURUSD", Date.UTC(2026, 9, 21, 14, 0), now, 8_000).ok, true);
  assert.match(String(liveFreshness("EURUSD", Date.UTC(2026, 9, 21, 13, 50), now, 8_000).reason), /behind/);
  assert.deepEqual([liveFreshness("EURUSD", null, Date.UTC(2026, 9, 24, 12, 0), 8_000).open, liveFreshness("EURUSD", null, Date.UTC(2026, 9, 24, 12, 0), 8_000).reason], [false, "market closed"]);
});

/* ── the DMI event adapter ────────────────────────────────────────────────────────────────────── */
test("DMI events: exchange prefixes are fine, other instruments are refused (never substituted), times must be candle opens", () => {
  assert.equal(normalizeSymbol("FX:EURUSD"), "EURUSD");
  assert.equal(normalizeSymbol("oanda:xau/usd"), "XAUUSD");
  assert.equal(normalizeSymbol("EURGBP"), null);
  const ok = parseDmiEvent({ symbol: "FX:GBPJPY", signal: "buy", time: "2026-10-21T14:05:00Z", source: "tradingview-alert", version: "v3" });
  assert.ok(ok.ok && ok.event.type === "B" && ok.event.candleT === Date.UTC(2026, 9, 21, 14, 5) && ok.event.symbol === "GBPJPY");
  assert.ok(parseDmiEvent({ symbol: "EURUSD", signal: "S", time: Date.UTC(2026, 9, 21, 14, 5) }).ok, "epoch ms");
  assert.equal(parseDmiEvent({ symbol: "EURUSD", signal: "S", time: "2026-10-21T14:06:00Z" }).ok, false);
  assert.equal(parseDmiEvent({ symbol: "EURUSD", signal: "X", time: "2026-10-21T14:05:00Z" }).ok, false);
  assert.equal(secretMatches("abc", undefined), false, "no secret configured → nothing accepted");
  assert.equal(secretMatches("abc", "abd"), false);
  assert.equal(secretMatches("abc", "abc"), true);
});

/* ── configuration ────────────────────────────────────────────────────────────────────────────── */
test("assumptions are validated; intrabar confirmation is refused; the config version follows the settings", () => {
  assert.ok(resolveAssumptions({}).ok);
  const bad = resolveAssumptions({ confirmOnCandleClose: false, maxEntryDelaySec: 0, bandExcursion: "body" });
  assert.ok(!bad.ok && bad.errors.length === 3);
  const v1 = configVersion(DEFAULT_ASSUMPTIONS);
  assert.equal(configVersion(DEFAULT_ASSUMPTIONS), v1, "stable");
  const r = resolveAssumptions({ bandExcursion: "close" });
  assert.ok(r.ok && configVersion(r.value) !== v1, "a change gives a new version");
});

test("replay parameters", () => {
  assert.deepEqual(parseReplayParams({ symbol: "all", weeks: 8 }), { ok: true, value: { symbols: ["USDJPY", "EURUSD", "XAUUSD", "GBPJPY"], weeks: 8, payouts: [0.8], devFraction: 0.7 } });
  assert.equal(parseReplayParams({ symbol: "BTCUSD" }).ok, false);
  assert.equal(parseReplayParams({ weeks: 20 }).ok, false);
});

/* ── what a card shows ────────────────────────────────────────────────────────────────────────── */
test("card status precedence: the signal's own state, then data, then armed/developing/wait", () => {
  const now = Date.UTC(2026, 9, 21, 14, 5, 15);
  const feed = { open: true, ok: true, reason: null, lagMs: 1000, latestCandleT: now - 600_000 };
  const sig = { direction: "CALL", status: "published", publishedAt: now - 5_000, entryDeadline: now + 5_000, expiryAt: null, settlementAt: null, zone: null, referencePrice: null, referenceSource: null, result: "pending", settlementPrice: null } as unknown as SignalRecord;
  const base = { now, feed, lastDecision: null, armed: null, developing: null, dmiAvailable: true };
  assert.equal(cardStatus({ ...base, signal: sig }).status, "CALL");
  assert.equal(cardStatus({ ...base, signal: { ...sig, status: "active", expiryAt: now + 200_000 } }).status, "ACTIVE");
  assert.equal(cardStatus({ ...base, signal: { ...sig, status: "settled", result: "win", expiryAt: now - 60_000, settlementAt: now - 59_000 } }).status, "EXPIRED");
  assert.equal(cardStatus({ ...base, signal: { ...sig, status: "settled", expiryAt: now - 900_000, settlementAt: now - 900_000 } }).status, "WAIT", "an old result no longer shows");
  assert.equal(cardStatus({ ...base, feed: { ...feed, ok: false, reason: "feed is behind" }, signal: null }).status, "DATA_UNAVAILABLE");
  assert.equal(cardStatus({ ...base, feed: { ...feed, open: false, ok: false }, signal: null }).reason, "Market closed.");
});
