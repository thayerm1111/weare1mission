import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAIRS } from "../src/lib/genfx/pairs";
import { registerZone, findSameSetup, findRecall, scannerStep, gradeEntered, scanReader, isOlder, RECALL_WINDOW_MS, type FxAlert } from "../src/lib/genfx/scan";
import { zoneKey, scanKey, GRADE_EXPIRY_MS } from "../src/lib/genfx/decide";
import { controlOf } from "../src/lib/genfx/control";
import { type FxSignal } from "../src/lib/genfx/place";
import { fxUnreachableUserIds, billFxSetup, fxPassUserIds, fxFireGate } from "../src/lib/genfx/billing";
import { PLAN_FLOW_PASS } from "../src/lib/subscription";
import { withTimeout, utcMs } from "../src/lib/genfx/market";
import { givesPlayAway } from "../src/lib/publicSignal";
import { fakeDb, type Row, type FakeOpts } from "./_genfx_fakedb";

/*
 * The scanner's record is only worth reading if one idea is one call. These hold it to that: a page
 * setup follows what the page shows (and is not offered twice at one level), a drifting zone is the
 * call already made, and a read that fails is never taken to mean "nothing there".
 */
const E = PAIRS.EURUSD, J = PAIRS.GBPJPY;
type Admin = Parameters<typeof registerZone>[0];
const db = (rows: Row[] = [], opts: FakeOpts = {}) => fakeDb({ genfx_alerts: rows }, { unique: { genfx_alerts: [["dedupe_key"]] }, ...opts });
const A = (d: ReturnType<typeof fakeDb>) => d as unknown as Admin;
const NOON = Date.UTC(2026, 9, 6, 12, 0);
const sell = (entry: number, o: Row = {}) => ({ action: "WAIT_FOR_SELL_TRIGGER", entry, stop_loss: +(entry + 0.0015).toFixed(5), tp1: +(entry - 0.003).toFixed(5), tp2: null, tp3: null, confidence_score: 61, trigger_tf: "5-minute", ...o });
const rows = (d: ReturnType<typeof fakeDb>) => d.tables.genfx_alerts;
const CTL = controlOf({ scan_enabled: true, auto_enabled: false, auto_scope: "demo", billing_enabled: false, telegram_enabled: true, config: {} });
type Engine = Parameters<typeof scannerStep>[4];
/** What the engine says when a sell setup is developing at 1.0840–1.0842 (or wherever `lo` puts it). */
const forming = (lo = 1.084, o: Record<string, unknown> = {}) => ({
  engine_state: "DEVELOPING_SETUP", action: "WAIT_FOR_SELL_TRIGGER", entry: +(lo + 0.0001).toFixed(5), entry_low: lo, entry_high: +(lo + 0.0002).toFixed(5),
  stop_loss: +(lo + 0.0015).toFixed(5), tp1: +(lo - 0.003).toFixed(5), tp2: null, tp3: null, closest_resistance: +(lo + 0.0002).toFixed(5), closest_support: null,
  invalidation_price: +(lo + 0.0015).toFixed(5), confidence_score: 62, trigger_tf: "5-minute", ...o,
}) as unknown as Engine;
type Confirm = NonNullable<NonNullable<Parameters<typeof scannerStep>[7]>["confirm"]>;
/** A confirmation that says `state`, at `price`. */
const confirms = (state: string, price: number | null = 1.0835): Confirm => (async () => ({ state, detail: "", side: "sell", price, enter: state === "CONFIRMED" ? price : null, zoneLow: 0, zoneHigh: 0, invalidation: 0, interval: "5min" })) as unknown as Confirm;
/** The channel, caught at the network: every message GEN FX would have posted. */
function channel(): { posts: string[]; close: () => void } {
  const posts: string[] = [], real = globalThis.fetch, env = [process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHANNEL_ID];
  process.env.TELEGRAM_BOT_TOKEN = "t"; process.env.TELEGRAM_CHANNEL_ID = "@c";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith("https://api.telegram.org/")) throw new Error(`test: unexpected network call ${String(input)}`);
    posts.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { posts, close: () => { globalThis.fetch = real; [process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHANNEL_ID] = env; if (env[0] == null) delete process.env.TELEGRAM_BOT_TOKEN; if (env[1] == null) delete process.env.TELEGRAM_CHANNEL_ID; } };
}

test("a page setup is registered once, refreshed while it shows, and replaced by a newer one on its side", async () => {
  const d = db();
  assert.equal(await registerZone(A(d), E, "quick", sell(1.085), 1.0841, NOON), "registered");
  const r = rows(d)[0];
  assert.deepEqual([r.dedupe_key, r.state, r.side, r.entry, r.stop, r.tp1, r.mode, r.pair], [zoneKey(E, "quick", "sell", 1.085, NOON), "zone", "sell", 1.085, 1.0865, 1.082, "quick", "EURUSD"]);
  assert.deepEqual([r.entry_low, r.entry_high], [1.08497, 1.08503]);
  // Five minutes on the page shows the same entry with a stop that has moved a little: the row follows it.
  const later = NOON + 300_000;
  assert.equal(await registerZone(A(d), E, "quick", sell(1.085, { stop_loss: 1.0867, tp1: 1.0818 }), 1.0842, later), "refreshed");
  assert.deepEqual([rows(d).length, rows(d)[0].stop, rows(d)[0].tp1, rows(d)[0].last_checked_at], [1, 1.0867, 1.0818, new Date(later).toISOString()]);
  // A different sell level on the same horizon replaces it; a buy, or another horizon, does not.
  assert.equal(await registerZone(A(d), E, "quick", sell(1.0858), 1.0842, later), "registered");
  assert.deepEqual(rows(d).map((x) => x.state), ["replaced", "zone"]);
  await registerZone(A(d), E, "quick", { action: "BUY_LIMIT", entry: 1.082, stop_loss: 1.0805, tp1: 1.085 }, 1.0842, later);
  await registerZone(A(d), E, "intraday", sell(1.0861), 1.0842, later);
  await registerZone(A(d), J, "quick", { action: "SELL_LIMIT", entry: 201.9, stop_loss: 202.3, tp1: 201.1 }, 201.4, later);
  assert.deepEqual(rows(d).map((x) => `${String(x.pair)}:${String(x.mode)}:${String(x.side)}:${String(x.state)}`), ["EURUSD:quick:sell:replaced", "EURUSD:quick:sell:zone", "EURUSD:quick:buy:zone", "EURUSD:intraday:sell:zone", "GBPJPY:quick:sell:zone"]);
  // Not a setup at all, or one whose stop price is already through: nothing is written.
  assert.equal(await registerZone(A(d), E, "swing", { action: "SELL_NOW", entry: 1.085, stop_loss: 1.0865, tp1: 1.082 }, 1.0841, later), "no_setup");
  assert.equal(await registerZone(A(d), E, "swing", sell(1.085), 1.0866, later), "beyond_stop");
  assert.equal(rows(d).length, 5);
});

