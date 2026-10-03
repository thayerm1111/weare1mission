import { test } from "node:test";
import assert from "node:assert/strict";
import { placeGenfx, onePerAccount, type PlaceIo, type FxSignal, type Sent } from "../src/lib/genfx/place";
import { settleFills, type SettleIo } from "../src/lib/genfx/settle";
import { fxTag, type Rows } from "../src/lib/genfx/fills";
import { OWNER_USER_ID, GENFX_VERSION } from "../src/lib/genfx/control";
import { fakeDb, type Row, type FakeOpts, type FakeDb } from "./_genfx_fakedb";
import { order, position, orders, positions } from "./_genfx_broker";

/*
 * Placement, run for real against a database and a broker that can be made to fail at every step.
 * The promise being tested is short: an order leaves only when every "is this account already in a
 * trade?" question has been answered no; whatever happens after it leaves, the account's row says how
 * far it got; and nothing that goes wrong can put a second position on an account the same way.
 *
 * Placement never calls a call finished, and never writes the ledger. It leaves the row "placed" with
 * the order's id, and the books pass — which reads the broker's own record of the order — puts the
 * position in the ledger and closes the call. `books()` below is that pass, run against a broker that
 * shows what the test says it shows; `filledAt()` is a broker showing the order filled.
 */
type Admin = NonNullable<Parameters<typeof placeGenfx>[1]>["admin"];
const asAdmin = (db: FakeDb) => db as unknown as Admin;
const MEMBER = "11111111-2222-3333-4444-555555555555";

const acct = (o: Row = {}): Row => ({
  user_id: MEMBER, account_id: "A1", acc_num: "101", connection_id: "c1", currency: "USD", risk_pct: 1, risk_mode: "aggressive",
  permissions: {}, kill_switch_at: null, style_quick: true, style_hold: true, style_swing: true, genfx_eurusd: true, genfx_gbpjpy: true, ...o,
});
const control = (o: Row = {}): Row => ({ id: 1, scan_enabled: true, auto_enabled: true, auto_scope: "demo", billing_enabled: false, telegram_enabled: false, config: {}, replay_request: null, ...o });
function world(o: { accounts?: Row[]; conns?: Row[]; ctl?: Row; extra?: Record<string, Row[]> } = {}, opts: FakeOpts = {}): FakeDb {
  return fakeDb({
    genfx_control: [o.ctl ?? control()],
    flow_broker_accounts: o.accounts ?? [acct()],
    flow_broker_connections: o.conns ?? [{ id: "c1", environment: "demo", status: "connected" }],
    flow_trade_prefs: [], flow_managed_positions: [], genfx_fills: [], flow_account_reservations: [], flow_auto_events: [],
    ...(o.extra ?? {}),
  }, {
    unique: {
      genfx_fills: [["signal_key", "account_id"], { cols: ["account_id", "pair", "side"], when: (r) => ["reserved", "sending", "placed", "uncertain", "cancelled"].includes(String(r.status)) }],
      flow_managed_positions: [{ cols: ["account_id", "position_id"], when: (r) => r.strategy_version === GENFX_VERSION && r.position_id != null }],
    },
    ...opts,
  });
}

/** The books pass, against a broker showing these lists (default: nothing resting, nothing in the history, no positions). */
function books(db: FakeDb, o: { working?: Rows | null; history?: Rows | null; positions?: Rows | null } = {}) {
  const io: SettleIo = {
    login: async () => ({ token: "t", env: "demo" }),
    working: async () => (o.working === undefined ? orders() : o.working),
    history: async () => (o.history === undefined ? orders() : o.history),
    positions: async () => (o.positions === undefined ? positions() : o.positions),
    instrument: async () => "278", cancel: async () => true, protect: async () => "full",
  };
  for (const f of db.tables.genfx_fills) f.next_check_at = new Date(Date.now() - 1_000).toISOString();
  return settleFills(asAdmin(db) as never, Date.now(), io);
}
/** What the broker shows once an order has filled: its history row, executed and naming the position, and the open position. */
const filledAt = (tag: string, orderId: string, positionId: string, qty: number, avg = 1.08414) => ({
  history: orders(order(orderId, { strategyId: tag, status: "Filled", filledQty: qty, qty, avgPrice: avg, positionId, isOpen: false })),
  positions: positions(position(positionId, { strategyId: tag, qty, avgPrice: avg })),
});

type Order = Parameters<PlaceIo["send"]>[0];
type Desk = { io: PlaceIo; sent: Order[]; calls: string[] };
function desk(o: Partial<PlaceIo> & { reply?: (order: Order, n: number) => Sent | Promise<Sent> } = {}): Desk {
  const sent: Order[] = [], calls: string[] = [];
  const io: PlaceIo = {
    quiet: () => false,
    news: async () => false,
    price: async () => 1.0841,
    bars: async () => Array.from({ length: 60 }, () => ({ h: 1.0842, l: 1.084, c: 1.0841 })),
    usdJpy: async () => 150,
    login: async () => { calls.push("login"); return { token: "t", env: "demo" }; },
    accounts: async () => new Map([["A1", { equity: 10_000, currency: "USD" }], ["A2", { equity: 5_000, currency: "USD" }]]),
    instrument: async () => { calls.push("instrument"); return "278"; },
    listed: async () => true,
    labels: async () => true,
    restingSides: async () => new Set<string>(),
    quote: async () => 1.08412,
    send: async (order) => { sent.push(order); return o.reply ? o.reply(order, sent.length) : { ok: true, orderId: `O${sent.length}`, positionId: `P${sent.length}`, qty: order.qty }; },
    ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== "reply")),
  };
  return { io, sent, calls };
}
const SIG: FxSignal = { pair: "EURUSD", signalKey: "zone:EURUSD:quick:buy:108400:20261005", side: "buy", mode: "quick", entryLow: 1.08397, entryHigh: 1.08403, stop: 1.0825, tp: 1.0872, setup: "zone", alertId: null };
const SELL: FxSignal = { ...SIG, signalKey: "zone:EURUSD:quick:sell:108420:20261005", side: "sell", entryLow: 1.08417, entryHigh: 1.08423, stop: 1.0858, tp: 1.081 };
const run = (db: FakeDb, d: Desk, sig: FxSignal = SIG) => placeGenfx(sig, { admin: asAdmin(db), io: d.io });
const events = (db: FakeDb, status?: string) => db.tables.flow_auto_events.filter((e) => !status || e.status === status);
const reasons = (db: FakeDb) => events(db, "skipped").map((e) => String(e.reason));

