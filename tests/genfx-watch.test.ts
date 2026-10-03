import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PAIRS } from "../src/lib/genfx/pairs";
import { controlOf } from "../src/lib/genfx/control";
import { genfxWatchPass, touchConfirmed, believable, _sanity, TOUCH_CONFIRM_MS, TOUCH_STALE_MS, REF_MAX_AGE_MS, type WatchDeps } from "../src/lib/genfx/watch";
import { type FxSignal } from "../src/lib/genfx/place";
import { type Quote } from "../src/lib/genfx/market";
import { fakeDb, type Row, type FakeDb } from "./_genfx_fakedb";

/*
 * The fast watch, run for real against a table of setups and a feed that says what the test says.
 * One rule is being held: ONE PRICE DECIDES NOTHING. A touch, a break of the stop and an armed
 * setup's pull-back each need two OBSERVATIONS — and the same tick handed back twice is one.
 */
type Admin = Parameters<typeof genfxWatchPass>[0];
const A = (d: FakeDb) => d as unknown as Admin;
// The watch remembers sightings, reads and a feed that did not answer between passes; every test starts from nothing.
beforeEach(() => _sanity.forget());
const CTL = controlOf({ scan_enabled: true, auto_enabled: false, auto_scope: "demo", billing_enabled: false, telegram_enabled: false, config: {} });
// A Tuesday, 14:00 UTC — the market is open and far from the daily close.
const T0 = Date.UTC(2026, 9, 6, 14, 0, 0);
let seq = 0;
const zone = (o: Row = {}): Row => ({
  id: `z${++seq}`, pair: "EURUSD", mode: "quick", side: "sell", state: "zone", dedupe_key: `zone:EURUSD:quick:sell:${108500 + seq}:20261006`,
  entry: 1.085, entry_low: 1.08497, entry_high: 1.08503, stop: 1.0865, tp1: 1.082, tp2: null, tp3: null, confidence: 60,
  created_at: new Date(T0 - 600_000).toISOString(), last_checked_at: new Date(T0 - 60_000).toISOString(), enter_sent_at: null, outcome: null, ...o,
});
const armed = (o: Row = {}): Row => ({
  id: `f${++seq}`, pair: "EURUSD", mode: "quick", side: "sell", state: "forming", dedupe_key: `EURUSD:quick:sell:${10840 + seq}:${10842 + seq}:20261006`,
  entry: 1.0841, entry_low: 1.084, entry_high: 1.0842, stop: 1.0855, tp1: 1.081, tp2: null, tp3: null, invalidation: 1.0855, watch: 1.0841, confidence: 60,
  created_at: new Date(T0 - 600_000).toISOString(), last_checked_at: new Date(T0 - 60_000).toISOString(), enter_sent_at: new Date(T0 - 60_000).toISOString(), outcome: null, ...o,
});

/** A desk whose price is whatever `feed.q` says, and whose placements are recorded instead of sent. */
function desk(db: FakeDb, opts: { confirmState?: string } = {}) {
  const feed: { q: Quote | null } = { q: null };
  const placed: FxSignal[] = [];
  const deps = (nowMs: number): WatchDeps => ({
    quote: async () => feed.q,
    place: (async (sig: FxSignal) => { placed.push(sig); return { pair: sig.pair, ran: true, reason: "ok", eligible: 0, placed: 0, skipped: {} }; }) as WatchDeps["place"],
    confirm: (async () => ({ state: opts.confirmState ?? "WAIT", detail: "", side: "sell", price: feed.q?.px ?? null, enter: null, zoneLow: 0, zoneHigh: 0, invalidation: 0, interval: "5min" })) as WatchDeps["confirm"],
    quiet: () => false,
    now: () => nowMs,
  });
  const pass = (nowMs: number, px: number | null, observedAt = nowMs) => { feed.q = px == null ? null : { px, at: observedAt }; return genfxWatchPass(A(db), "key", CTL, deps(nowMs)); };
  return { pass, placed };
}
const state = (db: FakeDb, i = 0) => db.tables.genfx_alerts[i].state;

