import test from "node:test";
import assert from "node:assert/strict";
import { closeOf, M5, slotOf, tradingCandles, type Candle } from "../src/lib/cashtrap/candles";
import { DEFAULT_ASSUMPTIONS, effectiveConfig } from "../src/lib/cashtrap/config";
import { cfgWith } from "./_cashtrap";
import type { CandleFetch, MarketData } from "../src/lib/cashtrap/data";
import { replay } from "../src/lib/cashtrap/replay";
import { clearToHandOver, processSymbol, runLoop, settleDue, settleOne, type ServiceDeps } from "../src/lib/cashtrap/service";
import type { SignalRecord as Sig } from "../src/lib/cashtrap/signals";
import type { Quote } from "../src/lib/cashtrap/signals";
import { DEFAULT_SETTINGS, MemoryStore } from "../src/lib/cashtrap/store";
import type { CashtrapSymbol } from "../src/lib/cashtrap/symbols";

/**
 * The live service on an in-memory store and a scripted feed: restarts, duplicates, corrections,
 * publication timing, and — the property everything rests on — the same decisions as replay.
 */
// The mechanics below run on an 8 s settle time (the default, 90 s, is tested on its own at the end).
const cfg = cfgWith({ data: { ...DEFAULT_ASSUMPTIONS.data, feedSettleMs: 8_000, maxPublishLagMs: 60_000 } });

/** A deterministic gold-like series on weekdays only (so closures are not gaps). */
function series(n: number, seed = 5, start = Date.UTC(2026, 9, 5, 0, 0)): Candle[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: Candle[] = [];
  let px = 2400, t = start;
  while (out.length < n) {
    const d = new Date(t).getUTCDay();
    if (d >= 1 && d <= 5 && !(d === 5 && new Date(t).getUTCHours() >= 20)) {
      const o = px, c = o + (rnd() - 0.5) * 2.4 * (out.length % 89 < 5 ? 3 : 1);
      out.push({ t, o: +o.toFixed(2), h: +(Math.max(o, c) + rnd() * 0.6).toFixed(2), l: +(Math.min(o, c) - rnd() * 0.6).toFixed(2), c: +c.toFixed(2) });
      px = c;
    }
    t += M5;
  }
  return out;
}

class ScriptedFeed implements MarketData {
  readonly name = "scripted";
  quoteLagMs = 300;
  quotePx: ((s: CashtrapSymbol, at: number) => number | null) = () => 2400;
  fetches = 0;
  lastCount = 0;
  failUntil = -Infinity;          // the feed does not answer before this time
  quotes = 0;
  constructor(public all: Candle[], public now: () => number, public extra: Array<Record<string, unknown>> = []) {}
  async candles(_s: CashtrapSymbol, count: number): Promise<CandleFetch> {
    this.fetches += 1;
    this.lastCount = count;
    const now = this.now();
    if (now < this.failUntil) return { ok: false, reason: "the feed did not answer", fetchedAt: now };
    const done = this.all.filter((k) => closeOf(k.t) <= now);
    const forming = this.all.find((k) => k.t === slotOf(now));
    const rows = [...done.slice(-count), ...(forming ? [{ ...forming, c: forming.o, h: forming.o, l: forming.o }] : [])];
    return { ok: true, candles: rows, issues: [], fetchedAt: now };
  }
  async quote(s: CashtrapSymbol): Promise<Quote | null> {
    this.quotes += 1;
    const at = this.now() + this.quoteLagMs;
    const px = this.quotePx(s, at);
    return px == null ? null : { px, at, source: "scripted" };
  }
}

function harness(all: Candle[], startAt: number) {
  let now = startAt;
  const store = new MemoryStore();
  store.settings = { ...DEFAULT_SETTINGS, assumptions: cfg.assumptions };
  const feed = new ScriptedFeed(all, () => now);
  const deps: ServiceDeps = { store, data: feed, now: () => now, sleep: async (ms) => { now += ms; } };
  return { store, feed, deps, at: (t: number) => { now = t; }, now: () => now };
}