test("a call becomes one order on the armed account: sized from the broker's price, capped, remembered before it left", async () => {
  const db = world();
  let seenBeforeSend: Row | null = null;
  const d = desk({ reply: (order) => { seenBeforeSend = { ...db.tables.genfx_fills[0] }; return { ok: true, orderId: "O1", positionId: "P1", qty: order.qty }; } });
  const rep = await run(db, d);
  assert.deepEqual([rep.ran, rep.reason, rep.eligible, rep.placed], [true, "ok", 1, 1]);
  assert.equal(d.sent.length, 1);
  const o = d.sent[0];
  // $10,000 at 1% = $100 over 16.2 pips from THIS broker's ask (1.08412), $10 a pip a lot → 0.61 lots.
  assert.deepEqual([o.pair, o.side, o.qty, o.stop, o.tp], ["EURUSD", "buy", 0.61, 1.0825, 1.0872]);
  assert.equal(o.maxEntry, 1.08452);                              // a quarter of the stop distance past the quote, never the 0.8-to-1 cap
  // The row already said "sending", with the size and the levels, when the order went.
  assert.deepEqual([seenBeforeSend!.status, seenBeforeSend!.qty, seenBeforeSend!.entry, seenBeforeSend!.stop, seenBeforeSend!.tp], ["sending", 0.61, 1.08412, 1.0825, 1.0872]);
  // It carried this call's label, and a deadline: if it has not left within 45 seconds it is not sent.
  assert.equal(o.tag, fxTag(SIG.signalKey, "A1"));
  assert.ok(o.notAfterMs > Date.now() + 30_000 && o.notAfterMs <= Date.now() + 45_000);
  const f = db.tables.genfx_fills[0];
  // Placement records the order and stops there: the row is "placed", due for the books at once, and
  // NOTHING is in the ledger yet — it is the books pass, reading the broker's own record, that puts it there.
  assert.deepEqual([f.status, f.order_id, f.position_id, f.qty, f.account_id, f.pair, f.side, f.tag, f.clean], ["placed", "O1", "P1", 0.61, "A1", "EURUSD", "buy", o.tag, 0]);
  assert.ok(Date.parse(String(f.next_check_at)) <= Date.now());
  assert.equal(db.tables.flow_managed_positions.length, 0);
  assert.deepEqual([db.tables.flow_account_reservations[0].symbol, db.tables.flow_account_reservations[0].state], ["EURUSD:BUY", "active"]);
  // The claim's own time is what the deadline was counted from.
  assert.equal(o.notAfterMs, Date.parse(String(f.created_at)) + 45_000);
  // The broker shows the order filled and its position open: into the ledger at the broker's price, and the call is closed.
  assert.equal((await books(db, filledAt(o.tag, "O1", "P1", 0.61))).managed, 1);
  const row = db.tables.flow_managed_positions[0];
  assert.deepEqual([row.position_id, row.symbol, row.side, row.entry, row.init_stop, row.tp1, row.qty, row.strategy_version, row.signal_id, row.setup_family, row.mode],
    ["P1", "EURUSD", "buy", 1.08414, 1.0825, 1.0872, 0.61, GENFX_VERSION, SIG.signalKey, "zone", "quick"]);
  assert.deepEqual([db.tables.genfx_fills[0].status, db.tables.flow_account_reservations.length, db.tables.flow_managed_positions.length], ["managed", 0, 1]);
  assert.match(String(events(db, "fanout")[0].reason), /^genfx: fanout 1 armed → 1 placed/);
  assert.equal(events(db, "fanout")[0].user_id, OWNER_USER_ID);
});

test("the switches come first: off, unreadable, quiet, out of scope — nothing is asked of any broker", async () => {
  for (const [ctl, why] of [[control({ auto_enabled: false }), "auto_off"], [control({ auto_enabled: "true" }), "auto_off"]] as const) {
    const db = world({ ctl }), d = desk();
    assert.equal((await run(db, d)).reason, why);
    assert.deepEqual([d.sent.length, d.calls.length], [0, 0]);
  }
  const unreadable = world({}, { fail: (op) => op.table === "genfx_control" }), d1 = desk();
  assert.equal((await run(unreadable, d1)).reason, "control_unreadable");
  assert.equal(d1.calls.length, 0);
  const d2 = desk({ quiet: () => true });
  assert.equal((await run(world(), d2)).reason, "quiet_window");
  assert.equal(d2.calls.length, 0);
  // Scope "demo" never reaches a member's LIVE account; the owner's own is always in scope.
  const live = world({ conns: [{ id: "c1", environment: "live", status: "connected" }] }), d3 = desk();
  assert.equal((await run(live, d3)).reason, "no_armed_accounts");
  assert.equal(d3.sent.length, 0);
  const mine = world({ accounts: [acct({ user_id: OWNER_USER_ID })], conns: [{ id: "c1", environment: "live", status: "connected" }], ctl: control({ auto_scope: "owner" }) }), d4 = desk();
  assert.equal((await run(mine, d4)).placed, 1);
  // A pair that is not switched on for the account is not traded on it.
  const off = world({ accounts: [acct({ genfx_eurusd: false })] }), d5 = desk();
  assert.equal((await run(off, d5)).reason, "no_armed_accounts");
  // The list of armed accounts cannot be read: nobody is reached, and it says so.
  const blind = world({}, { fail: (op) => op.table === "flow_broker_accounts" }), d6 = desk();
  assert.equal((await run(blind, d6)).reason, "accounts_unreadable");
  assert.equal(d6.sent.length, 0);
});

