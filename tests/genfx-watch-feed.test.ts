import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb, type Row } from "./_genfx_fakedb";

/*
 * The watch's own price read, against a feed stubbed at the network. One thing is held: the watch looks
 * at price without waiting on candles. The recent closes it believes a price against are fetched off to
 * the side — so a candle request that hangs costs the pass nothing, and until there are closes on hand
 * no price is believed at all (the rule is never simply switched off).
 */
process.env.TWELVEDATA_API_KEY = "test-key";

const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Feed = { candles: "hang" | "error" | "ok"; closes: number; hits: { price: number; series: number } };
function stubFeed(f: Feed): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/price?")) { f.hits.price++; return new Response(JSON.stringify({ price: "1.0850" }), { status: 200 }); }
    f.hits.series++;
    if (f.candles === "hang") await new Promise(() => { /* never answers */ });
    if (f.candles === "error") return new Response(JSON.stringify({ status: "error", message: "down" }), { status: 500 });
    const values = Array.from({ length: 30 }, (_, i) => ({ datetime: `2026-10-06 10:${String(i * 2).padStart(2, "0")}:00`, open: String(f.closes), high: String(f.closes), low: String(f.closes), close: String(f.closes) })).reverse();
    return new Response(JSON.stringify({ status: "ok", values }), { status: 200 });
  }) as typeof fetch;
}

test("the watch looks at price without waiting on candles — and with no closes on hand, no price is believed", async () => {
  const { genfxWatchPass, _sanity } = await import("../src/lib/genfx/watch");
  const { controlOf } = await import("../src/lib/genfx/control");
  const { pushLiveTick } = await import("../src/lib/flow/liveTicks");
  const CTL = controlOf({ scan_enabled: true, auto_enabled: false, auto_scope: "demo", billing_enabled: false, telegram_enabled: false, config: {} });
  type Admin = Parameters<typeof genfxWatchPass>[0];
  const zone = (o: Row = {}): Row => ({
    id: "z1", pair: "EURUSD", mode: "quick", side: "sell", state: "zone", dedupe_key: "zone:EURUSD:quick:sell:108500:20261006",
    entry: 1.085, entry_low: 1.08497, entry_high: 1.08503, stop: 1.0865, tp1: 1.082, tp2: null, tp3: null, confidence: 60,
    created_at: new Date(Date.now() - 600_000).toISOString(), last_checked_at: new Date(Date.now() - 60_000).toISOString(), enter_sent_at: null, outcome: null, ...o,
  });
  const placed: unknown[] = [];
  const deps = { quiet: () => false, place: (async (sig: unknown) => { placed.push(sig); return { pair: "EURUSD", ran: true, reason: "ok", eligible: 0, placed: 0, skipped: {} }; }) as never };
  /** One pass on a fresh tick at `px`; returns how long the pass took. */
  const pass = async (db: ReturnType<typeof fakeDb>, td: string, px: number): Promise<number> => { pushLiveTick(td, px, Date.now()); const t = Date.now(); await genfxWatchPass(db as unknown as Admin, "test-key", CTL, deps); return Date.now() - t; };
  const f: Feed = { candles: "error", closes: 1.0848, hits: { price: 0, series: 0 } };
  stubFeed(f);
  try {
    _sanity.ref.clear(); _sanity.tried.clear();
    // The candle endpoint is down. Price is at the level, on tick after tick, a second apart.
    const db = fakeDb({ genfx_alerts: [zone()] });
    for (let i = 0; i < 3; i++) { await pass(db, "EUR/USD", 1.085); await sleep(1_100); }
    assert.deepEqual([db.tables.genfx_alerts[0].state, placed.length], ["zone", 0]);     // nothing to believe the price against: nothing decided
    assert.equal(f.hits.series, 1);                                                      // …and one request in those seconds, not one a pass
    // The closes arrive (off to the side). A price in sight of them is believed: entered on its two looks.
    f.candles = "ok"; _sanity.tried.clear();
    await pass(db, "EUR/USD", 1.085);                                                    // starts the refresh; this pass itself still has no reference
    await sleep(60);
    assert.deepEqual([db.tables.genfx_alerts[0].state, _sanity.ref.has("EURUSD")], ["zone", true]);
    await pass(db, "EUR/USD", 1.085);                                                    // first look
    await sleep(1_100);
    await pass(db, "EUR/USD", 1.08501);                                                  // second look, a second later
    assert.deepEqual([db.tables.genfx_alerts[0].state, placed.length], ["entered", 1]);
    // A print 2% from those closes is not believed, however often it is seen: it retires nothing and enters nothing.
    const db2 = fakeDb({ genfx_alerts: [zone()] });
    for (let i = 0; i < 2; i++) { await pass(db2, "EUR/USD", 1.1068); await sleep(1_100); }      // through the stop, if it were real
    assert.equal(db2.tables.genfx_alerts[0].state, "zone");

    // The candle endpoint HANGS (the other pair, so nothing above is on hand for it). A pass does not wait for it.
    f.candles = "hang"; f.hits.series = 0;
    const db3 = fakeDb({ genfx_alerts: [zone({ pair: "GBPJPY", dedupe_key: "zone:GBPJPY:quick:sell:80760:20261006", entry: 201.9, entry_low: 201.8925, entry_high: 201.9075, stop: 202.3, tp1: 201.1 })] });
    const took: number[] = [];
    for (let i = 0; i < 3; i++) { took.push(await pass(db3, "GBP/JPY", 201.9)); await sleep(1_100); }
    assert.ok(Math.max(...took) < 500, `passes took ${took.join(", ")}ms`);              // (the second version: twelve seconds each)
    assert.deepEqual([db3.tables.genfx_alerts[0].state, placed.length, f.hits.series], ["zone", 1, 1]);
  } finally { globalThis.fetch = realFetch; _sanity.ref.clear(); _sanity.tried.clear(); }
});