test("a setup the page comes back to the same day is watched again; one that was entered or broken is not offered twice", async () => {
  const d = db();
  await registerZone(A(d), E, "quick", sell(1.085), 1.0841, NOON);
  await registerZone(A(d), E, "quick", sell(1.0858), 1.0842, NOON + 300_000);            // A is replaced by B
  assert.equal(await registerZone(A(d), E, "quick", sell(1.085, { stop_loss: 1.0866 }), 1.0843, NOON + 600_000), "revived");     // …and the page returns to A
  assert.deepEqual(rows(d).map((x) => [x.entry, x.state]), [[1.085, "zone"], [1.0858, "replaced"]]);
  assert.equal(rows(d)[0].stop, 1.0866);                                                    // with the levels it shows now
  // Timed out, then shown again: same.
  rows(d)[0].state = "expired";
  assert.equal(await registerZone(A(d), E, "quick", sell(1.085), 1.0843, NOON + 900_000), "revived");
  // Entered, or broken through its stop: used for the day.
  for (const state of ["entered", "invalidated"]) {
    rows(d)[0].state = state;
    assert.equal(await registerZone(A(d), E, "quick", sell(1.085), 1.0843, NOON + 1_200_000), `used:${state}`);
    assert.equal(rows(d)[0].state, state);
  }
  assert.equal(rows(d).length, 2);
  // …and not again just because the date rolled over: entered at 23:50, the same level at 00:05 is the same level.
  const late = Date.UTC(2026, 9, 6, 23, 50), next = Date.UTC(2026, 9, 7, 0, 5);
  const d2 = db();
  await registerZone(A(d2), E, "quick", sell(1.09), 1.0895, late);
  Object.assign(rows(d2)[0], { state: "entered", outcome: null, enter_sent_at: new Date(late).toISOString(), updated_at: new Date(late).toISOString() });
  assert.notEqual(zoneKey(E, "quick", "sell", 1.09, late), zoneKey(E, "quick", "sell", 1.09, next));
  // Still running: it is that trade. Stopped out at 23:58: it is yesterday's level, used.
  assert.match(await registerZone(A(d2), E, "quick", sell(1.09), 1.0899, next), /^used:running:/);
  Object.assign(rows(d2)[0], { outcome: "loss" });
  assert.equal(await registerZone(A(d2), E, "quick", sell(1.09), 1.0899, next), "used_yesterday:entered");
  assert.equal(rows(d2).length, 1);
  // Twelve hours later it is a new day's level.
  assert.equal(await registerZone(A(d2), E, "quick", sell(1.09), 1.0899, late + 13 * 3600_000), "registered");
  // A level that was only being watched yesterday (never traded) carries straight over.
  const d3 = db();
  await registerZone(A(d3), E, "quick", sell(1.09), 1.0895, late);
  assert.equal(await registerZone(A(d3), E, "quick", sell(1.09), 1.0899, next), "registered");
  assert.deepEqual(rows(d3).map((x) => x.state), ["replaced", "zone"]);
});

test("a table that cannot be read is an error, not an empty table", async () => {
  const blind = db([], { fail: (op) => op.kind === "select" });
  assert.equal(await registerZone(A(blind), E, "quick", sell(1.085), 1.0841, NOON), "error");
  assert.equal(rows(blind).length, 0);
  await assert.rejects(() => findSameSetup(A(blind), E, "quick", { side: "sell", entry_low: 1.084, entry_high: 1.0842 }), /alerts_unreadable/);
  // …and the scanner treats that as "do not call it", for every horizon: nothing recorded, nothing placed.
  for (const mode of ["quick", "intraday", "swing"] as const) {
    const placed: unknown[] = [];
    const out = await scannerStep(A(blind), CTL, E, mode, forming(), 1.0835, "key", { nowMs: NOON, confirm: confirms("WAIT"), place: (async (x: unknown) => { placed.push(x); }) as never });
    assert.deepEqual([out.result, rows(blind).length, placed.length], ["alerts_unreadable", 0, 0]);
  }
  // The key lookup answers and the same-setup read does not: still not called.
  let reads = 0;
  const half = db([], { fail: (op) => op.kind === "select" && ++reads >= 2 });
  assert.equal((await scannerStep(A(half), CTL, E, "quick", forming(), 1.0835, "key", { nowMs: NOON, confirm: confirms("WAIT") })).result, "alerts_unreadable");
  assert.equal(rows(half).length, 0);
  assert.ok(!/startsWith\(`\$\{row\.pair\}:quick:`\)/.test(readFileSync("src/lib/genfx/watch.ts", "utf8")), "the watch merges duplicates on every horizon, not Quick alone");
});