test("the rule itself: the same observation asked about twice is one look", () => {
  const seen = new Map<string, number>();
  assert.equal(touchConfirmed(seen, "a", true, 1_000), false);                 // first sighting
  assert.equal(touchConfirmed(seen, "a", true, 1_000), false);                 // the SAME tick, a pass later
  assert.equal(touchConfirmed(seen, "a", true, 1_400), false);                 // a new tick, but not a second apart
  assert.equal(touchConfirmed(seen, "a", true, 1_000 + TOUCH_CONFIRM_MS), true);
  assert.equal(seen.has("a"), false);                                          // confirmed once: forgotten
  // Not seeing it forgets the first sighting; a sighting too long ago is not "the look before".
  touchConfirmed(seen, "b", true, 5_000);
  assert.equal(touchConfirmed(seen, "b", false, 6_000), false);
  assert.equal(touchConfirmed(seen, "b", true, 7_000), false);
  touchConfirmed(seen, "c", true, 10_000);
  assert.equal(touchConfirmed(seen, "c", true, 10_000 + TOUCH_STALE_MS + 1), false);
  assert.equal(touchConfirmed(seen, "c", true, 10_000 + TOUCH_STALE_MS + 1 + TOUCH_CONFIRM_MS), true);
});

test("a page setup is entered on two observations of the touch — one quote looked at on three passes enters nothing", async () => {
  const db = fakeDb({ genfx_alerts: [zone()] });
  const { pass, placed } = desk(db);
  // One print at the level (1.0850), observed at T0, and then the feed is silent: three passes all get the same quote back.
  for (const dt of [0, 1_500, 3_000]) await pass(T0 + dt, 1.085, T0);
  assert.deepEqual([state(db), placed.length], ["zone", 0]);
  // The price goes away again: the sighting is forgotten.
  await pass(T0 + 4_500, 1.084);
  // Back at the level, on two different observations a second and a half apart: entered, once.
  await pass(T0 + 6_000, 1.08499);
  assert.equal(state(db), "zone");
  const out = await pass(T0 + 7_500, 1.08501);
  assert.deepEqual([state(db), placed.length, out.sent], ["entered", 1, ["EURUSD:quick:ZONE_ENTER"]]);
  assert.deepEqual([placed[0].signalKey, placed[0].setup, placed[0].side, db.tables.genfx_alerts[0].enter_price], [db.tables.genfx_alerts[0].dedupe_key, "zone", "sell", 1.08501]);
  await pass(T0 + 9_000, 1.08501);
  assert.equal(placed.length, 1);
});

test("one print through the stop does not retire a page setup; two do", async () => {
  const db = fakeDb({ genfx_alerts: [zone()] });
  const { pass } = desk(db);
  await pass(T0, 1.087, T0);                                                    // one bad print, above the stop
  await pass(T0 + 1_500, 1.087, T0);                                            // …the same print again
  assert.equal(state(db), "zone");
  await pass(T0 + 3_000, 1.084);                                                // back where it was: nothing happened
  assert.equal(state(db), "zone");
  await pass(T0 + 4_500, 1.0866);
  const out = await pass(T0 + 6_000, 1.0867);
  assert.deepEqual([state(db), out.sent], ["invalidated", ["EURUSD:quick:ZONE_INVALID"]]);
});

test("no price to believe, no decision", async () => {
  const db = fakeDb({ genfx_alerts: [zone(), armed()] });
  const { pass, placed } = desk(db);
  for (const dt of [0, 1_500, 3_000]) await pass(T0 + dt, null);
  assert.deepEqual([db.tables.genfx_alerts.map((r) => r.state), placed.length], [["zone", "forming"], 0]);
});