test("one order per call per account, and one broker account is one account however it is connected", async () => {
  const db = world(), d = desk();
  await run(db, d);
  const again = await run(db, d);
  assert.deepEqual([d.sent.length, again.placed], [1, 0]);
  assert.equal(db.tables.genfx_fills.length, 1);
  // The same broker account under two connections: one order, on the working connection.
  const two = world({ accounts: [acct({ connection_id: "old", created_at: "2026-01-01T00:00:00Z" }), acct({ connection_id: "c1", created_at: "2026-06-01T00:00:00Z" })], conns: [{ id: "c1", environment: "demo", status: "connected" }, { id: "old", environment: "demo", status: "error" }] });
  const d2 = desk();
  assert.equal((await run(two, d2)).placed, 1);
  assert.deepEqual([d2.sent.length, d2.sent[0].ref.connId], [1, "c1"]);
  const rows = [{ account_id: "A", connection_id: "x", created_at: "2" }, { account_id: "A", connection_id: "y", created_at: "1" }, { account_id: "B", connection_id: "x", created_at: "3" }];
  assert.deepEqual(onePerAccount(rows, () => true).map((r) => `${r.account_id}@${r.connection_id}`), ["A@y", "B@x"]);          // both connected: the older row
  assert.deepEqual(onePerAccount(rows, (c) => c === "x").map((r) => `${r.account_id}@${r.connection_id}`), ["A@x", "B@x"]);    // the connected one wins
});

test("an order that THROWS may have filled: the row is held with its size and levels, and nothing else goes the same way", async () => {
  const db = world();
  const d = desk({ reply: () => { throw new Error("This operation was aborted"); } });
  const rep = await run(db, d);
  assert.deepEqual([rep.placed, rep.skipped.uncertain], [0, 1]);
  const f = db.tables.genfx_fills[0];
  assert.deepEqual([f.status, f.qty, f.entry, f.stop, f.tp, f.order_id], ["uncertain", 0.61, 1.08412, 1.0825, 1.0872, undefined]);
  assert.equal(db.tables.flow_account_reservations[0].state, "unknown");
  const ev = events(db, "uncertain")[0];
  assert.deepEqual([ev.qty, ev.entry, ev.stop, ev.tp, ev.account_id], [0.61, 1.08412, 1.0825, 1.0872, "A1"]);
  assert.match(String(ev.reason), /^genfx: order outcome unknown/);
  // A new BUY call on that account sits out, without a broker call…
  const d2 = desk();
  const next = await run(db, d2, { ...SIG, signalKey: "zone:EURUSD:intraday:buy:108410:20261005", mode: "intraday" });
  assert.deepEqual([next.placed, d2.sent.length, d2.calls.length], [0, 0, 0]);
  assert.match(reasons(db).at(-1)!, /one_open \(an earlier GEN FX EUR\/USD order on this account is still being confirmed\)/);
  // …a SELL is a different side and goes.
  const d3 = desk({ quote: async () => 1.08408 });
  assert.equal((await run(db, d3, SELL)).placed, 1);
  // The books pass then finds the fill at the broker — by the label the order carried — and the account's books are whole.
  const tag = d.sent[0].tag;
  const out = await books(db, {
    history: orders(order("O77", { strategyId: tag, status: "Filled", filledQty: 0.61, qty: 0.61, avgPrice: 1.0842, positionId: "P77" })),
    positions: positions(position("P77", { strategyId: tag, qty: 0.61, avgPrice: 1.0842 }), position("MEMBERS-OWN", { qty: 0.61 })),
  });
  assert.ok(out.managed >= 1);
  assert.deepEqual([db.tables.genfx_fills[0].status, db.tables.genfx_fills[0].position_id], ["managed", "P77"]);
  assert.ok(db.tables.flow_managed_positions.some((r) => r.position_id === "P77" && r.strategy_version === GENFX_VERSION && r.signal_id === SIG.signalKey));
  assert.ok(!db.tables.flow_managed_positions.some((r) => r.position_id === "MEMBERS-OWN"));
});

test("a refusal in the broker's own words leaves nothing behind; a margin refusal is retried at the minimum", async () => {
  const db = world(), d = desk({ reply: () => ({ ok: false, reason: "Market is closed", deferred: true }) });
  const rep = await run(db, d);
  assert.deepEqual([rep.placed, rep.skipped.session_closed, db.tables.genfx_fills.length, db.tables.flow_account_reservations.length], [0, 1, 0, 0]);
  const db2 = world(), d2 = desk({ reply: (order, n) => (n === 1 ? { ok: false, reason: "Not enough margin", deferred: false } : { ok: true, orderId: "O2", positionId: "P2", qty: order.qty }) });
  assert.equal((await run(db2, d2)).placed, 1);
  assert.deepEqual(d2.sent.map((o) => o.qty), [0.61, 0.01]);
  assert.deepEqual([db2.tables.genfx_fills[0].status, db2.tables.genfx_fills[0].qty, db2.tables.genfx_fills[0].order_id], ["placed", 0.01, "O2"]);
  assert.equal(d2.sent[0].tag, d2.sent[1].tag);                    // one call, one label — the refused first order never existed
  assert.equal(d2.sent[0].notAfterMs, d2.sent[1].notAfterMs);      // and ONE deadline: the retry does not get a fresh forty-five seconds
  // The retry itself throwing is an uncertain order of the size that was retried.
  const db3 = world(), d3 = desk({ reply: (_o, n) => { if (n === 1) return { ok: false, reason: "margin", deferred: false }; throw new Error("timeout"); } });
  await run(db3, d3);
  assert.deepEqual([db3.tables.genfx_fills[0].status, db3.tables.genfx_fills[0].qty], ["uncertain", 0.01]);
});