test("the desk's confirmation does not act on a price its candles contradict — and reads with the price it is handed", async () => {
  // (Nothing covered this line of confirm.ts before the third review.)
  const { confirmFxEntry } = await import("../src/lib/genfx/confirm");
  const { PAIRS } = await import("../src/lib/genfx/pairs");
  // Fifteen-minute candles above a SELL zone at 1.0840–1.0842, then a red candle closing back through it; the last row is still forming.
  const rows: Record<string, string>[] = [];
  for (let k = 0; k < 20; k++) rows.push({ datetime: `2026-10-06 ${String(8 + Math.floor(k / 4)).padStart(2, "0")}:${String((k % 4) * 15).padStart(2, "0")}:00`, open: "1.0836", high: "1.0838", low: "1.0834", close: "1.0836" });
  rows.push({ datetime: "2026-10-06 13:00:00", open: "1.0836", high: "1.0843", low: "1.0835", close: "1.0842" });
  rows.push({ datetime: "2026-10-06 13:15:00", open: "1.0842", high: "1.0843", low: "1.0834", close: "1.0835" });       // last closed: red, tested the zone
  rows.push({ datetime: "2026-10-06 13:30:00", open: "1.0835", high: "1.0836", low: "1.0834", close: "1.08352" });      // forming
  const hits = { price: 0, series: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/price?")) { hits.price++; return new Response(JSON.stringify({ price: "1.0839" }), { status: 200 }); }
    hits.series++;
    return new Response(JSON.stringify({ status: "ok", values: [...rows].reverse() }), { status: 200 });
  }) as typeof fetch;
  try {
    const ask = (live?: number | null) => confirmFxEntry({ pair: PAIRS.EURUSD, side: "sell", entryLow: 1.084, entryHigh: 1.0842, watch: 1.0841, invalidation: 1.0855, mode: "intraday", mdKey: "test-key", fresh: true, desk: true, ...(live === undefined ? {} : { live }) });
    // Handed a price in sight of the candles: that price is the one it reads with, and the feed is not asked for another.
    const good = await ask(1.0841);
    assert.deepEqual([good.state, good.price, good.enter, good.interval, hits.price], ["CONFIRMED", 1.0841, 1.0841, "15min", 0]);
    // A print 2.1% from the recent closes is a bad print: the forming candle's close stands in for it.
    const bad = await ask(1.107);
    assert.deepEqual([bad.state, bad.price, bad.enter], ["CONFIRMED", 1.08352, 1.08352]);
    // Inside the 1.5%: believed.
    assert.equal((await ask(1.099)).price, 1.099);
    // Handed "no price": the forming candle's close, again without asking the feed.
    assert.deepEqual([(await ask(null)).price, hits.price], [1.08352, 0]);
    // Handed nothing at all — the scan's own call — it asks the feed.
    const own = await ask();
    assert.deepEqual([own.price, hits.price], [1.0839, 1]);
  } finally { globalThis.fetch = realFetch; }
});