test("an armed setup is entered when the price has come back — on two observations — and let go when its five minutes are up", async () => {
  const db = fakeDb({ genfx_alerts: [armed()] });
  const { pass, placed } = desk(db);
  await pass(T0, 1.0812);                                                       // still chased: 2 pips of reward left for 43 of risk
  assert.equal(state(db), "forming");
  await pass(T0 + 1_500, 1.0841, T0 + 1_500);                                   // back in the zone — once
  await pass(T0 + 3_000, 1.0841, T0 + 1_500);                                   // the same tick
  assert.deepEqual([state(db), placed.length], ["forming", 0]);
  const out = await pass(T0 + 4_500, 1.08412);
  assert.deepEqual([state(db), placed.length, placed[0].setup], ["entered", 1, "scanner"]);
  assert.match(out.sent[0], /ENTER:PULLBACK_TO_ENTRY/);

  // Armed six minutes ago, price sitting in the zone: too late. It is let go at once, not entered.
  const late = fakeDb({ genfx_alerts: [armed({ enter_sent_at: new Date(T0 - 6 * 60_000).toISOString() })] });
  const d2 = desk(late);
  const o2 = await d2.pass(T0, 1.0841);
  assert.deepEqual([state(late), d2.placed.length], ["invalidated", 0]);
  assert.match(o2.sent[0], /INVALID:ARM_EXPIRED_5MIN/);

  // A candle closing through its invalidation ends it, whatever the price is doing now.
  const dead = fakeDb({ genfx_alerts: [armed()] });
  const d3 = desk(dead, { confirmState: "INVALIDATED" });
  await d3.pass(T0, 1.0841);
  assert.deepEqual([state(dead), d3.placed.length], ["invalidated", 0]);
});

test("nothing from before the market last reopened is acted on: a page setup lapses, an armed setup is not entered at the reopen", async () => {
  // Quiet from 20:15 to 23:00 UTC; the pass runs at 23:00:10 with the price sitting on both levels.
  const reopen = Date.UTC(2026, 9, 6, 23, 0, 0);
  const quiet = (d: Date) => d.getTime() >= Date.UTC(2026, 9, 6, 20, 15) && d.getTime() < reopen;
  const db = fakeDb({ genfx_alerts: [
    zone({ last_checked_at: new Date(Date.UTC(2026, 9, 6, 20, 10)).toISOString() }),            // last shown before the close
    armed({ created_at: new Date(Date.UTC(2026, 9, 6, 20, 0)).toISOString(), enter_sent_at: new Date(Date.UTC(2026, 9, 6, 20, 12)).toISOString(), entry: 1.085, entry_low: 1.0849, entry_high: 1.0851, stop: 1.0865, tp1: 1.082 }),
  ] });
  const placed: FxSignal[] = [];
  const deps = (nowMs: number): WatchDeps => ({
    quote: async () => ({ px: 1.085, at: nowMs }), quiet, now: () => nowMs,
    place: (async (sig: FxSignal) => { placed.push(sig); return { pair: sig.pair, ran: true, reason: "ok", eligible: 0, placed: 0, skipped: {} }; }) as WatchDeps["place"],
    confirm: (async () => ({ state: "CONFIRMED", detail: "", side: "sell", price: 1.085, enter: 1.085, zoneLow: 0, zoneHigh: 0, invalidation: 0, interval: "5min" })) as WatchDeps["confirm"],
  });
  for (const dt of [10_000, 11_500, 13_000]) await genfxWatchPass(A(db), "key", CTL, deps(reopen + dt));
  assert.deepEqual([db.tables.genfx_alerts.map((r) => r.state), placed.length], [["expired", "invalidated"], 0]);
  // And inside the quiet window the pass does nothing at all.
  const db2 = fakeDb({ genfx_alerts: [zone()] });
  const out = await genfxWatchPass(A(db2), "key", CTL, { ...deps(reopen - 3_600_000) });
  assert.deepEqual([out.zones, db2.tables.genfx_alerts[0].state], [0, "zone"]);
});

test("the scanner switched off, or switches that cannot be read: the pass does nothing", async () => {
  const db = fakeDb({ genfx_alerts: [zone()] });
  const off = controlOf({ scan_enabled: false });
  const out = await genfxWatchPass(A(db), "key", off, { quote: async () => ({ px: 1.085, at: T0 }), now: () => T0, quiet: () => false });
  assert.deepEqual([out.zones, state(db)], [0, "zone"]);
  const blind = controlOf(null);
  assert.equal((await genfxWatchPass(A(db), "key", blind, { now: () => T0, quiet: () => false })).zones, 0);
});