test("the broker has the order but its record cannot be written: the row still says an order went, and the books pass finds it by its label", async () => {
  // Every write to the row after the order has left fails (the database dropped out).
  let sentAlready = false, down = true;
  const db = world({}, { fail: (op) => down && sentAlready && op.table === "genfx_fills" && op.kind === "update" });
  const d = desk({ reply: (order) => { sentAlready = true; return { ok: true, orderId: "O1", positionId: "P1", qty: order.qty }; } });
  assert.equal((await run(db, d)).placed, 1);
  const f = db.tables.genfx_fills[0];
  assert.deepEqual([f.status, f.order_id, f.qty, db.tables.flow_managed_positions.length], ["sending", undefined, 0.61, 0]);     // still "an order is on its way", with its size and levels
  const ev = events(db, "placed")[0];
  assert.deepEqual([ev.qty, ev.entry, ev.stop, ev.tp, ev.order_id], [0.61, 1.08412, 1.0825, 1.0872, "O1"]);
  assert.match(String(ev.reason), /its record is pending/);
  // The database is back. The row never learned its order's id — the books pass finds the order by its label.
  down = false;
  db.tables.genfx_fills[0].created_at = new Date(Date.now() - 130_000).toISOString();
  assert.equal((await books(db, filledAt(d.sent[0].tag, "O1", "P1", 0.61))).managed, 1);
  assert.deepEqual([db.tables.genfx_fills[0].status, db.tables.flow_managed_positions[0].position_id, db.tables.flow_managed_positions[0].strategy_version], ["managed", "P1", GENFX_VERSION]);
  // The position not named yet: placed, with the order id kept on the row and on the lock.
  const db2 = world(), d2 = desk({ reply: (order) => ({ ok: true, orderId: "O9", positionId: null, qty: order.qty }) });
  await run(db2, d2);
  assert.deepEqual([db2.tables.genfx_fills[0].status, db2.tables.genfx_fills[0].order_id, db2.tables.genfx_fills[0].position_id, db2.tables.flow_account_reservations[0].state, db2.tables.flow_account_reservations[0].order_id], ["placed", "O9", null, "active", "O9"]);
  assert.equal(events(db2, "placed").length, 0);                    // nothing went wrong, so nothing extra is said (the order function logs the order itself)
});

test("an order accepted after its record had been closed is said out loud — and taken back up if it can be", async () => {
  // It cannot happen while the send deadline holds; this is the guard for the day something is slower
  // than it can be. The books pass wrote the row off while the order was still on its way…
  const db = world();
  const d = desk({ reply: (order) => { Object.assign(db.tables.genfx_fills[0], { status: "void", note: "no order or position at the broker" }); return { ok: true, orderId: "O1", positionId: null, qty: order.qty }; } });
  assert.equal((await run(db, d)).placed, 1);
  // …nothing else has claimed the account since: the row is taken back up, with the order's id, and followed.
  assert.deepEqual([db.tables.genfx_fills[0].status, db.tables.genfx_fills[0].order_id, events(db, "error").length], ["placed", "O1", 0]);
  // …and ANOTHER call has claimed the same account, pair and side in the meantime: the database refuses
  // the revival, and the order is on the account with nobody following it. That is an alarm, on the
  // member's activity and on the desk's.
  const db2 = world();
  const d2 = desk({ reply: (order) => {
    Object.assign(db2.tables.genfx_fills[0], { status: "void" });
    db2.put("genfx_fills", { signal_key: "a-later-call", account_id: "A1", pair: "EURUSD", side: "buy", status: "placed" });
    return { ok: true, orderId: "O1", positionId: null, qty: order.qty };
  } });
  const rep = await run(db2, d2);
  assert.deepEqual([db2.tables.genfx_fills[0].status, rep.skipped.unfollowed], ["void", 1]);
  const alarms = events(db2, "error").map((e) => [String(e.user_id), String(e.reason)]);
  assert.equal(alarms.length, 2);
  assert.ok(alarms.some(([u, r]) => u === MEMBER && /ORDER O1 WAS ACCEPTED AFTER ITS RECORD HAD BEEN CLOSED.*NOT being followed/.test(r)));
  assert.ok(alarms.some(([u, r]) => u === OWNER_USER_ID && /order O1 on account A1.*NOT being followed/.test(r)));
  // The books pass got to it first and is already following it (found by label, resting): placement leaves that alone.
  const db3 = world();
  const d3 = desk({ reply: (order) => { Object.assign(db3.tables.genfx_fills[0], { status: "placed", order_id: "O1" }); return { ok: true, orderId: "O1", positionId: null, qty: order.qty }; } });
  await run(db3, d3);
  assert.deepEqual([db3.tables.genfx_fills[0].status, events(db3, "error").length, events(db3, "placed").length], ["placed", 0, 0]);
});

test("a send that THREW after its record had been closed is said out loud too — and taken back up if it can be", async () => {
  // The same guard, on the other way out of a send. The books pass wrote the row off while the order was
  // on its way, and then the send threw: it may be on the account. (The third version wrote "uncertain"
  // without looking at what it was writing over — and with the slot taken by another call, said nothing.)
  const db = world();
  const d = desk({ reply: () => { Object.assign(db.tables.genfx_fills[0], { status: "void", note: "no order or position at the broker" }); throw new Error("relay_outcome_unknown"); } });
  const rep = await run(db, d);
  // Nothing else has claimed the account since: the row is taken back up as uncertain, and the books pass asks the broker.
  assert.deepEqual([rep.skipped.uncertain, db.tables.genfx_fills[0].status, events(db, "error").length, events(db, "uncertain").length], [1, "uncertain", 0, 1]);
  // Another call has the slot: the row cannot come back, nothing will look for the order — an alarm, to the member and to the desk.
  const db2 = world();
  const d2 = desk({ reply: () => {
    Object.assign(db2.tables.genfx_fills[0], { status: "void" });
    db2.put("genfx_fills", { signal_key: "a-later-call", account_id: "A1", pair: "EURUSD", side: "buy", status: "placed" });
    throw new Error("relay_outcome_unknown");
  } });
  const rep2 = await run(db2, d2);
  assert.deepEqual([db2.tables.genfx_fills[0].status, rep2.skipped.unfollowed, rep2.skipped.uncertain, events(db2, "uncertain").length], ["void", 1, undefined, 0]);
  const alarms = events(db2, "error").map((e) => [String(e.user_id), String(e.reason)]);
  assert.equal(alarms.length, 2);
  assert.ok(alarms.some(([u, r]) => u === MEMBER && /OUTCOME IS UNKNOWN WAS SENT AFTER ITS RECORD HAD BEEN CLOSED.*NOT being followed/.test(r)));
  assert.ok(alarms.some(([u, r]) => u === OWNER_USER_ID && /account A1.*NOT being followed/.test(r)));
  // The books pass already has it (found by its label, resting): its row is left exactly as the books wrote it.
  const db3 = world();
  const d3 = desk({ reply: () => { Object.assign(db3.tables.genfx_fills[0], { status: "placed", order_id: "O1" }); throw new Error("timeout"); } });
  await run(db3, d3);
  assert.deepEqual([db3.tables.genfx_fills[0].status, db3.tables.genfx_fills[0].order_id, events(db3, "error").length], ["placed", "O1", 0]);
});