test("live and replay make identical decisions on the same candles", async () => {
  const all = series(900);
  const h = harness(all, closeOf(all[599].t) + 8_000);
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);            // first start: decides candle 599
  for (let i = 600; i < 900; i++) { h.at(closeOf(all[i].t) + 8_000); await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null); }
  const live = [...h.store.decisions.values()].filter((d) => d.symbol === "XAUUSD").sort((a, b) => a.candleT - b.candleT);
  const r = await replay({ symbol: "XAUUSD", candles: all, config: cfg, dmiMode: "calculation", dmiAvailable: true, decisionLatencyMs: 8_000, publishLatencyMs: 0, quotes: null, startIndex: 599, initialState: { v: 1, symbol: "XAUUSD", lastT: all[598].t, armed: null, needsReset: { BUY: false, SELL: false }, activeSignal: null } });
  const expected = tradingCandles("XAUUSD", all.slice(599)).length;          // gold's daily-break candles are never decided
  assert.ok(expected < 301 && expected > 280, `the stretch crosses gold's daily break (${expected} trading candles)`);
  assert.equal(live.length, expected);
  assert.equal(r.decisions.length, expected);
  const key = (d: (typeof live)[number]) => JSON.stringify([d.candleT, d.status, d.direction, d.reasonCode, d.setupId, d.zoneId, d.checklist, d.values]);
  for (let i = 0; i < live.length; i++) assert.equal(key(live[i]), key(r.decisions[i]), `candle ${new Date(live[i].candleT).toISOString()}`);
  assert.ok(live.some((d) => d.status !== "WAIT"), "the stretch has setups in it");
});

test("a restart continues from the stored state: nothing is decided twice, nothing skipped", async () => {
  const all = series(700);
  const h = harness(all, closeOf(all[599].t) + 8_000);
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  for (let i = 600; i < 650; i++) { h.at(closeOf(all[i].t) + 8_000); await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null); }
  // "Restart": a brand-new service (new deps, new feed object) on the same store, a few candles later.
  const feed2 = new ScriptedFeed(all, h.now);
  const deps2: ServiceDeps = { ...h.deps, data: feed2 };
  h.at(closeOf(all[655].t) + 8_000);
  const p = await processSymbol(deps2, "XAUUSD", h.store.settings, cfg, null);
  assert.equal(p.decided, 6, "the five missed candles and the new one, in order");
  const ts = [...h.store.decisions.values()].map((d) => d.candleT).sort((a, b) => a - b);
  assert.equal(new Set(ts).size, ts.length, "no candle decided twice");
  for (let i = 1; i < ts.length; i++) assert.equal(ts[i] - ts[i - 1] >= M5, true);
  // The same pass again (a duplicate cron run): nothing new.
  const again = await processSymbol(deps2, "XAUUSD", h.store.settings, cfg, null);
  assert.equal(again.decided, 0);
});

test("a stored candle the feed later changes is logged as a correction; its decision is not rewritten", async () => {
  const all = series(650);
  const h = harness(all, closeOf(all[640].t) + 8_000);
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  const before = [...h.store.decisions.values()].find((d) => d.candleT === all[640].t)!;
  h.feed.all = all.map((k, i) => (i === 640 ? { ...k, c: +(k.c + 0.37).toFixed(2), h: +(Math.max(k.h, k.c + 0.37)).toFixed(2) } : k));
  h.at(closeOf(all[641].t) + 8_000);
  const p = await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  assert.equal(p.corrections, 1);
  assert.equal(h.store.corrections[0].t, all[640].t);
  assert.deepEqual([...h.store.decisions.values()].find((d) => d.candleT === all[640].t), before, "the recorded decision stands");
});