test("the second look has to follow the first: a sighting eight seconds old is not 'the look before'", () => {
  assert.ok(TOUCH_STALE_MS <= 8_000);
  const seen = new Map<string, number>();
  touchConfirmed(seen, "a", true, 0);
  assert.equal(touchConfirmed(seen, "a", true, 7_900), true);                  // within eight seconds: the second look
  touchConfirmed(seen, "b", true, 0);
  assert.equal(touchConfirmed(seen, "b", true, 25_000), false);                // 25 seconds later with nothing in between: a first look again
  assert.equal(touchConfirmed(seen, "b", true, 26_500), true);
});

test("a price is believed only against the recent closes — and with none on hand, not at all", () => {
  const closes = (...c: number[]) => c.map((x) => ({ datetime: "", open: String(x), high: String(x), low: String(x), close: String(x) }));
  const ref = { rows: closes(1.084, 1.0841, 1.0842, 1.084, 1.0841), at: T0 };
  const q = (px: number): Quote => ({ px, at: T0 });
  assert.deepEqual(believable(q(1.0845), ref, T0), q(1.0845));
  assert.equal(believable(q(1.0845 * 1.019), ref, T0), null);                  // 1.9% away: a bad print
  assert.equal(believable(q(1.05), ref, T0), null);
  assert.equal(believable(null, ref, T0), null);
  // No reference yet; one too thin to judge by; one older than ten minutes: nothing to believe a price against.
  assert.equal(believable(q(1.0845), undefined, T0), null);
  assert.equal(believable(q(1.0845), { rows: closes(1.084, 1.0841), at: T0 }, T0), null);
  assert.equal(believable(q(1.0845), ref, T0 + REF_MAX_AGE_MS + 1), null);
  assert.deepEqual(believable(q(1.0845), ref, T0 + REF_MAX_AGE_MS - 1), q(1.0845));
});

test("the reference is refreshed off to the side: never waited for, at most once a minute, and a miss is not retried for ten seconds", async () => {
  _sanity.ref.clear(); _sanity.tried.clear();
  const good = Array.from({ length: 5 }, () => ({ datetime: "", open: "201.4", high: "201.4", low: "201.4", close: "201.4" }));
  let asks = 0, answer: typeof good | null = null, hang = false;
  const read = async () => { asks++; if (hang) await new Promise(() => { /* never */ }); return answer; };
  // Nothing on hand: asked — and the caller does not wait, even for a read that never comes back.
  hang = true;
  const t = Date.now();
  _sanity.refresh("GBPJPY", T0, read);
  assert.ok(Date.now() - t < 50);
  assert.deepEqual([asks, _sanity.ref.has("GBPJPY")], [1, false]);
  // Still nothing a second later, and five: not asked again. Ten seconds on: once more.
  hang = false;
  _sanity.refresh("GBPJPY", T0 + 1_000, read);
  _sanity.refresh("GBPJPY", T0 + 5_000, read);
  assert.equal(asks, 1);
  _sanity.refresh("GBPJPY", T0 + 10_000, read);                                 // comes back with nothing
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([asks, _sanity.ref.has("GBPJPY")], [2, false]);
  answer = good;
  _sanity.refresh("GBPJPY", T0 + 20_000, read);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([asks, _sanity.ref.get("GBPJPY")?.rows.length], [3, 5]);
  // On hand and under a minute old (by the clock it arrived on): left alone. Older: refreshed.
  const got = _sanity.ref.get("GBPJPY")!.at;
  _sanity.refresh("GBPJPY", got + 30_000, read);
  assert.equal(asks, 3);
  _sanity.refresh("GBPJPY", got + 61_000, read);
  assert.equal(asks, 4);
  // A refresh that fails leaves the old reference standing.
  answer = null;
  _sanity.refresh("GBPJPY", got + 130_000, read);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(_sanity.ref.get("GBPJPY")?.rows.length, 5);
  _sanity.ref.clear(); _sanity.tried.clear();
});