test("a send that threw BEFORE any order was attempted leaves nothing behind — it is not 'may have filled'", async () => {
  // The order function marks an error raised before its first order attempt (a quote that timed out).
  const early = () => Object.assign(new Error("quote timed out"), { noOrderSent: true });
  const db = world(), d = desk({ reply: () => { throw early(); } });
  const rep = await run(db, d);
  assert.deepEqual([rep.placed, rep.skipped, db.tables.genfx_fills.length, db.tables.flow_account_reservations.length], [0, { broker_unreadable: 1 }, 0, 0]);
  assert.match(reasons(db).at(-1)!, /broker_unreadable \(quote timed out\)/);
  assert.equal(events(db, "uncertain").length, 0);
  // The account is free for the next call at once (an "uncertain" row would have blocked it for three minutes).
  const d2 = desk();
  assert.equal((await run(db, d2, { ...SIG, signalKey: "zone:EURUSD:intraday:buy:108410:20261005", mode: "intraday" })).placed, 1);
  // After a margin refusal — which left nothing on the account either — the same holds for the retry.
  const db3 = world(), d3 = desk({ reply: (_o, n) => { if (n === 1) return { ok: false, reason: "margin", deferred: false }; throw early(); } });
  await run(db3, d3);
  assert.deepEqual([db3.tables.genfx_fills.length, db3.tables.flow_account_reservations.length], [0, 0]);
  // An error WITHOUT the mark may have left an order behind, whatever it says.
  const db4 = world(), d4 = desk({ reply: () => { throw new Error("quote timed out"); } });
  await run(db4, d4);
  assert.equal(db4.tables.genfx_fills[0].status, "uncertain");
});