test("developing candles never become decisions; a candle is decided only once the feed has settled it", async () => {
  const all = series(650);
  const h = harness(all, closeOf(all[640].t) + 3_000);          // 3 s after the close: not yet settled (8 s)
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  const ts = [...h.store.decisions.values()].map((d) => d.candleT);
  assert.ok(!ts.includes(all[640].t), "the candle that closed 3 s ago is not decided yet");
  assert.ok(ts.every((t) => closeOf(t) + 8_000 <= h.now()), "only settled candles are decided");
});

/* ── publication, entry, expiry ───────────────────────────────────────────────────────────────── */
async function withSignal() {
  const all = series(3000, 21);
  // Find a confirmation by replaying, then run the live service across it.
  const r = await replay({ symbol: "XAUUSD", candles: all, config: cfg, dmiMode: "calculation", dmiAvailable: true, decisionLatencyMs: 8_000, publishLatencyMs: 0, quotes: null });
  const sig = r.signals.find((s) => all.findIndex((k) => k.t === s.confirmationT) > 620);
  assert.ok(sig, "the sample has a confirmed signal after warmup");
  const ci = all.findIndex((k) => k.t === sig!.confirmationT);
  const h = harness(all, closeOf(all[ci - 12].t) + 8_000);
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  for (let i = ci - 11; i < ci; i++) { h.at(closeOf(all[i].t) + 8_000); await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null); }
  return { all, ci, h, expected: sig! };
}

test("a confirmed signal is published once, entered at the first quote after publication, and settled at expiry", async () => {
  const { all, ci, h, expected } = await withSignal();
  h.at(closeOf(all[ci].t) + 8_000);
  h.feed.quotePx = () => 2401.5;
  const p = await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  assert.equal(p.published, 1);
  const s = [...h.store.signals.values()][0];
  assert.equal(s.direction, expected.direction);
  assert.equal(s.publishedAt, closeOf(all[ci].t) + 8_000);
  assert.deepEqual([s.status, s.referencePrice, s.referenceAt], ["active", 2401.5, s.publishedAt + 300]);
  assert.ok(s.referenceAt! > s.confirmedAt, "never the confirming candle's close");
  // At expiry.
  h.at(s.expiryAt as number);
  h.feed.quotePx = () => (s.direction === "CALL" ? 2403 : 2399);
  const done = await settleDue(h.deps, cfg);
  assert.deepEqual([done[0].result, done[0].settlementPrice, done[0].recordType], ["win", s.direction === "CALL" ? 2403 : 2399, "reference-feed"]);
  // A repeated pass publishes nothing more and raises no alert twice.
  const n = h.store.alerts.length;
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  await settleDue(h.deps, cfg);
  assert.equal(h.store.signals.size, 1);
  assert.equal(h.store.alerts.length, n);
  assert.deepEqual(h.store.alerts.map((a) => a.kind).filter((k) => k !== "armed"), ["signal", "entry", "outcome"]);
});

test("a quote that comes after the 10-second window makes the signal MISSED", async () => {
  const { all, ci, h } = await withSignal();
  h.at(closeOf(all[ci].t) + 8_000);
  h.feed.quoteLagMs = 10_500;
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  const s = [...h.store.signals.values()][0];
  assert.deepEqual([s.status, s.result, s.referencePrice], ["missed", "missed", null]);
  assert.ok(h.store.alerts.some((a) => a.kind === "missed"));
});

test("after an outage, a confirmation decided too late is recorded but not published", async () => {
  const { all, ci, h } = await withSignal();
  h.at(closeOf(all[ci + 2].t) + 8_000);                     // the runner comes back ten minutes late
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  assert.equal(h.store.signals.size, 0);
  const late = [...h.store.setups.values()].find((s) => s.status === "confirmed");
  assert.ok(late && late.published === false && /too late to publish/.test(String(late.suppressedReason)));
});

test("only one runner at a time: a second runner is refused the lock", async () => {
  const all = series(650);
  const h = harness(all, closeOf(all[640].t) + 8_000);
  await h.store.acquireLock("other", 60_000, h.now());
  const r = await runLoop(h.deps, { holder: "me", budgetMs: 5_000 });
  assert.deepEqual([r.ran, r.reason], [false, "another runner holds the lock"]);
});