test("an armed setup whose five minutes are up is let go whether or not there is a price — and so is one whose arming time cannot be read", async () => {
  const db = fakeDb({ genfx_alerts: [armed({ enter_sent_at: new Date(T0 - 6 * 60_000).toISOString() }), armed({ enter_sent_at: "not a time" })] });
  const { pass, placed } = desk(db);
  const out = await pass(T0, null);                                             // no quote to be had
  assert.deepEqual([db.tables.genfx_alerts.map((r) => r.state), placed.length], [["invalidated", "invalidated"], 0]);
  assert.equal(out.sent.filter((x) => /INVALID:ARM_EXPIRED_5MIN/.test(x)).length, 2);
  // (The second version waited for a price first, and never asked the clock of a time it could not read:
  //  with the price sitting in the zone seven hours later, that setup was entered.)
  const db2 = fakeDb({ genfx_alerts: [armed({ enter_sent_at: "not a time" })] });
  const d2 = desk(db2);
  for (const dt of [0, 1_500]) await d2.pass(T0 + 7 * 3600_000 + dt, 1.0841);
  assert.deepEqual([state(db2), d2.placed.length], ["invalidated", 0]);
});

test("candles that do not come back hold a pass up for its allowance and no longer — and nothing decided on price waits for them", async () => {
  const pending = armed({ id: "p1", enter_sent_at: null, dedupe_key: "EURUSD:quick:sell:10850:10852:20261006", entry: 1.0851, entry_low: 1.085, entry_high: 1.0852, stop: 1.0865, tp1: 1.082, created_at: new Date(T0 - 900_000).toISOString() });
  const db = fakeDb({ genfx_alerts: [pending, zone(), armed()] });
  const placed: FxSignal[] = [];
  let reads = 0;
  const deps = (nowMs: number, px: number): WatchDeps => ({
    quote: async () => ({ px, at: nowMs }), quiet: () => false, now: () => nowMs, confirmBudgetMs: 60,
    place: (async (sig: FxSignal) => { placed.push(sig); return { pair: sig.pair, ran: true, reason: "ok", eligible: 0, placed: 0, skipped: {} }; }) as WatchDeps["place"],
    confirm: (async () => { reads++; await new Promise(() => { /* the candle request hangs */ }); }) as unknown as WatchDeps["confirm"],
  });
  const t = Date.now();
  await genfxWatchPass(A(db), "key", CTL, deps(T0, 1.085));                      // at the page setup's level
  const first = Date.now() - t;
  assert.ok(first < 1_000, `a pass took ${first}ms`);
  assert.equal(reads, 1);                                                        // one read used the allowance; the armed setup's read did not add to it
  await genfxWatchPass(A(db), "key", CTL, deps(T0 + 1_500, 1.08501));
  assert.equal(db.tables.genfx_alerts.find((r) => String(r.dedupe_key).startsWith("zone:"))!.state, "entered");       // the touch: entered on its two looks
  await genfxWatchPass(A(db), "key", CTL, deps(T0 + 3_000, 1.0841));             // back in the armed setup's zone
  await genfxWatchPass(A(db), "key", CTL, deps(T0 + 4_500, 1.08411));
  const byId = (id: string) => db.tables.genfx_alerts.find((r) => r.id === id)!;
  assert.deepEqual([byId("p1").state, placed.map((s) => s.setup).sort()], ["forming", ["scanner", "zone"]]);           // the armed pull-back too; the pending setup just waits
  assert.equal(db.tables.genfx_alerts.filter((r) => r.state === "entered").length, 2);
  // A FEED THAT DID NOT ANSWER IS NOT ASKED AGAIN FOR TEN SECONDS. Four passes, one read. (The third
  // version asked on every pass: with candles hanging, each pass spent its whole allowance, and passes
  // that far apart are close to never seeing a touch twice.)
  assert.equal(reads, 1);
  assert.equal(_sanity.hold.until, T0 + 10_000);
  await genfxWatchPass(A(db), "key", CTL, deps(T0 + 9_000, 1.0841));
  assert.equal(reads, 1);
  // Ten seconds on it is asked again — the pending setup was never marked "read".
  await genfxWatchPass(A(db), "key", CTL, deps(T0 + 10_500, 1.0841));
  assert.equal(reads, 2);
});