test("it fails closed: anything it cannot read or write before the order is a skip, with nothing sent and nothing left held", async () => {
  // (The first read of the ledger is the desk breaker's, for the whole call; the second is this account's open trades.)
  let reads = 0;
  const cases: [string, FakeOpts["fail"], RegExp][] = [
    ["open trades unreadable", (op) => op.table === "flow_managed_positions" && op.kind === "select" && ++reads >= 2, /ledger_unreadable \(couldn't read this account's open trades\)/],
    ["its own orders unreadable", (op) => op.table === "genfx_fills" && op.kind === "select", /ledger_unreadable/],
    ["the lock cannot be taken", (op) => op.kind === "rpc" && op.table === "genx_reserve_gold_side", /ledger_unreadable \(couldn't take this account's lock\)/],
    ["the claim cannot be written", (op) => op.table === "genfx_fills" && op.kind === "insert", /ledger_unreadable \(couldn't record this order/],
    ["the size cannot be written down", (op) => op.table === "genfx_fills" && op.kind === "update", /ledger_unreadable \(couldn't record this order/],
  ];
  for (const [name, fail, re] of cases) {
    // The conservative cool-down reads the ledger too; an aggressive account skips it, so each case fails at the read it names.
    const db = world({}, { fail }), d = desk();
    const rep = await run(db, d);
    assert.deepEqual([rep.placed, d.sent.length], [0, 0], name);
    assert.match(reasons(db).at(-1) ?? "", re, name);
    assert.equal(db.tables.flow_account_reservations.length, 0, `${name}: the lock is handed back`);
    assert.ok(db.tables.genfx_fills.every((f) => f.status === "reserved"), `${name}: nothing claims to have been sent`);
  }
  // A conservative account's recent results cannot be read: that is a skip too.
  let n = 0;
  const cons = world({ accounts: [acct({ risk_mode: "conservative" })] }, { fail: (op) => op.table === "flow_managed_positions" && op.kind === "select" && ++n >= 2 }), dc = desk();
  await run(cons, dc);
  assert.deepEqual([dc.sent.length, dc.calls.length], [0, 0]);
  assert.match(reasons(cons).at(-1)!, /couldn't read this account's recent results/);
  // And if the desk's own loss record cannot be read, the call is refused for everyone: not knowing
  // whether GEN FX is on a losing streak is not permission to add to it.
  const nobook = world({}, { fail: (op) => op.table === "flow_managed_positions" && op.kind === "select" }), dn = desk();
  assert.equal((await run(nobook, dn)).reason, "desk_breaker");
  assert.deepEqual([dn.sent.length, dn.calls.length], [0, 0]);
  assert.match(reasons(nobook).at(-1)!, /the loss record could not be read/);
  // A broker call that throws before the order: skipped as unreadable, the claim and the lock undone.
  const db = world(), d = desk({ accounts: async () => { throw new Error("socket hang up"); } });
  await run(db, d);
  assert.deepEqual([d.sent.length, db.tables.genfx_fills.length, db.tables.flow_account_reservations.length], [0, 0, 0]);
  assert.match(reasons(db).at(-1)!, /no_equity/);
  const db2 = world(), d2 = desk({ instrument: async () => { throw new Error("socket hang up"); } });
  await run(db2, d2);
  assert.deepEqual([d2.sent.length, db2.tables.genfx_fills.length, db2.tables.flow_account_reservations.length], [0, 0, 0]);
  assert.match(reasons(db2).at(-1)!, /broker_unreadable \(socket hang up\)/);
});

test("one trade per pair, per side, per account — by the ledger, by its own unsettled orders, by the broker's resting orders, by the lock", async () => {
  // An open position the same way: an immediate no, with no broker call.
  const open = world({ extra: { flow_managed_positions: [{ account_id: "A1", symbol: "EURUSD", side: "buy", status: "open", position_id: "P0" }] } }), d = desk();
  await run(open, d);
  assert.deepEqual([d.sent.length, d.calls.length], [0, 0]);
  assert.match(reasons(open).at(-1)!, /one_open \(already in a EUR\/USD buy on this account\)/);
  // The other side is a separate trade.
  const d2 = desk({ quote: async () => 1.08408 });
  assert.equal((await run(open, d2, SELL)).placed, 1);
  // A position whose side cannot be read blocks both.
  const blind = world({ extra: { flow_managed_positions: [{ account_id: "A1", symbol: "EURUSD", side: null, status: "open" }] } }), d3 = desk();
  await run(blind, d3);
  assert.equal(d3.sent.length, 0);
  // Gold open on the account does not block a currency trade; a closed EUR/USD trade does not either.
  const gold = world({ extra: { flow_managed_positions: [{ account_id: "A1", symbol: "XAUUSD", side: "buy", status: "open" }, { account_id: "A1", symbol: "EURUSD", side: "buy", status: "closed", outcome: "target", resolved_at: new Date().toISOString() }] } }), d4 = desk();
  assert.equal((await run(gold, d4)).placed, 1);
  // A resting order the same way, or orders that cannot be read.
  const d5 = desk({ restingSides: async () => new Set(["buy"]) }), w5 = world();
  await run(w5, d5);
  assert.equal(d5.sent.length, 0);
  assert.match(reasons(w5).at(-1)!, /one_open \(resting EUR\/USD order\)/);
  const d6 = desk({ restingSides: async () => null }), w6 = world();
  await run(w6, d6);
  assert.equal(d6.sent.length, 0);
  assert.match(reasons(w6).at(-1)!, /broker_unreadable \(couldn't read your orders\)/);
  // A lock somebody else holds.
  const held = world({ extra: { flow_account_reservations: [] } });
  await held.rpc("genx_reserve_gold_side", { p_account_id: "A1", p_symbol: "EURUSD", p_side: "BUY", p_signal_key: "another-call", p_ttl_secs: 60 });
  const d7 = desk();
  await run(held, d7);
  assert.equal(d7.sent.length, 0);
  assert.match(reasons(held).at(-1)!, /one_open \(another GEN FX EUR\/USD buy on this account is being placed or confirmed\)/);
  assert.equal(held.tables.flow_account_reservations[0].signal_key, "another-call");          // and it keeps its lock
});

test("an account it cannot size is left out: no equity, not in dollars, a pair the broker does not list", async () => {
  for (const [accounts, re] of [
    [new Map([["A1", { equity: null, currency: "USD" }]]), /no_equity/],
    [new Map([["A1", { equity: 10_000, currency: "EUR" }]]), /non_usd_account \(GEN FX sizes in dollars; this account is in EUR\)/],
    [new Map(), /no_equity/],
  ] as const) {
    const db = world(), d = desk({ accounts: async () => accounts as never });
    await run(db, d);
    assert.equal(d.sent.length, 0);
    assert.match(reasons(db).at(-1)!, re);
    assert.deepEqual([db.tables.genfx_fills.length, db.tables.flow_account_reservations.length], [0, 0]);
  }
  // A currency nobody can tell: not assumed to be dollars.
  const db = world({ accounts: [acct({ currency: null })] }), d = desk({ accounts: async () => new Map([["A1", { equity: 10_000, currency: null }]]) });
  await run(db, d);
  assert.equal(d.sent.length, 0);
  assert.match(reasons(db).at(-1)!, /couldn't read this account's currency/);
  const db2 = world(), d2 = desk({ instrument: async () => null });
  await run(db2, d2);
  assert.match(reasons(db2).at(-1)!, /instrument_not_found/);
  const db3 = world(), d3 = desk({ instrument: async () => null, listed: async () => false });
  await run(db3, d3);
  assert.match(reasons(db3).at(-1)!, /broker_unreadable \(couldn't load the broker's instruments/);
  // No broker number, a kill switch, no login.
  const db4 = world({ accounts: [acct({ acc_num: null }), acct({ account_id: "A2", kill_switch_at: new Date().toISOString() })] }), d4 = desk();
  await run(db4, d4);
  assert.equal(d4.sent.length, 0);
  const db5 = world(), d5 = desk({ login: async () => null });
  await run(db5, d5);
  assert.match(reasons(db5).at(-1)!, /no_broker_token/);
});

test("this broker's own price decides for this account: through the stop, too tight, chased — and the claim is undone", async () => {
  for (const [quote, re] of [[1.0824, /through_stop/], [1.0833, /stop_too_tight \(the stop is 8 pips/], [1.0853, /chased/]] as const) {
    const db = world(), d = desk({ quote: async () => quote });
    await run(db, d);
    assert.equal(d.sent.length, 0, String(quote));
    assert.match(reasons(db).at(-1)!, re);
    assert.deepEqual([db.tables.genfx_fills.length, db.tables.flow_account_reservations.length], [0, 0]);
  }
  // No broker quote: the feed's price, moved AWAY from the stop by the pair's cost, so the size can only come out smaller.
  const db = world(), d = desk({ quote: async () => null });
  await run(db, d);
  assert.equal(db.tables.genfx_fills[0].entry, 1.0842);
  assert.equal(d.sent[0].qty, 0.58);                             // $100 over 17 pips
  const thrown = world(), d2 = desk({ quote: async () => { throw new Error("timeout"); } });
  await run(thrown, d2);
  assert.equal(d2.sent[0].qty, 0.58);
  // A small account that the minimum lot is too big for sits out, and is told why in words.
  const tiny = world(), d3 = desk({ accounts: async () => new Map([["A1", { equity: 30, currency: "USD" }]]) });
  await run(tiny, d3);
  assert.equal(d3.sent.length, 0);
  assert.match(reasons(tiny).at(-1)!, /min_lot_over_leverage \(the smallest EUR\/USD order is worth more than 20 times this account\)/);
  // A wide stop on a small account: the minimum lot would lose more than 5% of it.
  const wide = world(), d4 = desk({ accounts: async () => new Map([["A1", { equity: 150, currency: "USD" }]]), price: async () => 1.0841, quote: async () => 1.0841 });
  await run(wide, d4, { ...SIG, signalKey: "zone:EURUSD:swing:buy:108400:20261005", mode: "swing", stop: 1.0761, tp: 1.1001 });
  assert.equal(d4.sent.length, 0);
  assert.match(reasons(wide).at(-1)!, /min_lot_over_risk \(the smallest EUR\/USD order would risk \$8 on this stop — over 5% of this account\)/);
});

test("the whole call is judged once before anyone is reached: GBP/JPY needs its yen rate, and every account's outcome is counted", async () => {
  const J: FxSignal = { pair: "GBPJPY", signalKey: "zone:GBPJPY:intraday:buy:80560:20261005", side: "buy", mode: "intraday", entryLow: 201.3925, entryHigh: 201.4075, stop: 201.0, tp: 202.2, setup: "zone" };
  const jio: Partial<PlaceIo> = { price: async () => 201.41, bars: async () => Array.from({ length: 60 }, () => ({ h: 201.43, l: 201.39, c: 201.41 })), quote: async () => 201.42 };
  const db = world(), d = desk({ ...jio, usdJpy: async () => null });
  assert.equal((await run(db, d, J)).reason, "no_usdjpy_rate");
  assert.deepEqual([d.sent.length, d.calls.length], [0, 0]);
  const db2 = world(), d2 = desk(jio);
  assert.equal((await run(db2, d2, J)).placed, 1);
  // ¥100,000 a lot per 1.00 at 150 yen to the dollar is $666.67; 42 pips of stop is $280 a lot; $100 of risk is 0.35 lots.
  assert.equal(d2.sent[0].qty, 0.35);
  assert.equal(db2.tables.flow_account_reservations[0].symbol, "GBPJPY:BUY");
  // The call fails a desk-wide guard: nobody is reached and the reason is left under the owner's id.
  const db3 = world(), d3 = desk({ price: async () => 1.0824 });
  assert.equal((await run(db3, d3)).reason, "through_stop");
  assert.deepEqual([d3.calls.length, String(events(db3, "skipped")[0].user_id)], [0, OWNER_USER_ID]);
  // Two accounts, one fine and one not in dollars: one order, and the breadcrumb counts both.
  const db4 = world({ accounts: [acct(), acct({ account_id: "A2", acc_num: "102" })] });
  const d4 = desk({ accounts: async () => new Map([["A1", { equity: 10_000, currency: "USD" }], ["A2", { equity: 10_000, currency: "GBP" }]]) });
  const rep = await run(db4, d4);
  assert.deepEqual([rep.eligible, rep.placed, rep.skipped], [2, 1, { non_usd_account: 1 }]);
  assert.match(String(events(db4, "fanout")[0].reason), /fanout 2 armed → 1 placed \(non_usd_account 1\)/);
});

test("a broker that does not give an order's label back is not traded on — and one whose settings cannot be read is not guessed at", async () => {
  const db = world(), d = desk({ labels: async () => false });
  const rep = await run(db, d);
  assert.deepEqual([rep.placed, d.sent.length, rep.skipped.no_order_labels], [0, 0, 1]);
  assert.match(reasons(db).at(-1)!, /no_order_labels \(this broker does not return an order's label/);
  assert.deepEqual([db.tables.genfx_fills.length, db.tables.flow_account_reservations.length], [0, 0]);
  const db2 = world(), d2 = desk({ labels: async () => null });
  await run(db2, d2);
  assert.equal(d2.sent.length, 0);
  assert.match(reasons(db2).at(-1)!, /broker_unreadable \(couldn't read this broker's settings\)/);
});

test("'off' means off for the accounts a fan-out has not reached yet: the switches are read again before each order", async () => {
  const two = () => world({ accounts: [acct(), acct({ account_id: "A2", acc_num: "102" })] });       // one login, so one after the other
  const wait = () => new Promise((r) => setTimeout(r, 300));
  // The owner switches auto-trade off while the first order is going out.
  const db = two();
  const d = desk({ reply: async (order) => { db.tables.genfx_control[0].auto_enabled = false; await wait(); return { ok: true, orderId: "O1", positionId: "P1", qty: order.qty }; } });
  const rep = await run(db, d);
  assert.deepEqual([d.sent.length, rep.placed, rep.skipped.switched_off], [1, 1, 1]);
  assert.match(reasons(db).at(-1)!, /switched_off \(GEN FX auto-trade was switched off\)/);
  assert.equal(db.tables.genfx_fills.length, 1);                   // the second account's claim was handed back
  // A member switches the pair off on their second account, or hits its kill switch.
  for (const [patch, re] of [[{ genfx_eurusd: false }, /EUR\/USD was switched off on this account/], [{ kill_switch_at: new Date().toISOString() }, /kill switch is on/]] as const) {
    const w = two();
    const dd = desk({ reply: async (order) => { Object.assign(w.tables.flow_broker_accounts[1], patch); return { ok: true, orderId: "O1", positionId: "P1", qty: order.qty }; } });
    await run(w, dd);
    assert.deepEqual([dd.sent.length, dd.sent[0].ref.accountId], [1, "A1"]);
    assert.match(reasons(w).at(-1)!, re);
  }
  // The same broker account is connected twice, and its kill switch is hit through the OTHER connection's row.
  const twice = world({ accounts: [acct(), acct({ connection_id: "c9", created_at: "2030-01-01T00:00:00Z", genfx_eurusd: false, kill_switch_at: new Date().toISOString() })], conns: [{ id: "c1", environment: "demo", status: "connected" }, { id: "c9", environment: "demo", status: "connected" }] });
  const dk = desk();
  await run(twice, dk);
  assert.equal(dk.sent.length, 0);
  assert.match(reasons(twice).at(-1)!, /switched_off \(this account's kill switch is on\)/);
  assert.deepEqual([twice.tables.genfx_fills.length, twice.tables.flow_account_reservations.length], [0, 0]);
  // The scope narrows to the owner mid-way: a member's account is no longer in it.
  const w2 = two();
  const d2 = desk({ reply: async (order) => { w2.tables.genfx_control[0].auto_scope = "owner"; await wait(); return { ok: true, orderId: "O1", positionId: "P1", qty: order.qty }; } });
  await run(w2, d2);
  assert.equal(d2.sent.length, 1);
  assert.match(reasons(w2).at(-1)!, /no longer in scope/);
});

test("accounts under one login go one after another; separate logins go together", async () => {
  const db = world({
    accounts: [acct(), acct({ account_id: "A2", acc_num: "102" }), acct({ account_id: "B1", acc_num: "201", connection_id: "c2" })],
    conns: [{ id: "c1", environment: "demo", status: "connected" }, { id: "c2", environment: "demo", status: "connected" }],
  });
  const inFlight = new Map<string, number>();
  let worstSameLogin = 0, sawTogether = false;
  const d = desk({
    accounts: async () => new Map([["A1", { equity: 10_000, currency: "USD" }], ["A2", { equity: 10_000, currency: "USD" }], ["B1", { equity: 10_000, currency: "USD" }]]),
    reply: async (order) => {
      const c = order.ref.connId;
      inFlight.set(c, (inFlight.get(c) ?? 0) + 1);
      worstSameLogin = Math.max(worstSameLogin, inFlight.get(c)!);
      if ([...inFlight.values()].filter((n) => n > 0).length > 1) sawTogether = true;
      await new Promise((r) => setTimeout(r, 40));
      inFlight.set(c, inFlight.get(c)! - 1);
      return { ok: true, orderId: `O-${order.ref.accountId}`, positionId: `P-${order.ref.accountId}`, qty: order.qty };
    },
  });
  const rep = await run(db, d);
  assert.deepEqual([rep.placed, worstSameLogin, sawTogether], [3, 1, true]);
  // Two CONNECTIONS that sign in with the same broker login are one login: their accounts go one after another too.
  const same = world({
    accounts: [acct(), acct({ account_id: "B1", acc_num: "201", connection_id: "c2" })],
    conns: [{ id: "c1", environment: "demo", status: "connected", server: "BRK-Demo", email: "Member@Example.com" }, { id: "c2", environment: "demo", status: "connected", server: "BRK-Demo", email: "member@example.com " }],
  });
  let flying = 0, worst = 0;
  const ds = desk({
    accounts: async () => new Map([["A1", { equity: 10_000, currency: "USD" }], ["B1", { equity: 10_000, currency: "USD" }]]),
    reply: async (order) => { worst = Math.max(worst, ++flying); await new Promise((r) => setTimeout(r, 40)); flying--; return { ok: true, orderId: `O-${order.ref.accountId}`, positionId: null, qty: order.qty }; },
  });
  assert.deepEqual([(await run(same, ds)).placed, worst], [2, 1]);
});

test("a broker whose own instrument list says a lot is not 100,000 units is not traded on: the size would be wrong by that factor", async () => {
  const db = world(), d = desk({ contract: async () => 1_000 });
  const rep = await run(db, d);
  assert.deepEqual([rep.placed, d.sent.length, rep.skipped.contract_size], [0, 0, 1]);
  assert.match(reasons(db).at(-1)!, /contract_size \(this broker's EUR\/USD lot is 1000 units; GEN FX sizes for 100000\)/);
  assert.deepEqual([db.tables.genfx_fills.length, db.tables.flow_account_reservations.length], [0, 0]);
  // It says 100,000, or it does not say: traded as before.
  for (const contract of [async () => 100_000, async () => null, async () => { throw new Error("x"); }]) assert.equal((await run(world(), desk({ contract }))).placed, 1);
});

test("another call's order appears on the account between the check and the claim: the database refuses the second", async () => {
  // Staged just ahead of this call's claim: a different call's unsettled row for the same account, pair and side.
  let staged = false;
  const db = world({}, { before: (op, w) => { if (!staged && op.table === "genfx_fills" && op.kind === "insert") { staged = true; w.put("genfx_fills", { signal_key: "another-call", account_id: "A1", pair: "EURUSD", side: "buy", status: "sending" }); } } });
  const d = desk();
  const rep = await run(db, d);
  assert.deepEqual([rep.placed, d.sent.length, rep.skipped.one_open], [0, 0, 1]);
  assert.match(reasons(db).at(-1)!, /one_open \(an earlier GEN FX EUR\/USD order on this account is still being confirmed\)/);
  assert.deepEqual([db.tables.genfx_fills.map((f) => f.signal_key), db.tables.flow_account_reservations.length], [["another-call"], 0]);
  // This very call already on the account (another pass got there first): nothing to say, nothing sent.
  let once = false;
  const db2 = world({}, { before: (op, w) => { if (!once && op.table === "genfx_fills" && op.kind === "insert") { once = true; w.put("genfx_fills", { signal_key: SIG.signalKey, account_id: "A1", pair: "EURUSD", side: "buy", status: "sending" }); } } });
  const d2 = desk();
  const rep2 = await run(db2, d2);
  assert.deepEqual([rep2.placed, d2.sent.length, rep2.skipped], [0, 0, {}]);
});

test("an order that could not leave in time is not sent late: the claim is handed back", async () => {
  const db = world(), d = desk({ reply: () => ({ ok: false, reason: "entry_deadline_passed", deferred: false }) });
  const rep = await run(db, d);
  assert.deepEqual([rep.placed, rep.skipped.too_late, db.tables.genfx_fills.length, db.tables.flow_account_reservations.length], [0, 1, 0, 0]);
});