test("the runner decides the closed candle, keeps the cards fresh, and releases the lock at the end of its budget", async () => {
  const all = series(700);
  const h = harness(all, closeOf(all[640].t) + 8_000);
  for (const s of ["USDJPY", "EURUSD", "GBPJPY"] as const) h.store.candles.set(s, new Map());   // only gold has history here
  const r = await runLoop(h.deps, { holder: "me", budgetMs: 55_000 });
  assert.equal(r.ran, true);
  assert.ok(r.passes >= 1);
  assert.equal(h.store.lock.holder, null, "released");
  const snap = await h.store.snapshot("XAUUSD");
  assert.ok(snap && snap.price?.px === 2400 && ["WAIT", "ARMED", "DEVELOPING", "CALL", "PUT", "ACTIVE", "EXPIRED"].includes(snap.status));
});

test("with an outside DMI event feed, a candle is decided only after the grace period, so its event can arrive", async () => {
  const all = series(700);
  const h = harness(all, closeOf(all[640].t) + 8_000);
  h.store.settings = { ...DEFAULT_SETTINGS, assumptions: cfg.assumptions, dmiMode: "event-feed", dmiFeedVerified: true };
  const p1 = await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  assert.equal(p1.decided, 0, "8 s after the close: still inside the 20 s grace");
  h.at(closeOf(all[640].t) + 20_000);
  const p2 = await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  assert.equal(p2.decided, 1);
  assert.equal([...h.store.decisions.values()][0].decidedAt, closeOf(all[640].t) + 20_000);
});

/* ── review fixes: retries, gaps, closed markets, skipped setups ───────────────────────────────── */
test("a feed that fails at the decision time is tried again within the run: the candle is decided and its signal published in time", async () => {
  const { all, ci, h } = await withSignal();
  for (const s of ["USDJPY", "EURUSD", "GBPJPY"] as const) h.store.candles.set(s, new Map());
  h.feed.failUntil = closeOf(all[ci].t) + 14_000;                 // down for the first 14 s after the close
  h.at(closeOf(all[ci].t) - 2_000);
  await runLoop(h.deps, { holder: "me", budgetMs: 40_000 });
  const d = [...h.store.decisions.values()].find((x) => x.symbol === "XAUUSD" && x.candleT === all[ci].t);
  assert.ok(d, "the candle was decided in the same run");
  assert.ok(d!.decidedAt >= h.feed.failUntil && d!.decidedAt - closeOf(all[ci].t) < 25_000, `decided ${d!.decidedAt - closeOf(all[ci].t)} ms after the close`);
  const sigs = [...h.store.signals.values()].filter((x) => x.symbol === "XAUUSD");
  assert.equal(sigs.length, 1, "published, not refused as late");
});

test("after downtime the runner asks for enough candles to fill the gap — no hole is left behind", async () => {
  const all = series(760);
  const h = harness(all, closeOf(all[640].t) + 8_000);
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  h.at(closeOf(all[700].t) + 8_000);                               // back 60 candles later
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  assert.ok(h.feed.lastCount >= 62, `asked for ${h.feed.lastCount}`);
  const stored = h.store.candles.get("XAUUSD")!;
  for (let i = 600; i <= 700; i++) assert.ok(stored.has(all[i].t), `candle ${i} stored`);
});