/* ── the third review: a pending setup, its price, and its age ── */

/** A pending (un-armed) sell at 1.0840–1.0842, stop 1.0855, target 1.0810: worth taking from 1.0830 up. */
const pendingRow = (o: Row = {}): Row => armed({ enter_sent_at: null, ...o });
/** A desk whose confirmation is what `conf` says of the price the WATCH hands it, with every read recorded. */
function pendingDesk(db: FakeDb, conf: (live: number | null) => string) {
  const feed: { q: Quote | null } = { q: null };
  const placed: FxSignal[] = [];
  const reads: { live: number | null | undefined; noMomentum: boolean | undefined; at: number }[] = [];
  const deps = (nowMs: number): WatchDeps => ({
    quote: async () => feed.q, quiet: () => false, now: () => nowMs,
    place: (async (sig: FxSignal) => { placed.push(sig); return { pair: sig.pair, ran: true, reason: "ok", eligible: 0, placed: 0, skipped: {} }; }) as WatchDeps["place"],
    confirm: (async (o: { live?: number | null; noMomentum?: boolean }) => { reads.push({ live: o.live, noMomentum: o.noMomentum, at: nowMs }); return { state: conf(o.live ?? null), detail: "", side: "sell", price: o.live ?? 1.0841, enter: o.live ?? 1.0841, zoneLow: 0, zoneHigh: 0, invalidation: 0, interval: "5min" }; }) as unknown as WatchDeps["confirm"],
  });
  const pass = (nowMs: number, px: number | null, observedAt = nowMs) => { feed.q = px == null ? null : { px, at: observedAt }; return genfxWatchPass(A(db), "key", CTL, deps(nowMs)); };
  return { pass, placed, reads };
}

test("A PENDING SETUP IS NOT ENTERED ON ONE PRICE: 'confirmed, and worth taking here' has to be seen on two observations of the watch's own quote", async () => {
  // The confirmation turns on where price is (the momentum entry: "has it run too far?"): CONFIRMED from 1.0835 up.
  const db = fakeDb({ genfx_alerts: [pendingRow()] });
  const { pass, placed, reads } = pendingDesk(db, (live) => (live != null && live >= 1.0835 ? "CONFIRMED" : "WAIT"));
  // Two honest reads, ten seconds apart: WAIT.
  await pass(T0, 1.082);
  await pass(T0 + 10_000, 1.082);
  // ONE print at 1.0841, seen once. (The third version: the row is entered and the orders go out.)
  const blip = await pass(T0 + 20_000, 1.0841);
  assert.deepEqual([state(db), placed.length, blip.sent], ["forming", 0, []]);
  // The confirmation was read with the WATCH'S price — it asked the feed for none of its own.
  assert.deepEqual(reads.map((r) => r.live), [1.082, 1.082, 1.0841]);
  // It is looked at again on the very next pass, not ten seconds later — and the price is back where it was.
  await pass(T0 + 21_500, 1.082);
  assert.equal(reads.length, 4);
  assert.deepEqual([state(db), placed.length], ["forming", 0]);
  // The same observation handed back on two passes is one look.
  await pass(T0 + 31_500, 1.0841, T0 + 31_500);
  await pass(T0 + 33_000, 1.0841, T0 + 31_500);
  assert.deepEqual([state(db), placed.length], ["forming", 0]);
  // Two observations a second and a half apart: entered, once, at the watch's price.
  const out = await pass(T0 + 34_500, 1.08412);
  assert.deepEqual([state(db), placed.length, placed[0].setup, db.tables.genfx_alerts[0].enter_price], ["entered", 1, "scanner", 1.08412]);
  assert.ok(out.sent.some((x) => /ENTER/.test(x)));
});

