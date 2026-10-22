import test from "node:test";
import assert from "node:assert/strict";
import { acceptEntry, BarOpenProxyQuoteSource, draftSignal, expiryFor, payoutFor, settle, TickQuoteSource } from "../src/lib/cashtrap/signals";
import { breakEvenWinRate, periodStats, splitReport } from "../src/lib/cashtrap/report";
import type { Confirmation } from "../src/lib/cashtrap/engine";
import { cfgWith } from "./_cashtrap";

const cfg = cfgWith();
const CLOSE = Date.UTC(2026, 9, 21, 14, 5, 0);
const v = { t: CLOSE - 300_000, open: 1.1, high: 1.1, low: 1.09, close: 1.095, bbBasis: 1.1, bbUpper: 1.11, bbLower: 1.092, rsi: 12, rsiMa: 15, stochK: 8, stochD: 8, atr: 0.001, dmiStoch: 12, dmiStochPrev: 8 };
const conf = (dir: "BUY" | "SELL" = "BUY"): Confirmation => ({
  setup: { id: "s1", symbol: "EURUSD", direction: dir, exhaustionT: CLOSE - 300_000, armedAt: CLOSE + 8_000, seen: 0, zone: null, values: v, checklist: { band: true, rsi: true, stoch: true, zone: true, dmi: true } },
  confirmT: CLOSE - 300_000, confirmedAt: CLOSE, decidedAt: CLOSE + 8_000, dmiType: dir === "BUY" ? "B" : "S", values: v,
});
const PUB = CLOSE + 8_000;
const q = (px: number, at: number) => ({ px, at, source: "test" });

test("the entry window opens at publication and lasts 10 seconds; the first quote inside it is the reference entry", () => {
  const s = draftSignal(conf(), PUB, cfg, "reference-feed");
  assert.deepEqual([s.entryWindowStart, s.entryDeadline, s.status], [PUB, PUB + 10_000, "published"]);
  const ok = acceptEntry(s, q(1.09532, PUB + 9_999), cfg);
  assert.deepEqual([ok.status, ok.referencePrice, ok.referenceAt], ["active", 1.09532, PUB + 9_999]);
  assert.equal(ok.expiryAt, PUB + 9_999 + 300_000, "duration expiry is measured from the accepted reference entry");
});

test("a quote after the deadline makes the signal MISSED — no late entry", () => {
  const s = acceptEntry(draftSignal(conf(), PUB, cfg, "reference-feed"), q(1.0953, PUB + 10_001), cfg);
  assert.deepEqual([s.status, s.result, s.referencePrice], ["missed", "missed", null]);
  assert.deepEqual(acceptEntry(draftSignal(conf(), PUB, cfg, "reference-feed"), null, cfg).result, "missed");
});

test("an entry is never backdated: a quote from before publication (the candle's close) is refused", () => {
  const s = acceptEntry(draftSignal(conf(), PUB, cfg, "reference-feed"), q(1.095, CLOSE), cfg);
  assert.equal(s.status, "missed");
  assert.match(s.notes.join(" "), /never backdated/);
  assert.throws(() => draftSignal(conf(), CLOSE - 1, cfg, "simulated"), /cannot be published before/);
});

test("fixed clock-time expiry is the contract's next boundary — a separate mode from duration", () => {
  const fixed = cfgWith({ expiry: { mode: "fixed", boundaryMinutes: 5, minSecondsToExpiry: 60 } });
  assert.equal(expiryFor(CLOSE + 9_000, fixed), CLOSE + 300_000, "14:05:09 + 60 s → 14:10:00");
  assert.equal(expiryFor(CLOSE + 250_000, fixed), CLOSE + 600_000, "14:09:10 + 60 s → 14:15:00");
  assert.equal(expiryFor(CLOSE + 9_000, cfg), CLOSE + 309_000);
});

test("CALL wins above entry, PUT wins below; equal is a TIE; payout only with a configured rate", () => {
  const paid = cfgWith({ payoutRate: 0.8 });
  const call = acceptEntry(draftSignal(conf("BUY"), PUB, paid, "reference-feed"), q(1.09500, PUB + 1_000), paid);
  const exp = call.expiryAt as number;
  const w = settle(call, q(1.09501, exp + 500), paid);
  assert.deepEqual([w.result, w.payout], ["win", 0.8]);
  assert.deepEqual([settle(call, q(1.09499, exp), paid).result, settle(call, q(1.09499, exp), paid).payout], ["loss", -1]);
  const tie = settle(call, q(1.095000000001, exp), paid);
  assert.deepEqual([tie.result, tie.payout], ["tie", 0], "equal at the quoted precision; refund by the (assumed) tie rule");
  const put = acceptEntry(draftSignal(conf("SELL"), PUB, paid, "reference-feed"), q(1.095, PUB + 1_000), paid);
  assert.equal(settle(put, q(1.09499, exp), paid).result, "win");
  const unpaid = settle(acceptEntry(draftSignal(conf(), PUB, cfg, "reference-feed"), q(1.095, PUB + 1_000), cfg), q(1.096, exp), cfg);
  assert.deepEqual([unpaid.result, unpaid.payout], ["win", null], "no payout rate set → direction only, no invented payout");
  assert.equal(payoutFor("tie", 0.8, "loss"), -1);
});