test("an expiry that falls while the market is closed is UNRESOLVED — the feed's last price is not a settlement", async () => {
  const all = series(650);
  const h = harness(all, Date.UTC(2026, 9, 23, 21, 0, 30));      // Friday 17:00:30 New York: fx closed
  const expiry = Date.UTC(2026, 9, 23, 21, 0, 10);
  const sig = { dedupeKey: "k", setupId: "s", symbol: "EURUSD", direction: "CALL", setupCandleT: expiry - 3 * M5, confirmationT: expiry - 2 * M5, confirmedAt: expiry - M5, publishedAt: expiry - 300_000, entryWindowStart: expiry - 300_000, entryDeadline: expiry - 290_000,
    expiryMode: "duration", expiryDurationSec: 300, expiryAt: expiry, referencePrice: 1.1, referenceAt: expiry - 300_000, referenceSource: "x", settlementPrice: null, settlementAt: null, settlementSource: null,
    status: "active", result: "pending", recordType: "reference-feed", payoutRate: null, payout: null, exhaustionValues: {} as Sig["exhaustionValues"], confirmationValues: {} as Sig["confirmationValues"], zone: null, strategyVersion: "v", configVersion: "c", notes: [] } as Sig;
  await h.store.insertSignal(sig);
  const before = h.feed.quotes;
  const [done] = await settleDue(h.deps, cfg);
  assert.equal(done.result, "unresolved");
  assert.ok(done.notes.some((n) => /market was closed at expiry/.test(n)));
  assert.equal(h.feed.quotes, before, "no quote is asked for");
});

test("candles skipped after a long outage end the armed setup on record (it is not left 'armed')", async () => {
  const all = series(3000, 21);
  const r = await replay({ symbol: "XAUUSD", candles: all, config: cfg, dmiMode: "calculation", dmiAvailable: true, decisionLatencyMs: 8_000, publishLatencyMs: 0, quotes: null });
  const armedLong = r.setups.find((s) => all.findIndex((k) => k.t === s.exhaustionT) > 620 && (s.confirmT == null || s.confirmT > s.exhaustionT));
  assert.ok(armedLong, "the sample has a setup that stays armed past its exhaustion candle");
  const ei = all.findIndex((k) => k.t === armedLong!.exhaustionT);
  const h = harness(all, closeOf(all[ei - 12].t) + 8_000);
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  for (let i = ei - 11; i <= ei; i++) { h.at(closeOf(all[i].t) + 8_000); await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null); }
  assert.equal((await h.store.loadState("XAUUSD"))?.armed?.id, armedLong!.id);
  h.at(closeOf(all[ei + 40].t) + 8_000);                            // the runner was away for 40 candles
  await processSymbol(h.deps, "XAUUSD", h.store.settings, cfg, null);
  const rec = h.store.setups.get(armedLong!.id);
  assert.equal(rec?.status, "cancelled");
  assert.match(String(rec?.reason), /runner was down/);
});

/* ── hand-over between cron runs ──────────────────────────────────────────────────────────────── */
test("hand-over: after its minimum run, a runner gives way as soon as the next run is waiting — not before", async () => {
  const all = series(700);
  const h = harness(all, closeOf(all[640].t) + 9_000);
  for (const s of ["USDJPY", "EURUSD", "GBPJPY"] as const) h.store.candles.set(s, new Map());
  h.store.waiting = { holder: "next", expiresAt: Number.MAX_SAFE_INTEGER };
  const t0 = h.now();
  const r = await runLoop(h.deps, { holder: "me", minRunMs: 10_000, budgetMs: 55_000 });
  assert.equal(r.handedOver, true);
  assert.ok(h.now() - t0 >= 10_000 && h.now() - t0 < 13_000, `handed over after ${h.now() - t0} ms`);
  assert.equal(h.store.lock.holder, null, "released for the next run");
  // With nobody waiting it carries on to the end of its budget.
  h.store.waiting = null;
  const t1 = h.now();
  const r2 = await runLoop(h.deps, { holder: "me", minRunMs: 10_000, budgetMs: 40_000 });
  assert.equal(r2.handedOver, undefined);
  assert.ok(h.now() - t1 >= 40_000);
});