test("…nor armed on one: 'confirmed, but chased' is a matter of price too — and with no price to believe a confirmed setup simply waits", async () => {
  // CONFIRMED on its candles. At 1.0825 a sell from 1.0840 pays 0.5 to 1: chased.
  const db = fakeDb({ genfx_alerts: [pendingRow()] });
  const { pass, placed } = pendingDesk(db, () => "CONFIRMED");
  await pass(T0, 1.0825);
  assert.equal(db.tables.genfx_alerts[0].enter_sent_at, null);                       // seen once: not armed
  await pass(T0 + 1_500, 1.0841);                                                    // now it says "enter" — a different question, seen once
  assert.deepEqual([state(db), db.tables.genfx_alerts[0].enter_sent_at, placed.length], ["forming", null, 0]);
  await pass(T0 + 3_000, 1.0825);
  await pass(T0 + 4_500, 1.08251);
  assert.deepEqual([state(db), !!db.tables.genfx_alerts[0].enter_sent_at, placed.length], ["forming", true, 0]);      // armed, on its second look
  // No quote at all: nothing is entered and nothing is armed on a candle's close.
  const db2 = fakeDb({ genfx_alerts: [pendingRow()] });
  const d2 = pendingDesk(db2, () => "CONFIRMED");
  for (const dt of [0, 1_500, 3_000]) await d2.pass(T0 + dt, null);
  assert.deepEqual([state(db2), db2.tables.genfx_alerts[0].enter_sent_at, d2.placed.length], ["forming", null, 0]);
  assert.deepEqual(d2.reads.map((r) => r.live), [null, null, null]);
  // …but candles that END it need no price.
  const db3 = fakeDb({ genfx_alerts: [pendingRow()] });
  const d3 = pendingDesk(db3, () => "INVALIDATED");
  await d3.pass(T0, null);
  assert.equal(state(db3), "invalidated");
});

test("the momentum question is asked once per five-minute candle — on the first read after the close, through to its second look", async () => {
  // 14:00:00 UTC is a candle boundary; the feed has the closed candle from 14:00:08.
  const db = fakeDb({ genfx_alerts: [pendingRow()] });
  const { pass, reads } = pendingDesk(db, () => "WAIT");
  await pass(T0 + 20_000, 1.082);                  // the first read of the 14:00 candle
  await pass(T0 + 30_000, 1.082);
  await pass(T0 + 40_000, 1.082);
  await pass(T0 + 300_000 + 5_000, 1.082);         // 14:05:05 — the feed does not have the 14:05 close yet: still the same candle
  await pass(T0 + 300_000 + 15_000, 1.082);        // 14:05:15 — the first read after it
  await pass(T0 + 300_000 + 25_000, 1.082);
  assert.deepEqual(reads.map((r) => r.noMomentum), [false, true, true, true, false, true]);
  // A first read that says "enter" is not final until its second look: momentum is still asked on that one.
  const db2 = fakeDb({ genfx_alerts: [pendingRow()] });
  const d2 = pendingDesk(db2, () => "CONFIRMED");
  await d2.pass(T0 + 20_000, 1.0841);
  await d2.pass(T0 + 21_500, 1.08411);
  assert.deepEqual([d2.reads.map((r) => r.noMomentum), state(db2)], [[false, false], "entered"]);
  // A read that could not be made has not asked the question.
  const db3 = fakeDb({ genfx_alerts: [pendingRow()] });
  let n = 0;
  const d3 = pendingDesk(db3, () => (n++ === 0 ? "NO_DATA" : "WAIT"));
  await d3.pass(T0 + 20_000, 1.082);
  await d3.pass(T0 + 30_000, 1.082);
  await d3.pass(T0 + 40_000, 1.082);
  assert.deepEqual(d3.reads.map((r) => r.noMomentum), [false, false, true]);
});