test("one setup, one call: a drifting zone is the call already open — on every horizon, for as long as it is open", async () => {
  const now = Date.now();
  const call = (mode: string, side: string, lo: number, hi: number, o: Row = {}) => ({ pair: "EURUSD", mode, side, entry_low: lo, entry_high: hi, state: "forming", outcome: null, dedupe_key: scanKey(E, mode as "quick", side as "sell", lo, hi, now), created_at: new Date(now - 3600_000).toISOString(), ...o });
  const d = db([
    call("quick", "sell", 1.084, 1.0842),
    call("intraday", "sell", 1.086, 1.0866, { created_at: new Date(now - 7 * 3600_000).toISOString() }),                        // seven hours old and still pending
    call("swing", "buy", 1.07, 1.0712, { state: "entered", created_at: new Date(now - 40 * 3600_000).toISOString() }),         // entered, not graded yet
    call("quick", "buy", 1.08, 1.0802, { state: "entered", outcome: "win" }),                                                   // graded: over
    call("quick", "sell", 1.09, 1.0902, { state: "invalidated" }),
    { ...call("quick", "sell", 1.0841, 1.0841), dedupe_key: zoneKey(E, "quick", "sell", 1.0841, now), state: "entered" },         // a page setup, not a scanner call
  ]);
  const find = (mode: "quick" | "intraday" | "swing", side: "buy" | "sell", lo: number, hi: number) => findSameSetup(A(d), E, mode, { side, entry_low: lo, entry_high: hi });
  // Four pips of drift on Quick is the same setup; nine is not; the other side is not.
  assert.equal((await find("quick", "sell", 1.0844, 1.0846))?.dedupe_key, rows(d)[0].dedupe_key);
  assert.equal(await find("quick", "sell", 1.0849, 1.0851), null);
  assert.equal(await find("quick", "buy", 1.084, 1.0842), null);
  // GENX stops at Quick and at four hours. Here a seven-hour-old Intraday call still pending is still the call…
  assert.equal((await find("intraday", "sell", 1.0863, 1.0869))?.mode, "intraday");
  // …and a Swing call entered forty hours ago and not yet graded is still the call.
  assert.equal((await find("swing", "buy", 1.0704, 1.0716))?.state, "entered");
  // Horizons keep their own books: Quick's open call is not Intraday's.
  assert.equal(await find("intraday", "sell", 1.084, 1.0842), null);
  // A call that has been graded, or let go, is over: the level can be called again.
  assert.equal(await find("quick", "buy", 1.08, 1.0802), null);
  assert.equal(await find("quick", "sell", 1.09, 1.0902), null);
  // The row asking is never its own twin.
  assert.equal(await findSameSetup(A(d), E, "quick", { side: "sell", entry_low: 1.084, entry_high: 1.0842 }, String(rows(d)[0].id)), null);
  // Of two rows that are one setup, the earlier is the call. Same instant: the lower id — never both retired.
  const a = { id: "a", created_at: "2026-10-06T12:00:00.000+00:00" }, b = { id: "b", created_at: "2026-10-06T12:00:00.000+00:00" }, c = { id: "c", created_at: "2026-10-06T12:05:00.000+00:00" };
  assert.deepEqual([isOlder(a, c), isOlder(c, a), isOlder(a, b), isOlder(b, a)], [true, false, true, false]);
});

test("the setup fee, if it is ever switched on, goes only to members GEN FX can actually trade for", async () => {
  const now = Date.now();
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const d = fakeDb({
    flow_auto_events: [
      { user_id: "broken", status: "skipped", reason: "genfx: broker_unreadable (couldn't read your orders)", created_at: at(30) },
      { user_id: "fixed", status: "skipped", reason: "genfx: no_broker_token (reconnect your broker)", created_at: at(300) },
      { user_id: "fixed", status: "placed", reason: "genfx", created_at: at(20) },                           // an order reached it since
      { user_id: "eur", status: "skipped", reason: "genfx: non_usd_account (GEN FX sizes in dollars; this account is in EUR)", created_at: at(90) },
      { user_id: "gold-only", status: "skipped", reason: "genx: no_equity (broker did not return this account)", created_at: at(10) },     // gold's row, not GEN FX's
      { user_id: "choosy", status: "skipped", reason: "genfx: chased (this broker's price is past the 0.8-to-1 floor)", created_at: at(10) },   // not a broker failure
      { user_id: "old", status: "skipped", reason: "genfx: no_equity (broker did not return this account's size)", created_at: at(26 * 60) },    // outside 24h
    ],
  });
  type B = Parameters<typeof fxUnreachableUserIds>[0];
  assert.deepEqual([...(await fxUnreachableUserIds(d as unknown as B, now))].sort(), ["broken", "eur"]);
  // A read that fails exempts nobody (gold's own rule fails the same way).
  assert.equal((await fxUnreachableUserIds(fakeDb({}, { fail: () => true }) as unknown as B, now)).size, 0);
  // A setup auto-trade would not place bills nobody, before any table is read.
  const quietDb = fakeDb({}, { fail: () => { throw new Error("no table should be read"); } });
  assert.deepEqual(await billFxSetup(quietDb as unknown as B, "EURUSD:quick:sell:1:2:20261006", ["a", "b"], { ok: false, why: "stop_under_minimum" }), { members: 0, charged: 0, paused: 0, pass: 0, unreachable: 0, skipped: "stop_under_minimum" });
  assert.deepEqual(await billFxSetup(quietDb as unknown as B, "k", [], { ok: true }), { members: 0, charged: 0, paused: 0, pass: 0, unreachable: 0 });
  const scan = readFileSync("src/lib/genfx/scan.ts", "utf8");
  assert.match(scan, /const tradeable = !ctl\.auto \? \{ ok: false, why: "auto_off" \} : !room\.ok \? \{ ok: false, why: "stop_under_minimum" \} : \{ ok: true \};/);
});