test("no settlement quote (or one too late) is UNRESOLVED — never an invented win or loss", () => {
  const a = acceptEntry(draftSignal(conf(), PUB, cfg, "reference-feed"), q(1.095, PUB + 1_000), cfg);
  const exp = a.expiryAt as number;
  assert.equal(settle(a, null, cfg).result, "unresolved");
  assert.equal(settle(a, q(1.2, exp + 5_001), cfg).result, "unresolved", "outside the 5 s tolerance");
  assert.equal(settle(a, q(1.2, exp - 1), cfg).result, "unresolved", "a quote before expiry is not a settlement");
});

test("quote sources: recorded ticks give the first tick in the window; the bar proxy gives the next candle open", async () => {
  const ticks = new TickQuoteSource([{ symbol: "EURUSD", px: 1.1, at: 1000 }, { symbol: "EURUSD", px: 1.2, at: 2000 }, { symbol: "EURUSD", px: 1.3, at: 9000 }]);
  assert.equal((await ticks.firstQuote("EURUSD", 1500, 5000))?.px, 1.2);
  assert.equal(await ticks.firstQuote("EURUSD", 2500, 5000), null);
  const bars = new BarOpenProxyQuoteSource({ EURUSD: [{ t: 0, o: 1 }, { t: 300_000, o: 1.5 }] });
  assert.equal((await bars.firstQuote("EURUSD", 1, 400_000))?.px, 1.5);
  assert.equal(await bars.firstQuote("EURUSD", 8_000, 18_000), null, "with a real publication delay the bar data has nothing inside a 10-second window");
});

test("break-even win rate excluding ties is 1 / (1 + r): 55.56% at an 80% payout", () => {
  assert.equal(+breakEvenWinRate(0.8).toFixed(4), 0.5556);
});

test("reporting: win rate excludes ties, the losing streak is counted, net is stated at the payout", () => {
  const mk = (result: "win" | "loss" | "tie", i: number) => ({ ...acceptEntry(draftSignal(conf(), PUB + i, cfg, "simulated"), q(1.095, PUB + i + 1), cfg), status: "settled" as const, result, publishedAt: PUB + i });
  const sigs = [mk("loss", 1), mk("loss", 2), mk("tie", 3), mk("loss", 4), mk("win", 5), mk("win", 6)];
  const st = periodStats([], [], sigs, [0.8], "refund");
  assert.deepEqual([st.wins, st.losses, st.ties, st.winRateExTies], [2, 3, 1, 0.4]);
  assert.equal(st.longestLosingStreak, 3, "a tie neither extends nor breaks a losing streak");
  assert.deepEqual(st.netAt[0], { payout: 0.8, breakEvenWinRate: 0.5556, netUnits: -1.4, perSignal: -0.2333 });
});

test("the development / out-of-sample split is chronological: every candle and signal in exactly one period, development first", () => {
  const t0 = Date.UTC(2026, 9, 6);
  const M = 300_000;
  const decisions = Array.from({ length: 100 }, (_, i) => ({ candleT: t0 + i * M, status: "WAIT" })) as unknown as Parameters<typeof splitReport>[0];
  const sig = (i: number, result: string) => ({ setupCandleT: t0 + i * M, publishedAt: t0 + i * M + 308_000, status: "settled", result });
  const signals = [sig(10, "win"), sig(50, "loss"), sig(69, "win"), sig(70, "loss"), sig(90, "win")] as unknown as Parameters<typeof splitReport>[2];
  const r = splitReport(decisions, [], signals, [0.8], "refund", 0.7);
  assert.equal(r.development.candlesDecided + r.outOfSample.candlesDecided, 100);
  assert.deepEqual([r.development.candlesDecided, r.outOfSample.candlesDecided], [70, 30]);
  assert.ok(Date.parse(String(r.development.to)) < Date.parse(String(r.outOfSample.from)), "development ends before out-of-sample starts");
  assert.deepEqual([r.development.wins, r.development.losses, r.outOfSample.wins, r.outOfSample.losses], [2, 1, 1, 1]);
  assert.deepEqual([r.all.wins, r.all.losses], [3, 2]);
  assert.equal(r.outOfSample.netAt[0].breakEvenWinRate, 0.5556);
});