test("a run waiting for the lock marks itself so the holder can hand over; the holder never hands over with a settlement about to fall due", async () => {
  const all = series(650);
  const h = harness(all, closeOf(all[640].t) + 8_000);
  await h.store.acquireLock("holder", 60_000, h.now());
  const r = await runLoop(h.deps, { holder: "next", budgetMs: 30_000, lockWaitMs: 3_000 });
  assert.equal(r.ran, false);
  assert.equal(await h.store.successorWaiting("holder", h.now() - 1_000), true);
  assert.equal(await h.store.successorWaiting("next", h.now() - 1_000), false, "a run is not its own successor");
  const now = 1_000_000;
  assert.equal(clearToHandOver([now + 14_000], now), false, "a settlement due in 14 s keeps it");
  assert.equal(clearToHandOver([now + 16_000, now + 300_000], now), true);
  assert.equal(clearToHandOver([], now), true);
});

test("by default a candle is decided 90 s after its close — the feed finishes a 5-minute candle only ~60–80 s after it closes", async () => {
  const def = effectiveConfig();
  assert.equal(def.assumptions.data.feedSettleMs, 90_000);
  const all = series(700);
  const h = harness(all, closeOf(all[640].t) + 90_000);
  h.store.settings = { ...DEFAULT_SETTINGS };
  await processSymbol(h.deps, "XAUUSD", h.store.settings, def, null);           // first start: candle 640
  h.at(closeOf(all[641].t) + 60_000);                                              // a minute after 641 closed: not yet
  const early = await processSymbol(h.deps, "XAUUSD", h.store.settings, def, null);
  assert.equal(early.decided, 0);
  assert.equal(early.upToDate, true, "nothing is due before the settle time, so nothing is retried");
  h.at(closeOf(all[641].t) + 90_000);
  const due = await processSymbol(h.deps, "XAUUSD", h.store.settings, def, null);
  assert.equal(due.decided, 1);
  assert.equal([...h.store.decisions.values()].find((d) => d.candleT === all[641].t)?.decidedAt, closeOf(all[641].t) + 90_000);
});

test("a replay that yields to the event loop as it goes gives exactly the same result", async () => {
  const all = series(1200, 21);
  const base = { symbol: "XAUUSD" as const, candles: all, config: cfg, dmiMode: "calculation" as const, dmiAvailable: true, decisionLatencyMs: 0, publishLatencyMs: 0, quotes: null };
  const a = await replay(base);
  const b = await replay({ ...base, yieldEvery: 25 });
  assert.deepEqual(b.decisions, a.decisions);
  assert.deepEqual(b.setups, a.setups);
  assert.ok(a.decisions.some((d) => d.status !== "WAIT"));
});

test("candles from a closed market (weekend bars, gold's daily break) never reach the engine — not stored, not loaded, not replayed", async () => {
  const fri = Date.UTC(2026, 9, 23, 20, 30);                                   // Friday 16:30 New York
  const mk = (t: number, px: number): Candle => ({ t, o: px, h: px + 0.0002, l: px - 0.0002, c: px + 0.0001 });
  const raw: Candle[] = [];
  for (let t = fri - 400 * M5; t <= Date.UTC(2026, 9, 25, 21, 30); t += M5) raw.push(mk(t, 1.1 + ((t / M5) % 7) * 0.0001));   // every slot, weekend included
  const traded = tradingCandles("EURUSD", raw);
  assert.ok(traded.every((k) => !(k.t > Date.UTC(2026, 9, 23, 21, 0) - 1 && k.t < Date.UTC(2026, 9, 25, 21, 0))), "no weekend candle survives");
  // the in-memory store loads only trading candles even if closed-market ones were stored
  const store = new MemoryStore();
  await store.upsertCandles("EURUSD", raw, "test", Date.now());
  const loaded = await store.loadCandles("EURUSD", 100_000);
  assert.deepEqual(loaded.map((k) => k.t), traded.map((k) => k.t));
  // replay on the raw list decides exactly the trading candles
  const r = await replay({ symbol: "EURUSD", candles: raw, config: cfg, dmiMode: "off", dmiAvailable: false, decisionLatencyMs: 8_000, publishLatencyMs: 0, quotes: null });
  assert.ok(r.decisions.every((d) => traded.some((k) => k.t === d.candleT)));
  assert.equal(r.decisions.length, traded.length - (cfg.assumptions.data.minWarmupCandles - 1));
  assert.ok(r.decisions.some((d) => d.candleT === Date.UTC(2026, 9, 25, 21, 0)), "Sunday's reopening candle is decided");
});