test("who holds a Pass is asked a hundred members at a time — and when it cannot be read, nobody is charged", async () => {
  // (The third version asked in one request naming every member: past a couple of hundred that request
  // is refused, the lookup answered "nobody has a Pass", and every Pass holder was billed.)
  type B = Parameters<typeof fxPassUserIds>[0];
  const ids = Array.from({ length: 250 }, (_, i) => `u${i}`);
  const sub = (user_id: string, o: Row = {}): Row => ({ user_id, plan: PLAN_FLOW_PASS, status: "active", current_period_end: null, cancel_at_period_end: false, ...o });
  const d = fakeDb({ user_subscriptions: [sub("u3"), sub("u120"), sub("u249"), sub("u7", { status: "canceled" }), sub("u8", { plan: "trading_suite" })], user_credits: [] });
  const pass = await fxPassUserIds(d as unknown as B, ids);
  assert.deepEqual([...pass!].sort(), ["u120", "u249", "u3"]);
  assert.equal(d.ops.filter((o) => o.table === "user_subscriptions").length, 3);         // 100 + 100 + 50
  // One part of the list unreadable: no answer at all — part of a list is not the list.
  let n = 0;
  const flaky = fakeDb({ user_subscriptions: [sub("u3")], user_credits: [] }, { fail: (op) => op.table === "user_subscriptions" && ++n === 2 });
  assert.equal(await fxPassUserIds(flaky as unknown as B, ids), null);
  // Not knowing who holds a Pass: everyone may trade, nobody pays for it — and nobody is billed for the setup.
  const blind = () => fakeDb({ user_subscriptions: [sub("u3")], user_credits: [] }, { fail: (op) => op.table === "user_subscriptions" });
  const gate = await fxFireGate(blind() as unknown as B, ["u3", "u4"]);
  assert.deepEqual([[...gate.eligible].sort(), [...gate.billable]], [["u3", "u4"], []]);
  const b = blind();
  assert.deepEqual(await billFxSetup(b as unknown as B, "k", ["u3", "u4"], { ok: true }), { members: 0, charged: 0, paused: 0, pass: 0, unreachable: 0, skipped: "passes_unreadable" });
  assert.equal(b.ops.filter((o) => o.kind === "rpc").length, 0);                         // the meter was never called
  // Readable: the Pass holder trades free, and is not asked to pay.
  const ok = await fxFireGate(fakeDb({ user_subscriptions: [sub("u3")], user_credits: [] }) as unknown as B, ["u3"]);
  assert.deepEqual([[...ok.eligible], [...ok.billable]], [["u3"], []]);
});

test("small things the scanner leans on: a request that hangs gives up, and a feed time is read as UTC", async () => {
  assert.equal(await withTimeout(new Promise<number>(() => { /* never */ }), 30), null);
  assert.equal(await withTimeout(Promise.resolve(7), 30), 7);
  await assert.rejects(() => withTimeout(Promise.reject(new Error("x")), 30));
  assert.equal(utcMs("2026-10-02 14:35:00"), Date.UTC(2026, 9, 2, 14, 35));
  assert.equal(utcMs("2026-10-02"), Date.UTC(2026, 9, 2));
  assert.equal(utcMs("2026-10-02T14:35:00Z"), Date.UTC(2026, 9, 2, 14, 35));
  assert.equal(utcMs("2026-10-02T14:35:00+02:00"), Date.UTC(2026, 9, 2, 12, 35));
  assert.ok(Number.isNaN(utcMs("")));
  // The scanner's candles and price go through the shared, bounded reader; the page's own polling does not.
  const scan = readFileSync("src/lib/genfx/scan.ts", "utf8");
  assert.match(scan, /const source = \{ series: \(interval: string, size: number\) => read\(pair, interval, size, \{ maxAgeMs: 20_000 \}\), price: \(\) => pairPrice\(pair\) \};/);
  assert.match(scan, /const rows = await series\(pair\.td, interval, size, \{ \.\.\.o, notBeforeMs: candleFloorMs\(nowMs\), timeoutMs: readMs \}\);/);
  assert.match(scan, /mode: row\.mode, mdKey, fresh: true, desk: true,/);
  assert.match(scan, /fxSeries\(pair\.td, "5min", 1500, \{ utc: true, maxAgeMs: 30_000, notBeforeMs: candleFloorMs\(nowMs\) \}\)/);
  assert.ok(!/from "@\/lib\/marketData"/.test(scan), "the scanner makes no market-data request of its own");
  const market = readFileSync("src/lib/genfx/market.ts", "utf8");
  assert.match(market, /withTimeout\(series\(td, interval, want, key, true, o\.utc \? "UTC" : undefined\), o\.timeoutMs \?\? 12_000\)/);
});