test("a pending setup left over from before is let go by the watch itself — it is not acted on because the scanner was off when its time ran out", async () => {
  // Three days old: the scan's housekeeping would have let it go at eight hours, but the scanner was
  // switched off. Switched back on, the watch runs before the first scan. (The third version: confirmed,
  // price in the zone — entered and placed by the first pass.)
  const old = pendingRow({ id: "old", created_at: new Date(T0 - 3 * 86_400_000).toISOString() });
  const unreadable = pendingRow({ id: "bad", created_at: "not a time", dedupe_key: "EURUSD:quick:sell:1:2:20261006" });
  const oldArmed = armed({ id: "oldarmed", created_at: new Date(T0 - 3 * 86_400_000).toISOString(), enter_sent_at: new Date(T0 - 60_000).toISOString(), dedupe_key: "EURUSD:quick:sell:3:4:20261006" });
  const swing = pendingRow({ id: "swing", mode: "swing", created_at: new Date(T0 - 40 * 3600_000).toISOString(), dedupe_key: "EURUSD:swing:sell:5:6:20261006" });      // a Swing setup has 48 hours
  const db = fakeDb({ genfx_alerts: [old, unreadable, oldArmed, swing] });
  const { pass, placed, reads } = pendingDesk(db, () => "CONFIRMED");
  const out = await pass(T0, 1.0841);
  await pass(T0 + 1_500, 1.08411);
  const st = (id: string) => db.tables.genfx_alerts.find((r) => r.id === id)!.state;
  assert.deepEqual([st("old"), st("bad"), st("oldarmed"), st("swing")], ["expired", "expired", "expired", "entered"]);
  assert.deepEqual([placed.length, placed[0].mode], [1, "swing"]);
  assert.equal(out.sent.filter((x) => /EXPIRED/.test(x)).length, 3);
  assert.equal(reads.length, 2);                                     // nothing was read for the three that were let go
});

test("a feed that answers, a little slowly, is not a feed that is not answering: the read that happens to be running when the allowance ends does not stop the watch reading", async () => {
  // Three pending setups, each on its own candles; a read takes 180 ms and a pass gives them 300 ms together.
  // The second read is cut off — and that is all. (The fourth version took the cut-off read for a dead feed
  // and read nothing for ten seconds: the setups after it were never read, and a confirmed one could not get
  // its second look inside eight seconds — so it was never entered.)
  const rowsIn = (["quick", "intraday", "swing"] as const).map((mode, k) => pendingRow({ id: `s${k}`, mode, dedupe_key: `EURUSD:${mode}:sell:10840:10842:20261006`, created_at: new Date(T0 - 900_000 + k * 1_000).toISOString() }));
  const db = fakeDb({ genfx_alerts: rowsIn });
  const read: string[] = [];
  const deps = (nowMs: number): WatchDeps => ({
    quote: async () => ({ px: 1.082, at: nowMs }), quiet: () => false, now: () => nowMs, confirmBudgetMs: 300,
    place: (async () => ({ pair: "EURUSD", ran: true, reason: "ok", eligible: 0, placed: 0, skipped: {} })) as unknown as WatchDeps["place"],
    confirm: (async (o: { entryLow: number }) => { await new Promise((r) => setTimeout(r, 180)); read.push(String(o.entryLow)); return { state: "WAIT", detail: "", side: "sell", price: 1.082, enter: null, zoneLow: 0, zoneHigh: 0, invalidation: 0, interval: "5min" }; }) as unknown as WatchDeps["confirm"],
  });
  await genfxWatchPass(A(db), "key", CTL, deps(T0));
  assert.equal(_sanity.hold.until, 0);                                        // no back-off: the feed answered
  const checked = () => db.tables.genfx_alerts.map((r) => r.last_checked_at === new Date(T0 - 60_000).toISOString() ? "-" : "read");
  assert.deepEqual(checked(), ["read", "-", "-"]);
  // The next passes read the ones it did not reach, first.
  await genfxWatchPass(A(db), "key", CTL, deps(T0 + 1_500));
  await genfxWatchPass(A(db), "key", CTL, deps(T0 + 3_000));
  assert.deepEqual([checked(), _sanity.hold.until], [["read", "read", "read"], 0]);
});