/* ── final review: one settlement per signal, a runner that loses its lock stops ──────────────── */
function openSignal(expiry: number, symbol: CashtrapSymbol = "EURUSD"): Sig {
  return { dedupeKey: `k-${expiry}`, setupId: `s-${expiry}`, symbol, direction: "CALL", setupCandleT: expiry - 3 * M5, confirmationT: expiry - 2 * M5, confirmedAt: expiry - M5, publishedAt: expiry - 300_000, entryWindowStart: expiry - 300_000, entryDeadline: expiry - 290_000,
    expiryMode: "duration", expiryDurationSec: 300, expiryAt: expiry, referencePrice: 1.1, referenceAt: expiry - 300_000, referenceSource: "x", settlementPrice: null, settlementAt: null, settlementSource: null,
    status: "active", result: "pending", recordType: "reference-feed", payoutRate: null, payout: null, exhaustionValues: {} as Sig["exhaustionValues"], confirmationValues: {} as Sig["confirmationValues"], zone: null, strategyVersion: "v", configVersion: "c", notes: [] } as Sig;
}

test("a signal is settled once: a second runner holding an old copy cannot overwrite the result or alert again", async () => {
  const all = series(650);
  const expiry = Date.UTC(2026, 9, 21, 14, 0, 10);                              // Wednesday: open
  const h = harness(all, expiry + 300);
  const sig = openSignal(expiry);
  await h.store.insertSignal(sig);
  h.feed.quotePx = () => 1.1003;                                                // the first runner sees a win
  const first = await settleOne(h.deps, sig, cfg);
  h.feed.quotePx = () => 1.0997;                                                // the second (stale copy) would see a loss
  const second = await settleOne(h.deps, sig, cfg);
  assert.equal(first?.result, "win");
  assert.equal(second, null, "refused: the signal is no longer active");
  assert.equal([...h.store.signals.values()][0].result, "win");
  assert.equal(h.store.alerts.filter((a) => a.kind === "outcome").length, 1);
});

test("a runner whose lock lapses (another run took it) stops at once instead of carrying on beside it", async () => {
  const all = series(700);
  const h = harness(all, closeOf(all[640].t) + 9_000);
  for (const s of ["USDJPY", "EURUSD", "GBPJPY"] as const) h.store.candles.set(s, new Map());
  const t0 = h.now();
  let now = t0;
  const deps: ServiceDeps = { ...h.deps, now: () => now, sleep: async (ms) => { now += ms; if (now - t0 > 15_000) h.store.lock = { holder: "thief", expiresAt: Number.MAX_SAFE_INTEGER }; } };
  h.feed.now = () => now;
  const r = await runLoop(deps, { holder: "me", budgetMs: 55_000 });
  assert.equal(r.lostLock, true);
  assert.ok(now - t0 < 30_000, `stopped after ${now - t0} ms`);
  assert.equal(h.store.lock.holder, "thief", "it does not release a lock that is no longer its own");
});

test("a run that cannot read its settings never asks the current runner to hand over", async () => {
  const all = series(650);
  const h = harness(all, closeOf(all[640].t) + 8_000);
  await h.store.acquireLock("holder", 60_000, h.now());
  h.store.getSettings = async () => { throw new Error("database blip"); };
  const r = await runLoop(h.deps, { holder: "next", budgetMs: 30_000, lockWaitMs: 5_000 });
  assert.equal(r.ran, false);
  assert.match(String(r.reason), /settings unavailable/);
  assert.equal(h.store.waiting, null, "no waiting mark, so the holder keeps running");
});