test("the scan asks a feed that is not answering once: the first read to run out of time is the last one made", async () => {
  // (The third version: with the candle endpoint hanging and prices answering, every horizon of both
  // pairs waited out its own timeout — 72 seconds in which the watch, next on the same loop, did not run.)
  const calls: string[] = [];
  let mode: "hang" | "error" | "busy" | "ok" = "ok";
  const series = (async (td: string, interval: string, _size: number, o: { timeoutMs?: number; notBeforeMs?: number } = {}) => {
    calls.push(`${td}:${interval}`);
    assert.equal(o.timeoutMs, 60);                                              // every read carries the scan's own short limit…
    assert.equal(typeof o.notBeforeMs, "number");                               // …and is never a copy from before the candle that just closed
    if (mode === "hang") { await new Promise((r) => setTimeout(r, 60)); return null; }      // what the bounded reader answers when its time is up
    if (mode === "error") return null;                                          // a quick failure
    if (mode === "busy") return "ratelimit" as const;
    return [{ datetime: "2026-10-06 12:00:00", open: "1", high: "1", low: "1", close: "1" }];
  }) as unknown as Parameters<typeof scanReader>[1];
  const { read, feed } = scanReader(NOON, series, 60);
  // Answers, quick failures and a busy feed stop nothing.
  assert.ok(Array.isArray(await read(E, "5min", 150, { maxAgeMs: 20_000 })));
  mode = "error"; assert.equal(await read(E, "15min", 150, { maxAgeMs: 20_000 }), null);
  mode = "busy"; assert.equal(await read(E, "1h", 120, { maxAgeMs: 20_000 }), "ratelimit");
  assert.deepEqual([feed.down, calls.length], [false, 3]);
  // One horizon's five reads go out together and all run out of time…
  mode = "hang";
  const t = Date.now();
  const five = await Promise.all(["1day", "1h", "30min", "15min", "5min"].map((iv) => read(E, iv, 150, { maxAgeMs: 20_000 })));
  assert.deepEqual([five.every((x) => x === null), feed.down, calls.length], [true, true, 8]);
  // …and nothing more is asked: the other horizons, the other pair and the grading read answer at once.
  const t2 = Date.now();
  for (const p of [E, J]) for (const iv of ["1h", "15min", "5min"]) assert.equal(await read(p, iv, 150, { maxAgeMs: 20_000 }), null);
  assert.equal(await read(J, "5min", 1500, { utc: true, maxAgeMs: 30_000 }), null);
  assert.equal(calls.length, 8);
  assert.ok(Date.now() - t2 < 50 && t2 - t < 1_000);
  // The scan skips every horizon it has not read yet, says so, and tells its caller — who does not grade page reads from the same feed.
  const scan = readFileSync("src/lib/genfx/scan.ts", "utf8");
  assert.match(scan, /const \{ read, feed \} = scanReader\(nowMs\);/);
  assert.match(scan, /if \(feed\.down\) \{ out\.skip = "feed_not_answering"; continue; \}/);
  // Grading asks first, for one long request a pair, through a reader of its OWN: that request being slow
  // must not stop the horizons' thirty short ones being asked. Either one timing out is reported.
  assert.match(scan, /const grading = scanReader\(nowMs\);/);
  assert.match(scan, /graded = await gradeEntered\(admin, ctl, \{ candles: \(pair\) => grading\.read\(pair, "5min", 1500, \{ utc: true, maxAgeMs: 30_000 \}\) \}\);/);
  assert.match(scan, /const feedDown = feed\.down \|\| grading\.feed\.down;/);
  const other = scanReader(NOON, series, 60);
  assert.equal(other.feed.down, false);                                                 // one reader's verdict is its own
  mode = "ok";
  assert.ok(Array.isArray(await other.read(E, "5min", 150, { maxAgeMs: 20_000 })));
  // The confirmation a scan step reads goes through the bounded reader with the scan's own limit.
  assert.match(readFileSync("src/lib/genfx/confirm.ts", "utf8"), /fxSeries\(pair\.td, interval, 24, \{ maxAgeMs: 5_000, notBeforeMs: candleFloorMs\(\), timeoutMs: 8_000 \}\)/);
  const worker = readFileSync("worker/genfx.ts", "utf8"), cron = readFileSync("src/app/api/cron/genfx-scan/route.ts", "utf8");
  assert.match(worker, /if \(r\.feedDown\) log\(/);
  assert.equal((cron.match(/if \(!scan\.feedDown\) \{ try \{ (graded = )?await resolveGenfxOpen\(mdKey\); \}/g) ?? []).length, 2);
  // Page reads are graded through the same bounded reader — the market-data client has no timeout of its own.
  const resolve = readFileSync("src/lib/genfx/resolve.ts", "utf8");
  assert.match(resolve, /await fxSeries\(pair\.td, "5min", size, \{ utc: true, maxAgeMs: 30_000, timeoutMs: 8_000, notBeforeMs: candleFloorMs\(nowMs\) \}\);/);
  assert.ok(!/from "@\/lib\/marketData"/.test(resolve), "grading makes no market-data request of its own");
});

test("a page setup a fraction of a pip from one that is entered and still running is that trade, not a second one", async () => {
  const d = db();
  await registerZone(A(d), E, "quick", sell(1.085), 1.0841, NOON);
  Object.assign(rows(d)[0], { state: "entered", outcome: null, enter_sent_at: new Date(NOON + 60_000).toISOString() });
  // Five minutes on the engine shows the level 0.2 of a pip higher, same stop. (This used to be registered, and entered again.)
  const res = await registerZone(A(d), E, "quick", sell(1.08502, { stop_loss: 1.0865 }), 1.0842, NOON + 300_000);
  assert.equal(res, `used:running:${String(rows(d)[0].dedupe_key)}`);
  assert.equal(rows(d).length, 1);
  // Four pips of drift is still the same setup; nine is another level.
  assert.match(await registerZone(A(d), E, "quick", sell(1.0854), 1.0842, NOON + 600_000), /^used:running:/);
  assert.equal(await registerZone(A(d), E, "quick", sell(1.0859), 1.0842, NOON + 600_000), "registered");
  // The other side, another horizon, the other pair: their own books.
  assert.equal(await registerZone(A(d), E, "quick", { action: "BUY_LIMIT", entry: 1.08502, stop_loss: 1.0835, tp1: 1.088 }, 1.0855, NOON + 600_000), "registered");
  assert.equal(await registerZone(A(d), E, "intraday", sell(1.08502), 1.0842, NOON + 600_000), "registered");
  // Once that trade has been graded it is over: the level, a touch away, can be called again.
  Object.assign(rows(d)[0], { outcome: "win" });
  rows(d).splice(1);                                                             // (only the first call left on the table)
  assert.equal(await registerZone(A(d), E, "quick", sell(1.08502), 1.0842, NOON + 900_000), "registered");
  // A scanner call running nearby is not a page setup, and does not stand in a page setup's way.
  const d2 = db([{ pair: "EURUSD", mode: "quick", side: "sell", state: "entered", outcome: null, entry_low: 1.0849, entry_high: 1.0851, dedupe_key: scanKey(E, "quick", "sell", 1.0849, 1.0851, NOON) }]);
  assert.equal(await registerZone(A(d2), E, "quick", sell(1.08502), 1.0842, NOON), "registered");
  // And if the table cannot be read, nothing is registered on a guess.
  const blind = db([], { fail: (op) => op.kind === "select" });
  assert.equal(await registerZone(A(blind), E, "quick", sell(1.085), 1.0841, NOON), "error");
});

test("'used yesterday' is counted from when the level was entered, not from when its result was written", async () => {
  // Entered 08:00, graded 23:30 — which rewrites the row. At 00:05 it is sixteen hours since the entry: a new day's level.
  const day = Date.UTC(2026, 9, 6), next = Date.UTC(2026, 9, 7, 0, 5);
  const d = db();
  await registerZone(A(d), E, "quick", sell(1.09), 1.0895, day + 8 * 3600_000);
  Object.assign(rows(d)[0], { state: "entered", outcome: "loss", enter_sent_at: new Date(day + 8 * 3600_000).toISOString(), updated_at: new Date(day + 23.5 * 3600_000).toISOString() });
  assert.equal(await registerZone(A(d), E, "quick", sell(1.09), 1.0899, next), "registered");
  // Entered at 23:50: fifteen minutes later it is still the same level.
  const d2 = db();
  await registerZone(A(d2), E, "quick", sell(1.09), 1.0895, day + 23.8 * 3600_000);
  Object.assign(rows(d2)[0], { state: "entered", outcome: "loss", enter_sent_at: new Date(day + 23.83 * 3600_000).toISOString(), updated_at: new Date(next - 60_000).toISOString() });
  assert.equal(await registerZone(A(d2), E, "quick", sell(1.09), 1.0899, next), "used_yesterday:entered");
});

test("a new scanner setup is a heads-up — once. The same setup let go and read again minutes later is traded, not announced or billed again", async () => {
  const d = db(), ch = channel();
  try {
    const step = (lo: number, at: number) => scannerStep(A(d), CTL, E, "quick", forming(lo), 1.0835, "key", { nowMs: at, confirm: confirms("WAIT") });
    const first = await step(1.084, NOON);
    assert.equal(first.result, "headsup");
    const k1 = String(rows(d)[0].dedupe_key);
    assert.deepEqual([rows(d).length, rows(d)[0].state, rows(d)[0].fee_key, ch.posts.length], [1, "forming", k1, 1]);
    // The channel is told a Quick setup is forming on EUR/USD and where to read it — not which way or where.
    assert.match(ch.posts[0], /GEN FX QUICK — setup forming<\/b>\nEUR\/USD\n/);
    assert.match(ch.posts[0], /Run GEN FX to see the play/);
    assert.equal(givesPlayAway(ch.posts[0]), false);
    // Still pending, read again a pip away: it is the call already open. Nothing is written.
    assert.match(String((await step(1.0841, NOON + 300_000)).result), /^same_setup:/);
    // Its five minutes ran out (or a candle closed through it): let go. Fifteen minutes later the engine
    // reads the same idea again, a pip higher — a new key.
    Object.assign(rows(d)[0], { state: "invalidated", updated_at: new Date(NOON + 600_000).toISOString() });
    const back = await step(1.0841, NOON + 900_000);
    assert.equal(back.result, `back:${k1}`);
    assert.deepEqual([rows(d).length, rows(d)[1].state, rows(d)[1].fee_key, ch.posts.length], [2, "forming", k1, 1]);       // recorded, on the FIRST one's fee key, and not announced again
    assert.notEqual(rows(d)[1].dedupe_key, k1);
    // Let go and back a second time: still the first heads-up's key — the chain does not start a new fee.
    Object.assign(rows(d)[1], { state: "expired", updated_at: new Date(NOON + 1_200_000).toISOString() });
    const again = await step(1.0842, NOON + 1_500_000);
    assert.match(String(again.result), /^back:/);
    assert.deepEqual([rows(d).length, rows(d)[2].fee_key, ch.posts.length], [3, k1, 1]);
    // Read again at exactly a level already used today: that key has been called, and is not called twice in a day.
    Object.assign(rows(d)[2], { state: "invalidated", updated_at: new Date(NOON + 1_800_000).toISOString() });
    assert.equal((await step(1.084, NOON + 1_900_000)).result, "already:invalidated");
    // Let go, and not seen for more than half an hour: then it is a new setup, with its own heads-up and its own key.
    const later = await step(1.0839, NOON + 1_800_000 + RECALL_WINDOW_MS + 60_000);
    assert.equal(later.result, "headsup");
    assert.deepEqual([rows(d).length, rows(d).at(-1)!.fee_key, ch.posts.length], [4, rows(d).at(-1)!.dedupe_key, 2]);
  } finally { ch.close(); }
});

test("a pending setup's 'last checked' is when its confirmation was last READ — a read that could not be made does not move it", async () => {
  // The watch takes from this time whether the candle's momentum question has already been asked.
  const d = db();
  const first = NOON + 8_000;
  await scannerStep(A(d), CTL, E, "quick", forming(), 1.0835, "key", { nowMs: first, confirm: confirms("WAIT") });
  assert.deepEqual([rows(d)[0].state, rows(d)[0].last_checked_at], ["forming", new Date(first).toISOString()]);
  // The next scan cannot read its candles (no data; a busy feed): the row keeps the time of its last real read.
  for (const [i, state] of (["NO_DATA", "BUSY"] as const).entries()) {
    const out = await scannerStep(A(d), CTL, E, "quick", forming(), 1.0835, "key", { nowMs: first + (i + 1) * 300_000, confirm: confirms(state, null) });
    assert.match(String(out.result), /^pending:/);
    assert.equal(rows(d)[0].last_checked_at, new Date(first).toISOString(), state);
  }
  // A read that says "wait" is a read.
  const third = first + 900_000;
  await scannerStep(A(d), CTL, E, "quick", forming(), 1.0835, "key", { nowMs: third, confirm: confirms("AT_ZONE") });
  assert.equal(rows(d)[0].last_checked_at, new Date(third).toISOString());
  // A setup RECORDED while its confirmation could not be read has not been checked at all — the watch's
  // first read of it is the candle's first. (The fourth version stamped it, and momentum was never asked that candle.)
  for (const conf of [confirms("NO_DATA", null), confirms("BUSY", null), (async () => { throw new Error("feed down"); }) as unknown as Confirm]) {
    const d2 = db();
    assert.equal((await scannerStep(A(d2), CTL, E, "quick", forming(), 1.0835, "key", { nowMs: first, confirm: conf })).result, "headsup");
    assert.deepEqual([rows(d2)[0].state, rows(d2)[0].last_checked_at], ["forming", null]);
  }
});

test("what counts as 'the same setup, come back': a scanner setup, this pair, horizon and side, let go in the last half hour", async () => {
  const at = (minAgo: number) => new Date(NOON - minAgo * 60_000).toISOString();
  const gone = (o: Row) => ({ pair: "EURUSD", mode: "quick", side: "sell", entry_low: 1.084, entry_high: 1.0842, state: "invalidated", updated_at: at(10), ...o });
  const ask = (rowsIn: Row[], z = { side: "sell" as const, entry_low: 1.0841, entry_high: 1.0843 }) => findRecall(A(db(rowsIn)), E, "quick", z, NOON);
  assert.equal((await ask([gone({ dedupe_key: "a" })]))?.dedupe_key, "a");
  assert.equal((await ask([gone({ dedupe_key: "a", state: "expired" })]))?.dedupe_key, "a");
  // The newest of several.
  assert.equal((await ask([gone({ dedupe_key: "old", updated_at: at(25) }), gone({ dedupe_key: "new", updated_at: at(5) })]))?.dedupe_key, "new");
  // Not: longer ago than half an hour; still open; another horizon, side or pair; nine pips away; a page setup.
  assert.equal(await ask([gone({ dedupe_key: "a", updated_at: at(31) })]), null);
  assert.equal(await ask([gone({ dedupe_key: "a", state: "forming" })]), null);
  assert.equal(await ask([gone({ dedupe_key: "a", state: "entered" })]), null);
  assert.equal(await ask([gone({ dedupe_key: "a", mode: "intraday" })]), null);
  assert.equal(await ask([gone({ dedupe_key: "a", side: "buy" })]), null);
  assert.equal(await ask([gone({ dedupe_key: "a", pair: "GBPJPY" })]), null);
  assert.equal(await ask([gone({ dedupe_key: "a", entry_low: 1.0849, entry_high: 1.0851 })]), null);
  assert.equal(await ask([gone({ dedupe_key: "zone:EURUSD:quick:sell:108410:20261006" })]), null);
  // A table that cannot be read: treated as new (a heads-up too many, never a call missed).
  assert.equal(await findRecall(A(db([gone({ dedupe_key: "a" })], { fail: (op) => op.kind === "select" })), E, "quick", { side: "sell", entry_low: 1.0841, entry_high: 1.0843 }, NOON), null);
});

test("a setup that confirms the moment it is recorded is entered on that same read — one message, the ENTER, and one placement", async () => {
  const d = db(), ch = channel();
  const placed: FxSignal[] = [];
  const place = (async (sig: FxSignal) => { placed.push(sig); return { pair: sig.pair, ran: true, reason: "ok", eligible: 0, placed: 0, skipped: {} }; }) as never;
  try {
    // Confirmed, with the price in the zone.
    const out = await scannerStep(A(d), CTL, E, "quick", forming(), 1.0841, "key", { nowMs: NOON, confirm: confirms("CONFIRMED", 1.0841), place });
    assert.equal(out.result, "headsup+enter:confirmed_rr_ok");
    assert.deepEqual([rows(d)[0].state, rows(d)[0].enter_price, placed.length, placed[0].signalKey, placed[0].setup], ["entered", 1.0841, 1, rows(d)[0].dedupe_key, "scanner"]);
    assert.equal(ch.posts.length, 1);
    assert.match(ch.posts[0], /GEN FX QUICK — ENTER NOW<\/b>\nEUR\/USD\n/);
    assert.equal(givesPlayAway(ch.posts[0]), false);
    // Confirmed but already far gone (0.4 to 1 left): armed, announced once, nothing placed.
    const d2 = db();
    const armed = await scannerStep(A(d2), CTL, E, "quick", forming(), 1.0823, "key", { nowMs: NOON, confirm: confirms("CONFIRMED", 1.0823), place });
    assert.equal(armed.result, "headsup+arm:chased_below_floor");
    assert.deepEqual([rows(d2)[0].state, rows(d2)[0].enter_sent_at, placed.length, ch.posts.length], ["forming", new Date(NOON).toISOString(), 1, 2]);
    // Already dead when first read: not a call at all.
    const d3 = db();
    assert.equal((await scannerStep(A(d3), CTL, E, "quick", forming(), 1.0835, "key", { nowMs: NOON, confirm: confirms("INVALIDATED"), place })).result, "not_yet:invalidated");
    assert.deepEqual([rows(d3).length, ch.posts.length], [0, 2]);
    // The engine says trade-ready: entered immediately, no heads-up stage.
    const d4 = db();
    const now = await scannerStep(A(d4), CTL, E, "quick", forming(1.084, { engine_state: "TRADE_READY", action: "SELL_NOW" }), 1.0841, "key", { nowMs: NOON, confirm: confirms("WAIT"), place });
    assert.deepEqual([now.result, rows(d4)[0].state, placed.length], ["enter_immediate", "entered", 2]);
    // Nothing actionable: nothing happens.
    assert.deepEqual(await scannerStep(A(db()), CTL, E, "quick", forming(1.084, { engine_state: "NO_TRADE" }), 1.0841, "key", { nowMs: NOON }), { skip: "not_actionable" });
  } finally { ch.close(); }
});

test("an ARMED setup is the watch's: the scan can end it — a candle through it, its five minutes up — and can never enter it", async () => {
  const key = scanKey(E, "quick", "sell", 1.084, 1.0842, NOON);
  const armedRow = (armedAgoMs: number): Row => ({ pair: "EURUSD", mode: "quick", side: "sell", dedupe_key: key, state: "forming", outcome: null, entry: 1.0841, entry_low: 1.084, entry_high: 1.0842, stop: 1.0855, tp1: 1.081, invalidation: 1.0855, watch: 1.0842, enter_sent_at: new Date(NOON - armedAgoMs).toISOString(), created_at: new Date(NOON - 600_000).toISOString() });
  const placed: unknown[] = [];
  const place = (async (x: unknown) => { placed.push(x); }) as never;
  // Its candles say CONFIRMED and the price the confirmation came with is right in the zone — on ONE price.
  // (The second version handed that price to the entry rule here, and entered on it.)
  const d = db([armedRow(120_000)]);
  const out = await scannerStep(A(d), CTL, E, "quick", forming(), 1.0841, "key", { nowMs: NOON, confirm: confirms("CONFIRMED", 1.0841), place });
  assert.deepEqual([out.result, rows(d)[0].state, placed.length], ["armed_waiting", "forming", 0]);
  // A candle closed through its invalidation: ended.
  const d2 = db([armedRow(120_000)]);
  assert.equal((await scannerStep(A(d2), CTL, E, "quick", forming(), 1.0841, "key", { nowMs: NOON, confirm: confirms("INVALIDATED"), place })).result, "invalid:invalidated");
  assert.equal(rows(d2)[0].state, "invalidated");
  // Its five minutes are up: let go — whatever its candles say, and even if they cannot be read.
  for (const confirm of [confirms("CONFIRMED", 1.0841), (async () => { throw new Error("feed down"); }) as unknown as Confirm]) {
    const d3 = db([armedRow(6 * 60_000)]);
    assert.equal((await scannerStep(A(d3), CTL, E, "quick", forming(), 1.0841, "key", { nowMs: NOON, confirm, place })).result, "invalid:arm_expired_5min");
    assert.equal(rows(d3)[0].state, "invalidated");
  }
  assert.equal(placed.length, 0);
  // A setup that is pending and NOT armed is still stepped by the scan as before.
  const d4 = db([{ ...armedRow(0), enter_sent_at: null }]);
  assert.equal((await scannerStep(A(d4), CTL, E, "quick", forming(), 1.0841, "key", { nowMs: NOON, confirm: confirms("CONFIRMED", 1.0841), place })).result, "enter:confirmed_rr_ok");
  assert.equal(placed.length, 1);
});

test("a call on paper runs out of time only when the last candle of its window has closed and been read — and one that can never be graded is closed, not left open", async () => {
  const QUIET = controlOf({ scan_enabled: true });
  const enterMs = Date.UTC(2026, 9, 6, 12, 0, 8);                                  // entered eight seconds into the 12:00 candle
  const deadline = enterMs + GRADE_EXPIRY_MS.quick;                               // 20:00:08 — so the 20:00 candle is the last of its window
  const entered = (o: Row = {}): Row => ({ id: "c1", pair: "EURUSD", mode: "quick", side: "sell", state: "entered", outcome: null, entry: 1.0841, entry_low: 1.084, entry_high: 1.0842, stop: 1.0856, tp1: 1.081, enter_price: 1.0841, enter_sent_at: new Date(enterMs).toISOString(), ...o });
  const stamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");
  /** Flat five-minute candles from 11:55 up to (and including) the one starting at `lastStart`; the 20:00 candle reaches the target. */
  const candles = (lastStart: number) => {
    const out: { datetime: string; high: string; low: string }[] = [];
    for (let t = Date.UTC(2026, 9, 6, 11, 55); t <= lastStart; t += 300_000) out.push({ datetime: stamp(t), high: "1.0845", low: t === Date.UTC(2026, 9, 6, 20, 0) ? "1.0809" : "1.0838" });
    return out.reverse();
  };
  const outcome = (d: ReturnType<typeof fakeDb>) => rows(d)[0].outcome;
  // 20:01:00 — past the deadline, and the 20:00 candle is still forming. (The second version called this "expired".)
  const d = db([entered()]);
  await gradeEntered(A(d), QUIET, { nowMs: deadline + 52_000, candles: async () => candles(Date.UTC(2026, 9, 6, 20, 0)) });
  assert.equal(outcome(d), null);
  // 20:05:04 — it has closed, but the feed is not yet trusted to have it in full: still nothing.
  await gradeEntered(A(d), QUIET, { nowMs: Date.UTC(2026, 9, 6, 20, 5, 4), candles: async () => candles(Date.UTC(2026, 9, 6, 20, 5)) });
  assert.equal(outcome(d), null);
  // 20:05:09 — read: it reached the target inside the call's window. A win, not an expiry.
  assert.equal(await gradeEntered(A(d), QUIET, { nowMs: Date.UTC(2026, 9, 6, 20, 5, 9), candles: async () => candles(Date.UTC(2026, 9, 6, 20, 5)) }), 1);
  assert.deepEqual([outcome(d), rows(d)[0].result_pips], ["win", 31]);
  // The same call where that last candle did nothing: expired — at 20:05:09, not at 20:01.
  const flat = (lastStart: number) => candles(lastStart).map((c) => ({ ...c, low: "1.0838" }));
  const d2 = db([entered()]);
  await gradeEntered(A(d2), QUIET, { nowMs: deadline + 52_000, candles: async () => flat(Date.UTC(2026, 9, 6, 20, 0)) });
  assert.equal(outcome(d2), null);
  await gradeEntered(A(d2), QUIET, { nowMs: Date.UTC(2026, 9, 6, 20, 5, 9), candles: async () => flat(Date.UTC(2026, 9, 6, 20, 5)) });
  assert.equal(outcome(d2), "expired");
  // A target that prints in the candle AFTER the window is not a win, however late the grading runs.
  const d3 = db([entered()]);
  const late = candles(Date.UTC(2026, 9, 6, 20, 10)).map((c) => ({ ...c, low: c.datetime === stamp(Date.UTC(2026, 9, 6, 20, 5)) ? "1.0809" : "1.0838" }));
  await gradeEntered(A(d3), QUIET, { nowMs: Date.UTC(2026, 9, 6, 20, 10, 9), candles: async () => late });
  assert.equal(outcome(d3), "expired");
  // The feed has stopped short of the window's last candle: not expired on what has not been seen.
  const d4 = db([entered()]);
  await gradeEntered(A(d4), QUIET, { nowMs: Date.UTC(2026, 9, 6, 21, 0, 9), candles: async () => flat(Date.UTC(2026, 9, 6, 19, 30)) });
  assert.equal(outcome(d4), null);
  // The candles no longer reach back to the entry and its time is up: nothing more to wait for.
  const d5 = db([entered()]);
  await gradeEntered(A(d5), QUIET, { nowMs: Date.UTC(2026, 9, 6, 21, 0, 9), candles: async () => flat(Date.UTC(2026, 9, 6, 21, 0)).slice(0, 5) });
  assert.equal(outcome(d5), "expired");
  // No target, no stop, or no entry time: it can never be graded — closed at once, so it does not stand in a setup's way for ever.
  for (const bad of [{ tp1: null }, { stop: null }, { enter_sent_at: null }, { enter_sent_at: "not a time" }]) {
    const dx = db([entered(bad)]);
    await gradeEntered(A(dx), QUIET, { nowMs: enterMs + 60_000, candles: async () => flat(Date.UTC(2026, 9, 6, 12, 0)) });
    assert.equal(outcome(dx), "expired", JSON.stringify(bad));
  }
  // Candles that cannot be read: nothing is decided, either way.
  const d6 = db([entered()]);
  await gradeEntered(A(d6), QUIET, { nowMs: Date.UTC(2026, 9, 7, 9, 0), candles: async () => null });
  assert.equal(outcome(d6), null);
});
