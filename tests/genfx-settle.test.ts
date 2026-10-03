import { test } from "node:test";
import assert from "node:assert/strict";
import { settleFills, notThisOrders, type SettleIo, type Protected } from "../src/lib/genfx/settle";
import { ensureLedgerRow, ledgerOwner } from "../src/lib/genfx/ledger";
import { fxTag, readPositions, type Rows } from "../src/lib/genfx/fills";
import { GENFX_VERSION } from "../src/lib/genfx/control";
import { fakeDb, type Row, type FakeOpts, type FakeDb } from "./_genfx_fakedb";
import { order, position, orders, positions, unnamed } from "./_genfx_broker";

/*
 * Every GEN FX order ends as a position the trade manager runs, or as nothing. These tests run the
 * pass that gets it there against a database and a broker that can be made to say anything — the
 * order that timed out and filled anyway, the cancel that "succeeded" on an order that had filled,
 * the member's own trade of exactly the same size sitting beside it — and hold it to two rules:
 *
 *   • only its label or its order id makes anything GEN FX's;
 *   • an account is never freed, and a fill never written off, on a guess — and a list that could
 *     not be read is a guess.
 */
const KEY = "EURUSD:quick:buy:10840:10842:20261005";
const TAG = fxTag(KEY, "A1");
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
type Admin = Parameters<typeof settleFills>[0];
const asAdmin = (db: FakeDb) => db as unknown as Admin;
const UNSETTLED = ["reserved", "sending", "placed", "uncertain", "cancelled"];
const DB_OPTS: FakeOpts = {
  unique: {
    genfx_fills: [["signal_key", "account_id"], { cols: ["account_id", "pair", "side"], when: (r) => UNSETTLED.includes(String(r.status)) }],
    flow_managed_positions: [{ cols: ["account_id", "position_id"], when: (r) => r.strategy_version === GENFX_VERSION && r.position_id != null }],
  },
};

/** An unsettled row, due now. Default: a send that threw 200 seconds ago, size and levels written. */
const fill = (o: Row = {}): Row => ({
  signal_key: KEY, account_id: "A1", user_id: "u1", connection_id: "c1", acc_num: "101", environment: "demo",
  pair: "EURUSD", side: "buy", mode: "quick", setup: "scanner", qty: 0.5, entry: 1.0841, stop: 1.0825, tp: 1.087,
  order_id: null, position_id: null, status: "uncertain", checks: 0, clean: 0, protect_tries: 0, tag: TAG, note: null, cancelled_at: null,
  created_at: ago(200_000), updated_at: ago(200_000), next_check_at: ago(1_000), ...o,
});
const lock = (o: Row = {}): Row => ({ account_id: "A1", symbol: "EURUSD:BUY", state: "unknown", signal_key: KEY, order_id: null, position_id: null, ...o });
const mine = (id: string, o: Record<string, unknown> = {}) => order(id, { strategyId: TAG, ...o });
const myPos = (id: string, o: Record<string, unknown> = {}) => position(id, { strategyId: TAG, ...o });

type Broker = {
  positions: Rows | null; working: Rows | null; history: Rows | null; instrument: string | null;
  login: (connId: string) => boolean; cancelOk: boolean; protectOk: boolean; /** What the broker takes when asked to protect a position; overrides protectOk. */ protect?: Protected;
  cancelled: string[]; protected: [string, number, number | null][]; reads: string[];
};
function broker(o: Partial<Broker> = {}): { io: SettleIo; b: Broker } {
  const b: Broker = { positions: positions(), working: orders(), history: orders(), instrument: "278", login: () => true, cancelOk: true, protectOk: true, cancelled: [], protected: [], reads: [], ...o };
  const io: SettleIo = {
    login: async (connId) => (b.login(connId) ? { token: "t", env: "demo" } : null),
    history: async () => { b.reads.push("history"); return b.history; },
    working: async () => { b.reads.push("working"); return b.working; },
    positions: async () => { b.reads.push("positions"); return b.positions; },
    instrument: async () => b.instrument,
    cancel: async (_c, id) => { b.cancelled.push(id); return b.cancelOk; },
    protect: async (_c, id, stop, tp) => { b.protected.push([id, stop, tp]); return b.protect ?? (b.protectOk ? "full" : "none"); },
  };
  return { io, b };
}
const setup = (fills: Row[], extra: Record<string, Row[]> = {}, opts: FakeOpts = {}) => fakeDb({ genfx_fills: fills, flow_managed_positions: [], flow_account_reservations: [], flow_auto_events: [], flow_broker_accounts: [], ...extra }, { ...DB_OPTS, ...opts });
const theFill = (db: FakeDb, i = 0) => db.tables.genfx_fills[i];
const ledger = (db: FakeDb) => db.tables.flow_managed_positions;
/** Run a pass as if `ms` later, with every row due again. */
const pass = (db: FakeDb, io: SettleIo, laterMs = 0) => { for (const f of db.tables.genfx_fills) f.next_check_at = ago(1_000); return settleFills(asAdmin(db), NOW + laterMs, io); };

test("a row that is not due is not looked at, and a claim is first due two minutes after it was made", async () => {
  const db = setup([fill({ status: "reserved", created_at: ago(30_000), next_check_at: new Date(NOW + 90_000).toISOString() }), fill({ signal_key: "k2", side: "sell", status: "sending", created_at: ago(90_000), next_check_at: new Date(NOW + 30_000).toISOString() })]);
  const { io, b } = broker({ positions: positions(myPos("P1")) });
  const out = await settleFills(asAdmin(db), NOW, io);
  assert.deepEqual([out.checked, out.managed, out.voided], [0, 0, 0]);
  assert.deepEqual(db.tables.genfx_fills.map((f) => f.status), ["reserved", "sending"]);
  assert.deepEqual([ledger(db).length, b.reads.length, b.cancelled.length], [0, 0, 0]);
});

test("claimed and never sent: written off, and only its own lock is released", async () => {
  const db = setup([fill({ status: "reserved", qty: null, entry: null, stop: null, tp: null, created_at: ago(130_000) })], { flow_account_reservations: [lock({ state: "active" })] });
  const { io, b } = broker();
  const out = await settleFills(asAdmin(db), NOW, io);
  assert.equal(out.voided, 1);
  assert.equal(theFill(db).status, "void");
  assert.match(String(theFill(db).note), /never sent/);
  assert.equal(db.tables.flow_account_reservations.length, 0);
  assert.equal(b.reads.length, 0);                                   // nothing left this desk: the broker is not asked
  // Had another call taken the lock in the meantime, it keeps it.
  const db2 = setup([fill({ status: "reserved", created_at: ago(130_000) })], { flow_account_reservations: [lock({ state: "active", signal_key: "someone-else" })] });
  await settleFills(asAdmin(db2), NOW, broker().io);
  assert.equal(theFill(db2).status, "void");
  assert.equal(db2.tables.flow_account_reservations.length, 1);
  // Placement wrote "sending" in the meantime: the claim is not written off under it.
  const db3 = setup([fill({ status: "reserved", created_at: ago(130_000) })], {}, { before: (op, d) => { if (op.table === "genfx_fills" && op.kind === "update") d.tables.genfx_fills[0].status = "sending"; } });
  const out3 = await settleFills(asAdmin(db3), NOW, broker().io);
  assert.deepEqual([out3.voided, theFill(db3).status], [0, "sending"]);
});

test("an order that threw and FILLED is found by its label, its stop put on again, and given its ledger row at the broker's size and price", async () => {
  const db = setup([fill()], { flow_account_reservations: [lock()] });
  const { io, b } = broker({
    history: orders(mine("77", { status: "Filled", filledQty: 0.5, avgPrice: 1.08415, positionId: 555, isOpen: false })),
    positions: positions(myPos("555", { qty: 0.5, avgPrice: 1.08415 }), position("X", { tradableInstrumentId: 1 }), position("Y", { side: "sell" })),
  });
  const out = await settleFills(asAdmin(db), NOW, io);
  assert.equal(out.managed, 1);
  assert.equal(ledger(db).length, 1);
  const row = ledger(db)[0];
  assert.deepEqual([row.position_id, row.symbol, row.side, row.entry, row.init_stop, row.tp1, row.qty, row.strategy_version, row.signal_id], ["555", "EURUSD", "buy", 1.08415, 1.0825, 1.087, 0.5, GENFX_VERSION, KEY]);
  assert.deepEqual(b.protected, [["555", 1.0825, 1.087]]);            // the stop and target, before the manager is given it
  assert.deepEqual([theFill(db).status, theFill(db).position_id], ["managed", "555"]);
  assert.equal(db.tables.flow_account_reservations.length, 0);        // the open ledger row is the guard now
  assert.deepEqual(b.cancelled, []);
});

test("THE MEMBER'S OWN TRADE of the same pair, side and size is never taken for GEN FX's fill", async () => {
  // The send threw and nothing reached the broker. The member is in their own EUR/USD buy of exactly
  // this size, opened earlier. (The first version adopted it and let the trade manager move its stop.)
  const db = setup([fill()], { flow_account_reservations: [lock()] });
  const { io, b } = broker({ positions: positions(position("MANUAL", { qty: 0.5, openDate: NOW - 3_600_000 })), working: orders(order("M-LIMIT", { qty: 0.5, createdDate: NOW - 3_600_000 })) });
  const first = await pass(db, io);
  assert.deepEqual([first.managed, first.voided, theFill(db).status, theFill(db).clean], [0, 0, "uncertain", 1]);
  const second = await pass(db, io, 15_000);
  assert.deepEqual([second.voided, theFill(db).status], [1, "void"]);
  assert.match(String(theFill(db).note), /no order or position at the broker/);
  assert.deepEqual([ledger(db).length, b.cancelled, b.protected], [0, [], []]);      // their position and their resting order: untouched
  assert.equal(db.tables.flow_account_reservations.length, 0);
});

test("an unlabelled position opened SINCE the order holds the account — it is not adopted and the row is not written off", async () => {
  const db = setup([fill()]);
  const { io, b } = broker({ positions: positions(position("MAYBE", { qty: 0.5, openDate: NOW - 150_000 })) });
  for (let i = 0; i < 4; i++) await pass(db, io, i * 20_000);
  assert.deepEqual([theFill(db).status, ledger(db).length, b.protected.length], ["uncertain", 0, 0]);
  assert.match(String(theFill(db).note), /unlabelled position/);
  // The history then names it as this order's: adopted. (A broker that did not put the label on the position.)
  b.history = orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: "MAYBE" }));
  assert.equal((await pass(db, io, 100_000)).managed, 1);
  assert.equal(ledger(db)[0].position_id, "MAYBE");
  // Somebody else's labelled position is theirs, and holds nothing.
  const db2 = setup([fill()]);
  const other = broker({ positions: positions(position("AURIC", { openDate: NOW - 150_000, strategyId: "AURIC:9" })) });
  await pass(db2, other.io);
  assert.equal((await pass(db2, other.io, 15_000)).voided, 1);
});

test("a list that could not be PARSED is unreadable, not empty: the resting order stays, and so does the row", async () => {
  // The send timed out, the order was accepted and is resting. The column names could not be read
  // (/trade/config failed), so every row is a bare array. (The first version read "no status" in each,
  // found nothing, and freed the account with the order still there.)
  const db = setup([fill()], { flow_account_reservations: [lock()] });
  const { io, b } = broker({ working: unnamed(orders(mine("77"))), history: unnamed(orders()), positions: unnamed(positions()) });
  for (let i = 0; i < 5; i++) { const out = await pass(db, io, i * 60_000); assert.deepEqual([out.voided, out.held], [0, 1]); }
  assert.deepEqual([theFill(db).status, db.tables.flow_account_reservations.length], ["uncertain", 1]);
  assert.match(String(theFill(db).note), /orders could not be read/);
  // The same for each list on its own.
  for (const blind of [{ working: null }, { positions: null }, { positions: unnamed(positions(position("P"))) }, { instrument: null }] as Partial<Broker>[]) {
    const d = setup([fill()]);
    const x = broker(blind);
    for (let i = 0; i < 4; i++) await pass(d, x.io, i * 60_000);
    assert.notEqual(theFill(d).status, "void", JSON.stringify(Object.keys(blind)));
  }
  // Names back: the order is found, taken over, and (past its validity) withdrawn.
  b.working = orders(mine("77")); b.history = orders(); b.positions = positions();
  const out = await pass(db, io, 400_000);
  assert.deepEqual([out.cancelled, b.cancelled, theFill(db).status, theFill(db).order_id], [1, ["77"], "cancelled", "77"]);
});

test("an unanswered send that is RESTING is taken over by its label — and nobody else's order is touched", async () => {
  const db = setup([fill({ created_at: ago(60_000) })]);
  const { io, b } = broker({ working: orders(order("M-LIMIT", { qty: 0.5 }), mine("77")) });
  const out = await pass(db, io);
  assert.deepEqual([out.waiting, theFill(db).status, theFill(db).order_id, b.cancelled], [1, "placed", "77", []]);     // inside its validity: left to rest
  // Past its validity it is withdrawn — ours, by id.
  const later = await pass(db, io, 150_000);
  assert.deepEqual([later.cancelled, b.cancelled, theFill(db).status], [1, ["77"], "cancelled"]);
  assert.ok(theFill(db).cancelled_at);
  // The broker's history then says it was cancelled unfilled. That is the broker's word — taken half a
  // minute after the cancel, not before: a fill that crossed the cancel is still being written up.
  b.working = orders(order("M-LIMIT", { qty: 0.5 }));
  b.history = orders(mine("77", { status: "Cancelled", isOpen: false }));
  const soon = await pass(db, io, 165_000);
  assert.deepEqual([soon.voided, soon.waiting, theFill(db).status], [0, 1, "cancelled"]);
  const end = await pass(db, io, 185_000);
  assert.deepEqual([end.voided, theFill(db).status], [1, "void"]);
  assert.match(String(theFill(db).note), /cancelled or refused/);
  assert.deepEqual(b.cancelled, ["77"]);
});

test("a cancel that 'succeeded' on an order that had just FILLED: the history says so, and the fill is adopted", async () => {
  const db = setup([fill({ status: "placed", order_id: "77", created_at: ago(200_000) })]);
  const { io, b } = broker({ working: orders(mine("77")) });
  assert.equal((await pass(db, io)).cancelled, 1);
  b.working = orders();
  b.history = orders(mine("77", { status: "Filled", filledQty: 0.5, avgPrice: 1.0845, positionId: 555 }));
  b.positions = positions(myPos("555", { avgPrice: 1.0845 }));
  const out = await pass(db, io, 12_000);
  assert.deepEqual([out.managed, theFill(db).status, ledger(db)[0].position_id, ledger(db)[0].entry], [1, "managed", "555", 1.0845]);
});

test("a withdrawn order with no word from the broker is written off only after two full looks, half a minute on", async () => {
  const cancelledAt = ago(5_000);
  const db = setup([fill({ status: "cancelled", order_id: "77", cancelled_at: cancelledAt })]);
  const { io, b } = broker();
  // Look 1: clean, but too soon and only one look.
  assert.deepEqual([(await pass(db, io)).voided, theFill(db).clean], [0, 1]);
  // A look at which the positions could not be read does not count.
  b.positions = null;
  assert.deepEqual([(await pass(db, io, 40_000)).voided, theFill(db).clean], [0, 1]);
  b.positions = positions();
  const out = await pass(db, io, 60_000);
  assert.deepEqual([out.voided, theFill(db).status], [1, "void"]);
  assert.match(String(theFill(db).note), /withdrawn; the broker shows no fill/);
  // Still listed as resting after the cancel: it did not take. Cancelled again, not written off.
  const db2 = setup([fill({ status: "cancelled", order_id: "77", cancelled_at: ago(120_000) })]);
  const still = broker({ working: orders(mine("77")) });
  for (let i = 0; i < 3; i++) await pass(db2, still.io, i * 20_000);
  assert.deepEqual([theFill(db2).status, still.b.cancelled], ["cancelled", ["77", "77", "77"]]);
});

test("with the order history unreadable, nothing live at the broker is waited on — then written off, saying what could not be known", async () => {
  const db = setup([fill()]);
  const { io } = broker({ history: null });
  for (let i = 0; i < 3; i++) assert.equal((await pass(db, io, i * 60_000)).voided, 0);
  assert.match(String(theFill(db).note), /order history could not be read/);
  // Fifteen minutes on: two clean looks, then gone — with the caveat written down.
  await pass(db, io, 16 * 60_000 - 200_000);
  const out = await pass(db, io, 17 * 60_000 - 200_000);
  assert.deepEqual([out.voided, theFill(db).status], [1, "void"]);
  assert.match(String(theFill(db).note), /order history unreadable — a fill that had already closed would not be booked/);
});

test("a PART FILL: the rest of the order is withdrawn first, then the position goes in at the broker's quantity", async () => {
  const db = setup([fill({ status: "placed", order_id: "77", created_at: ago(20_000) })]);
  const { io, b } = broker({
    working: orders(mine("77", { status: "Part Filled", filledQty: 0.2, avgPrice: 1.0842, positionId: 555 })),
    positions: positions(myPos("555", { qty: 0.2, avgPrice: 1.0842 })),
  });
  const first = await pass(db, io);
  assert.deepEqual([first.managed, b.cancelled, ledger(db).length, theFill(db).status], [0, ["77"], 0, "placed"]);
  // The broker did not confirm the cancel: nothing moves.
  b.cancelOk = false;
  assert.equal((await pass(db, io, 10_000)).held, 1);
  assert.equal(ledger(db).length, 0);
  // The remainder is gone: adopted, 0.2 lots.
  b.cancelOk = true;
  b.working = orders();
  b.history = orders(mine("77", { status: "Cancelled", filledQty: 0.2, avgPrice: 1.0842, positionId: 555 }));
  const out = await pass(db, io, 20_000);
  assert.deepEqual([out.managed, ledger(db).length, ledger(db)[0].qty, ledger(db)[0].entry, theFill(db).status], [1, 1, 0.2, 1.0842, "managed"]);
});

test("a position already in the ledger under this call's stamp is not touched again — and the call is still not closed on a resting list nobody could read", async () => {
  // A books pass wrote the ledger row and its own "managed" write was lost: the next pass finds the row.
  const led = { account_id: "A1", position_id: "555", symbol: "EURUSD", side: "buy", status: "open", qty: 0.5, be_done: true, cur_stop: 1.0841, strategy_version: GENFX_VERSION, signal_id: KEY };
  const db = setup([fill({ status: "placed", order_id: "77", position_id: "555", created_at: ago(8_000) })], { flow_managed_positions: [{ ...led }], flow_account_reservations: [lock({ state: "active" })] });
  // The history has rolled over and the position is gone: the ledger row is the evidence.
  const { io, b } = broker();
  const out = await pass(db, io);
  assert.deepEqual([out.managed, theFill(db).status, theFill(db).position_id, ledger(db).length], [1, "managed", "555", 1]);
  assert.equal(db.tables.flow_account_reservations.length, 0);
  // The manager has already moved this position's stop to break-even: it is NOT put back where it started.
  const db1 = setup([fill({ status: "placed", order_id: "77", position_id: "555" })], { flow_managed_positions: [{ ...led }] });
  const open = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })), positions: positions(myPos("555")) });
  assert.equal((await pass(db1, open.io)).managed, 1);
  assert.deepEqual([open.b.protected, ledger(db1).length, ledger(db1)[0].cur_stop], [[], 1, 1.0841]);
  // Part of the order is still resting: it is withdrawn first, and only then is the call closed.
  const db2 = setup([fill({ status: "placed", order_id: "77", position_id: "555", created_at: ago(8_000) })], { flow_managed_positions: [{ ...led }] });
  const part = broker({ working: orders(mine("77", { status: "Part Filled", filledQty: 0.2, positionId: 555 })), positions: positions(myPos("555", { qty: 0.2 })) });
  const one = await pass(db2, part.io);
  assert.deepEqual([one.managed, part.b.cancelled, theFill(db2).status], [0, ["77"], "placed"]);
  part.b.working = orders();
  const two = await pass(db2, part.io, 12_000);
  assert.deepEqual([two.managed, theFill(db2).status, part.b.protected], [1, "managed", []]);
  // The resting list cannot be read: the call stays open for as long as that lasts. A remainder still
  // resting would fill later, on nobody's books. (The second version closed it after three tries.)
  const db3 = setup([fill({ status: "placed", order_id: "77", position_id: "555" })], { flow_managed_positions: [{ ...led }] });
  const blind = broker({ working: null });
  for (let i = 0; i < 6; i++) assert.equal((await pass(db3, blind.io, i * 20_000)).managed, 0);
  assert.equal(theFill(db3).status, "placed");
  assert.match(String(theFill(db3).note), /orders could not be read/);
  blind.b.working = orders();
  assert.equal((await pass(db3, blind.io, 200_000)).managed, 1);
});

test("the stop on a position adopted late is confirmed before the manager gets it; five failures and it is handed over with a warning", async () => {
  const db = setup([fill()]);
  const { io, b } = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })), positions: positions(myPos("555")), protectOk: false });
  for (let i = 1; i <= 4; i++) {
    const out = await pass(db, io, i * 20_000);
    assert.deepEqual([out.managed, ledger(db).length, theFill(db).protect_tries], [0, 0, i]);
  }
  assert.match(String(theFill(db).note), /stop could not be confirmed/);
  const out = await pass(db, io, 100_000);
  assert.deepEqual([out.managed, ledger(db).length, theFill(db).status], [1, 1, "managed"]);
  assert.match(String(db.tables.flow_auto_events.at(-1)!.reason), /CHECK SL\/TP ON THE POSITION/);
  // The broker takes it on the second try: no warning.
  const db2 = setup([fill()]);
  const x = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })), positions: positions(myPos("555")), protectOk: false });
  await pass(db2, x.io);
  x.b.protectOk = true;
  assert.equal((await pass(db2, x.io, 20_000)).managed, 1);
  assert.equal(db2.tables.flow_auto_events.length, 0);
  // The broker takes the stop but not the target with it: the position is handed over — protected — and it is said once.
  const db3 = setup([fill()]);
  const y = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })), positions: positions(myPos("555")), protect: "stop" });
  assert.equal((await pass(db3, y.io)).managed, 1);
  assert.deepEqual([theFill(db3).status, theFill(db3).protect_tries, db3.tables.flow_auto_events.length], ["managed", 0, 1]);
  assert.match(String(db3.tables.flow_auto_events[0].reason), /would not take the target with the stop/);
});

test("a retry does not wait its turn behind the row's age: the stop is tried again in ten seconds however many looks the row has had", async () => {
  // A row that rested, was looked at twelve times, and then filled — and the broker will not confirm the stop.
  const db = setup([fill({ status: "placed", order_id: "77", checks: 12 })]);
  const { io } = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })), positions: positions(myPos("555")), protectOk: false });
  await settleFills(asAdmin(db), NOW, io);
  const due = Date.parse(String(theFill(db).next_check_at)) - NOW;
  assert.ok(due >= 9_000 && due <= 12_000, String(due));                    // not the two minutes a held row backs off to
  assert.deepEqual([theFill(db).protect_tries, theFill(db).checks], [1, 13]);
  // The same for a resting order waiting out its validity, and for a cancel the broker did not confirm.
  const db2 = setup([fill({ status: "placed", order_id: "77", checks: 15, created_at: ago(120_000) })]);
  await settleFills(asAdmin(db2), NOW, broker({ working: orders(mine("77")) }).io);
  assert.ok(Date.parse(String(theFill(db2).next_check_at)) - NOW <= 12_000);
  const db3 = setup([fill({ status: "placed", order_id: "77", checks: 15 })]);
  await settleFills(asAdmin(db3), NOW, broker({ working: orders(mine("77")), cancelOk: false }).io);
  assert.ok(Date.parse(String(theFill(db3).next_check_at)) - NOW <= 12_000);
  // …but not for ever: past forty looks a row that is still "waiting" backs off like any other.
  const db4 = setup([fill({ status: "placed", order_id: "77", checks: 45, created_at: ago(120_000) })]);
  await settleFills(asAdmin(db4), NOW, broker({ working: orders(mine("77")) }).io);
  assert.ok(Date.parse(String(theFill(db4).next_check_at)) - NOW >= 500_000);
});

test("a fill that has ALREADY CLOSED is still booked: its position goes into the ledger from the history, for the manager to close out", async () => {
  const db = setup([fill()]);
  const { io, b } = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, avgPrice: 1.08418, positionId: 555 }), order("78", { strategyId: TAG, side: "sell", type: "stop", status: "Filled", filledQty: 0.5, positionId: 555 })) });
  const out = await pass(db, io);
  assert.deepEqual([out.managed, ledger(db).length, ledger(db)[0].position_id, ledger(db)[0].qty, ledger(db)[0].entry], [1, 1, "555", 0.5, 1.08418]);
  assert.deepEqual(b.protected, []);                                 // nothing open to protect
  // The history says filled and names no position, and no position carries the label: held, never written off.
  const db2 = setup([fill()]);
  const unnamedPos = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 0 })) });
  for (let i = 0; i < 4; i++) await pass(db2, unnamedPos.io, i * 60_000);
  assert.deepEqual([theFill(db2).status, ledger(db2).length], ["uncertain", 0]);
  assert.match(String(theFill(db2).note), /names no position/);
});

test("a cancelled order that carries a position id but filled NOTHING is not a fill", async () => {
  const db = setup([fill({ status: "placed", order_id: "77" })]);
  const { io } = broker({ history: orders(mine("77", { status: "Cancelled", filledQty: 0, positionId: 555, isOpen: false })) });
  const out = await pass(db, io);
  assert.deepEqual([out.voided, out.managed, ledger(db).length, theFill(db).status], [1, 0, 0, "void"]);
});

test("in the history but not finished and not resting: nothing is concluded from it — past its validity the order is withdrawn by its id", async () => {
  for (const status of ["New", "PendingCancel", "Unplaced", "Removed"]) {
    // Inside its validity: waited on.
    const db = setup([fill({ status: "placed", order_id: "77", created_at: ago(60_000) })]);
    const { io, b } = broker({ history: orders(mine("77", { status })) });
    for (let i = 0; i < 3; i++) { const out = await pass(db, io, i * 30_000); assert.deepEqual([out.voided, out.cancelled, out.waiting], [0, 0, 1], status); }
    assert.deepEqual([theFill(db).status, b.cancelled], ["placed", []], status);
    // Past it: withdrawn by its id. (The third version waited for ever on a status it did not know — and
    // read "Unplaced" and "Removed", which nobody has seen on a live account, as the broker saying "dead".)
    const late = await pass(db, io, 130_000);
    assert.deepEqual([late.cancelled, late.voided, theFill(db).status, b.cancelled], [1, 0, "cancelled", ["77"]], status);
    // The history still shows it, unexecuted and not final: the half minute a withdrawn order with no
    // trace gets is not enough — it is given the three minutes of an order nobody has heard of.
    for (const t of [145_000, 175_000, 250_000]) assert.equal((await pass(db, io, t)).voided, 0, `${status} ${t}`);
    assert.equal(theFill(db).status, "cancelled", status);
    const end = await pass(db, io, 130_000 + 185_000);
    assert.deepEqual([end.voided, theFill(db).status], [1, "void"], status);
    assert.match(String(theFill(db).note), /withdrawn; the broker shows no fill/);
  }
  // A send whose id was never learned, found by its label in that state: withdrawn by the id on the broker's row.
  const db2 = setup([fill({ created_at: ago(200_000) })]);
  const x = broker({ history: orders(mine("77", { status: "Unplaced" })) });
  const out = await pass(db2, x.io);
  assert.deepEqual([out.cancelled, x.b.cancelled, theFill(db2).status, theFill(db2).order_id], [1, ["77"], "cancelled", "77"]);
  // …and if it then executes after all, it is a fill: the confirmed cancel is what lets it be booked.
  x.b.history = orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 }));
  x.b.positions = positions(myPos("555"));
  assert.deepEqual([(await pass(db2, x.io, 15_000)).managed, theFill(db2).status, ledger(db2).length], [1, "managed", 1]);
});

test("an accepted order the broker shows no trace of: given its validity, withdrawn by id, then two clean looks", async () => {
  const db = setup([fill({ status: "placed", order_id: "77", created_at: ago(30_000) })]);
  const { io, b } = broker();
  assert.equal((await pass(db, io)).waiting, 1);
  assert.deepEqual(b.cancelled, []);
  assert.equal((await pass(db, io, 160_000)).cancelled, 1);
  assert.deepEqual([b.cancelled, theFill(db).status], [["77"], "cancelled"]);
  await pass(db, io, 175_000);
  assert.equal(theFill(db).status, "cancelled");                     // one clean look is not enough
  assert.equal((await pass(db, io, 200_000)).voided, 1);
  // The broker does not confirm the cancel: held.
  const db2 = setup([fill({ status: "placed", order_id: "77" })]);
  const x = broker({ cancelOk: false });
  assert.equal((await pass(db2, x.io)).held, 1);
  assert.equal(theFill(db2).status, "placed");
});

test("a send that died mid-order ('sending') is treated like one that threw", async () => {
  const db = setup([fill({ status: "sending", created_at: ago(130_000) })]);
  const { io } = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })), positions: positions(myPos("555")) });
  assert.equal((await pass(db, io)).managed, 1);
  const db2 = setup([fill({ status: "sending", created_at: ago(130_000) })]);
  const none = broker();
  await pass(db2, none.io);
  assert.deepEqual([theFill(db2).status, theFill(db2).clean], ["uncertain", 1]);      // promoted, one clean look, not yet three minutes
  assert.equal((await pass(db2, none.io, 60_000)).voided, 1);
});

test("the ledger is written once per position — by whoever gets there first, and never for another call's position", async () => {
  const x = { userId: "u1", connectionId: "c1", accountId: "A1", accNum: "101", environment: "demo", positionId: "555", pair: "EURUSD" as const, side: "buy" as const, entry: 1.0841, stop: 1.0825, tp: 1.087, qty: 0.5, mode: "quick", signalKey: KEY, setup: "scanner" };
  const db = setup([]);
  assert.deepEqual(await ensureLedgerRow(asAdmin(db) as never, x), { ok: true, how: "written" });
  assert.deepEqual(await ensureLedgerRow(asAdmin(db) as never, x), { ok: true, how: "exists" });
  assert.equal(ledger(db).length, 1);
  // Another writer's row lands between the look and the insert: the database refuses the second, and it is read as "exists".
  const raced = setup([], {}, { before: (op, d) => { if (op.table === "flow_managed_positions" && op.kind === "insert" && !d.tables.flow_managed_positions.length) d.put("flow_managed_positions", { account_id: "A1", position_id: "555", strategy_version: GENFX_VERSION, signal_id: KEY }); } });
  assert.deepEqual(await ensureLedgerRow(asAdmin(raced) as never, x), { ok: true, how: "exists" });
  assert.equal(ledger(raced).length, 1);
  // An UNSTAMPED row for this position is somebody else's trade — FLOW's and gold's rows carry no stamp.
  // It is refused, not taken over. (The second version stamped it: GEN FX's name on a member's own trade.)
  const bare = setup([], { flow_managed_positions: [{ account_id: "A1", position_id: "555", strategy_version: null, signal_id: null }] });
  assert.deepEqual(await ensureLedgerRow(asAdmin(bare) as never, x), { ok: false, how: "other_owner" });
  assert.deepEqual([ledger(bare).length, ledger(bare)[0].signal_id, ledger(bare)[0].strategy_version], [1, null, null]);
  assert.equal(await ledgerOwner(asAdmin(bare) as never, "A1", "555", KEY), "other");
  assert.equal(await ledgerOwner(asAdmin(db) as never, "A1", "555", KEY), "mine");
  assert.equal(await ledgerOwner(asAdmin(db) as never, "A1", "556", KEY), "none");
  // The position already belongs to ANOTHER call — the broker put this order into it. Not "managed", and
  // the position is NOT touched: the stop on it is the other trade's.
  const netted = setup([fill({ status: "placed", order_id: "77", position_id: "555" })], { flow_managed_positions: [{ account_id: "A1", position_id: "555", strategy_version: GENFX_VERSION, signal_id: "another-call", status: "open" }] });
  assert.deepEqual(await ensureLedgerRow(asAdmin(netted) as never, x), { ok: false, how: "other_owner" });
  const b = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })), positions: positions(myPos("555")) });
  for (let i = 0; i < 3; i++) assert.equal((await pass(netted, b.io, i * 20_000)).managed, 0);
  assert.deepEqual([theFill(netted).status, b.b.protected, ledger(netted).length], ["placed", [], 1]);
  assert.match(String(theFill(netted).note), /^not adopted — .*another trade's ledger row already holds it/);
  assert.equal(netted.tables.flow_auto_events.length, 1);              // said once, not on every look
  assert.match(String(netted.tables.flow_auto_events[0].reason), /CHECK THIS ACCOUNT/);
  // Any failure is reported, never swallowed.
  const down = setup([], {}, { fail: (op) => op.table === "flow_managed_positions" && op.kind === "insert" });
  assert.deepEqual(await ensureLedgerRow(asAdmin(down) as never, x), { ok: false, how: "insert_failed" });
  const blind = setup([], {}, { fail: (op) => op.table === "flow_managed_positions" && op.kind === "select" });
  assert.deepEqual(await ensureLedgerRow(asAdmin(blind) as never, x), { ok: false, how: "ledger_unreadable" });
  assert.equal(await ledgerOwner(asAdmin(blind) as never, "A1", "555", KEY), null);
});

test("no login on the connection the order went out on: the account's other connection is used; none at all is a hold", async () => {
  const filledBroker = () => broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })), positions: positions(myPos("555")) });
  const db = setup([fill()], { flow_broker_accounts: [{ account_id: "A1", connection_id: "c1", acc_num: "101" }, { account_id: "A1", connection_id: "c2", acc_num: "101" }] });
  const x = filledBroker();
  x.b.login = (c) => c === "c2";
  assert.equal((await pass(db, x.io)).managed, 1);
  const db2 = setup([fill()]);
  const y = filledBroker();
  y.b.login = () => false;
  const out = await pass(db2, y.io);
  assert.deepEqual([out.held, theFill(db2).status], [1, "uncertain"]);
  assert.match(String(theFill(db2).note), /no broker login/);
});

test("a pass never undoes what another wrote in the meantime, and a stuck row never crowds out a fresh one", async () => {
  // Placement's own final write lands while this pass is looking: the pass's write is refused, not applied over it.
  const db = setup([fill({ status: "sending", created_at: ago(130_000) })], {}, { before: (op, d) => { if (op.table === "genfx_fills" && op.kind === "update" && d.tables.genfx_fills[0].status === "sending") Object.assign(d.tables.genfx_fills[0], { status: "placed", order_id: "77" }); } });
  await settleFills(asAdmin(db), NOW, broker().io);
  assert.deepEqual([theFill(db).status, theFill(db).order_id], ["placed", "77"]);
  // 120 rows that cannot be settled, each already backed off; one fresh row with a fill. The fresh one is seen.
  const stuck = Array.from({ length: 120 }, (_, i) => fill({ signal_key: `stuck-${i}`, account_id: `S${i}`, checks: 45, next_check_at: new Date(NOW + 300_000).toISOString() }));
  const db2 = setup([...stuck, fill({ created_at: ago(20_000) })]);
  const x = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })), positions: positions(myPos("555")) });
  const out = await settleFills(asAdmin(db2), NOW, x.io);
  assert.deepEqual([out.checked, out.managed], [1, 1]);
  // A hold backs the row off: every pass for ten looks, then two minutes, then ten.
  const db3 = setup([fill({ checks: 9 })]);
  await settleFills(asAdmin(db3), NOW, broker({ working: null }).io);
  const due = Date.parse(String(theFill(db3).next_check_at)) - Date.now();
  assert.ok(due > 100_000 && due <= 120_000, String(due));
  assert.equal(theFill(db3).checks, 10);
});

test("the database itself refuses a second unsettled order on an account, pair and side — and a second ledger row for a position", async () => {
  const db = setup([fill()]);
  const again = await db.from("genfx_fills").insert(fill({ signal_key: "another-call" }));
  assert.equal((again.error as { code?: string }).code, "23505");
  assert.equal((await db.from("genfx_fills").insert(fill({ signal_key: "another-call", side: "sell" }))).error, null);     // the other side is another trade
  db.tables.genfx_fills[0].status = "void";
  assert.equal((await db.from("genfx_fills").insert(fill({ signal_key: "a-third" }))).error, null);                          // settled: the slot is free
});

test("looks alone are not enough: a row is not written off before its time, however many clean looks it has had", async () => {
  // Withdrawn a moment ago: two clean looks five seconds apart are still inside the half minute.
  const db = setup([fill({ status: "cancelled", order_id: "77", cancelled_at: new Date(NOW).toISOString() })]);
  const { io } = broker();
  await pass(db, io, 2_000);
  const early = await pass(db, io, 7_000);
  assert.deepEqual([early.voided, theFill(db).status, theFill(db).clean], [0, "cancelled", 2]);
  assert.equal((await pass(db, io, 40_000)).voided, 1);
  // A send that threw 100 seconds ago: two clean looks do not make it three minutes.
  const db2 = setup([fill({ created_at: ago(100_000) })]);
  const x = broker();
  await pass(db2, x.io);
  assert.equal((await pass(db2, x.io, 20_000)).voided, 0);
  assert.equal((await pass(db2, x.io, 90_000)).voided, 1);
});

test("'cancelled' is the broker's word only when its history could be read — and an order still in the resting list is resting, whatever its status reads", async () => {
  // The resting list shows the order as cancelled, but the history — where a part fill would be — cannot be read.
  const db = setup([fill({ status: "placed", order_id: "77" })]);
  const { io, b } = broker({ working: orders(mine("77", { status: "Cancelled", isOpen: false })), history: null });
  for (let i = 0; i < 4; i++) assert.equal((await pass(db, io, i * 30_000)).voided, 0);
  // While the list shows it, it is an order that can fill: withdrawn by its id (it is past its validity), never written off.
  assert.deepEqual([theFill(db).status, b.cancelled[0], b.cancelled.length >= 1], ["cancelled", "77", true]);
  // The list lets go of it; the history still cannot be read: held for the history.
  b.working = orders();
  for (let i = 4; i < 8; i++) assert.equal((await pass(db, io, i * 30_000)).voided, 0);
  assert.equal(theFill(db).status, "cancelled");
  assert.match(String(theFill(db).note), /order history could not be read/);
  // With the history readable and agreeing, it is final at once.
  const db2 = setup([fill({ status: "placed", order_id: "77" })]);
  const y = broker({ history: orders(mine("77", { status: "Cancelled", isOpen: false })) });
  assert.equal((await pass(db2, y.io)).voided, 1);
});

test("a REFUSED earlier attempt says nothing about the attempt that followed it: the call is not written off on a sibling's refusal", async () => {
  // The broker refused the order with its target, and the order function sent it again with the stop
  // alone — the same label. That second send threw. Seconds later the broker lists the first attempt as
  // "Refused"; the second is not listed yet. (The second version read "every order seen is dead" and
  // freed the account three seconds after the claim, with order 2 about to land.)
  const db = setup([fill({ created_at: ago(3_000) })], { flow_account_reservations: [lock()] });
  const { io, b } = broker({ history: orders(mine("76", { status: "Refused", isOpen: false })) });
  const first = await pass(db, io);
  assert.deepEqual([first.voided, theFill(db).status, theFill(db).order_id, theFill(db).clean, db.tables.flow_account_reservations.length], [0, "uncertain", null, 0, 1]);
  // Order 2 lands and rests: found by the label, taken over under ITS id — never the refused one's.
  b.working = orders(mine("77"));
  await pass(db, io, 12_000);
  assert.deepEqual([theFill(db).status, theFill(db).order_id], ["placed", "77"]);
  // A "placed" row whose own order is momentarily in neither list, beside a refused sibling: not written off either.
  const db2 = setup([fill({ status: "placed", order_id: "77", created_at: ago(5_000) })]);
  const sib = broker({ history: orders(mine("76", { status: "Refused", isOpen: false })) });
  const out = await pass(db2, sib.io);
  assert.deepEqual([out.voided, out.waiting, theFill(db2).status], [0, 1, "placed"]);
  // Its own order refused, by the id the broker gave for it: that IS the broker's word.
  sib.b.history = orders(mine("76", { status: "Refused", isOpen: false }), mine("77", { status: "Cancelled", isOpen: false }));
  assert.equal((await pass(db2, sib.io, 10_000)).voided, 1);
  // And with only the refused attempt ever seen, the call goes the long way: three minutes, two full looks.
  const db3 = setup([fill({ created_at: ago(100_000) })]);
  const only = broker({ history: orders(mine("76", { status: "Refused", isOpen: false })) });
  await pass(db3, only.io);
  assert.equal((await pass(db3, only.io, 20_000)).voided, 0);
  assert.equal((await pass(db3, only.io, 90_000)).voided, 1);
  assert.equal(theFill(db3).order_id, null);                          // a refused attempt's id is never taken for the call's own
});

test("a look taken while the order could still be on its way is not a clean look", async () => {
  // The send threw two seconds after the claim. The broker shows nothing — of course: it may not have arrived.
  const db = setup([fill({ created_at: ago(2_000) })]);
  const { io } = broker();
  for (const dt of [0, 20_000, 40_000, 60_000]) { await pass(db, io, dt); assert.equal(theFill(db).clean, 0, String(dt)); }
  // From eighty seconds after the claim nothing of it can still arrive: those looks count…
  await pass(db, io, 85_000);
  await pass(db, io, 100_000);
  assert.deepEqual([theFill(db).clean, theFill(db).status], [2, "uncertain"]);
  // …and it is still three minutes before the row is written off.
  assert.equal((await pass(db, io, 170_000)).voided, 0);
  assert.equal((await pass(db, io, 181_000)).voided, 1);
});

test("an UNLABELLED order resting where a lost send would be holds the account — it is never cancelled, and never called GEN FX's", async () => {
  // The send threw, and its id was never learned. An order with no label is resting on this pair and
  // side, created since the send: on a broker that did not give the label back, that is where it would be.
  const db = setup([fill()], { flow_account_reservations: [lock()] });
  const { io, b } = broker({ working: orders(order("Q1", { qty: 0.5, createdDate: NOW - 150_000 })) });
  for (let i = 0; i < 4; i++) assert.equal((await pass(db, io, i * 30_000)).voided, 0);
  assert.deepEqual([theFill(db).status, theFill(db).order_id, b.cancelled, db.tables.flow_account_reservations.length], ["uncertain", null, [], 1]);
  assert.match(String(theFill(db).note), /unlabelled order is resting/);
  // One that was there before the call, one the other way, another pair's, one carrying somebody else's label: not it.
  for (const o of [{ createdDate: NOW - 3_600_000 }, { side: "sell", createdDate: NOW - 150_000 }, { tradableInstrumentId: 1, createdDate: NOW - 150_000 }, { strategyId: "AURIC:9", createdDate: NOW - 150_000 }]) {
    const d = setup([fill()]);
    const x = broker({ working: orders(order("Q1", o)) });
    await pass(d, x.io);
    assert.equal((await pass(d, x.io, 15_000)).voided, 1, JSON.stringify(o));
  }
  // A call that HAS its order id is known by that id, and an unlabelled order beside it is nobody's business.
  const d2 = setup([fill({ status: "cancelled", order_id: "77", cancelled_at: ago(60_000) })]);
  const y = broker({ working: orders(order("Q1", { createdDate: NOW - 150_000 })) });
  await pass(d2, y.io);
  assert.equal((await pass(d2, y.io, 15_000)).voided, 1);
});

test("an order found by its id WITHOUT its label: the broker is not giving labels back, and GEN FX takes itself off the account", async () => {
  const accounts = () => [
    { account_id: "A1", connection_id: "c1", acc_num: "101", user_id: "u1", genfx_eurusd: true, genfx_gbpjpy: true },
    { account_id: "A1", connection_id: "c2", acc_num: "101", user_id: "u2", genfx_eurusd: false, genfx_gbpjpy: true },
    { account_id: "A2", connection_id: "c1", acc_num: "102", user_id: "u1", genfx_eurusd: true, genfx_gbpjpy: true },
  ];
  const db = setup([fill({ status: "placed", order_id: "77", created_at: ago(20_000) })], { flow_broker_accounts: accounts() });
  const { io } = broker({ working: orders(order("77", { strategyId: "" })) });              // ours by id; the label came back blank
  await pass(db, io);
  const rows = db.tables.flow_broker_accounts;
  assert.deepEqual(rows.map((r) => [r.account_id, r.genfx_eurusd, r.genfx_gbpjpy]), [["A1", false, false], ["A1", false, false], ["A2", true, true]]);
  const said = db.tables.flow_auto_events.filter((e) => /SWITCHED OFF on this account/.test(String(e.reason)));
  assert.deepEqual(said.map((e) => e.user_id).sort(), ["3b5e06e5-258c-4880-b1f2-d1623cbca100", "u1", "u2"]);       // each member on the account, and the owner
  assert.match(String(said[0].reason), /did not give the order's label back/);
  // The order itself is still followed — it has its id — and nothing is said twice.
  assert.equal(theFill(db).status, "placed");
  await pass(db, io, 10_000);
  assert.equal(db.tables.flow_auto_events.filter((e) => /SWITCHED OFF/.test(String(e.reason))).length, 3);
  // The label as it was sent: nothing happens.
  const db2 = setup([fill({ status: "placed", order_id: "77", created_at: ago(20_000) })], { flow_broker_accounts: accounts() });
  await pass(db2, broker({ working: orders(mine("77")) }).io);
  assert.deepEqual([db2.tables.flow_broker_accounts[0].genfx_eurusd, db2.tables.flow_auto_events.length], [true, 0]);
});

test("a position is adopted only if it is this order's ALONE: an older, bigger or opposite position is left exactly as it is", async () => {
  const filledAs = (pid: string) => orders(mine("77", { status: "Filled", filledQty: 0.5, avgPrice: 1.0842, positionId: pid }));
  const accounts = () => [{ account_id: "A1", connection_id: "c1", acc_num: "101", user_id: "u1", genfx_eurusd: true, genfx_gbpjpy: true }];
  // The broker names, for this order, a position the member has had open for an hour (an account that
  // NETS: one position per pair). It is 1.5 lots; the order was 0.5.
  const db = setup([fill({ status: "placed", order_id: "77" })], { flow_broker_accounts: accounts(), flow_account_reservations: [lock({ state: "active" })] });
  const { io, b } = broker({ history: filledAs("900"), positions: positions(position("900", { qty: 1.5, openDate: NOW - 3_600_000, strategyId: TAG })) });
  for (let i = 0; i < 3; i++) assert.equal((await pass(db, io, i * 20_000)).managed, 0);
  // Its stop is not moved, nothing is written to the ledger, and the row stays — blocking this account, pair and side.
  assert.deepEqual([b.protected, ledger(db).length, theFill(db).status, db.tables.flow_account_reservations.length], [[], 0, "placed", 1]);
  assert.match(String(theFill(db).note), /^not adopted — .*1\.5 lots and the order was 0\.5/);
  // Bigger than the order is proof the account nets: GEN FX takes itself off it, and says so once.
  assert.deepEqual([db.tables.flow_broker_accounts[0].genfx_eurusd, db.tables.flow_broker_accounts[0].genfx_gbpjpy], [false, false]);
  const ev = db.tables.flow_auto_events.map((e) => String(e.reason));
  assert.equal(ev.filter((r) => /not adopted/.test(r)).length, 1);
  assert.ok(ev.some((r) => /SWITCHED OFF on this account — the broker put a GEN FX order into a position that was already open/.test(r)));

  // The other side: the order closed part of somebody's short. Proof again.
  const db2 = setup([fill({ status: "placed", order_id: "77" })], { flow_broker_accounts: accounts() });
  const opp = broker({ history: filledAs("901"), positions: positions(position("901", { side: "sell", qty: 0.3 })) });
  await pass(db2, opp.io);
  assert.deepEqual([opp.b.protected, ledger(db2).length, db2.tables.flow_broker_accounts[0].genfx_eurusd], [[], 0, false]);
  assert.match(String(theFill(db2).note), /other side/);

  // Opened before the order, the right size and side: not understood — left alone and held, but not taken for proof of netting.
  const db3 = setup([fill({ status: "placed", order_id: "77" })], { flow_broker_accounts: accounts() });
  const old = broker({ history: filledAs("902"), positions: positions(position("902", { qty: 0.5, openDate: NOW - 3_600_000 })) });
  await pass(db3, old.io);
  assert.deepEqual([old.b.protected, ledger(db3).length, theFill(db3).status, db3.tables.flow_broker_accounts[0].genfx_eurusd], [[], 0, "placed", true]);
  assert.match(String(theFill(db3).note), /opened before the order was sent/);

  // A position opened a few seconds "before" the claim by the broker's clock is the clocks, not the account.
  const db4 = setup([fill({ status: "placed", order_id: "77", created_at: ago(20_000) })], { flow_broker_accounts: accounts() });
  const skew = broker({ history: filledAs("903"), positions: positions(position("903", { qty: 0.5, openDate: NOW - 26_000 })) });
  assert.equal((await pass(db4, skew.io)).managed, 1);
  // A part fill is smaller than the order, and its own.
  const db5 = setup([fill({ status: "placed", order_id: "77" })], { flow_broker_accounts: accounts() });
  const part = broker({ history: orders(mine("77", { status: "Cancelled", filledQty: 0.2, positionId: 904 })), positions: positions(position("904", { qty: 0.2 })) });
  assert.equal((await pass(db5, part.io)).managed, 1);

  // The rule itself.
  const [p] = readPositions(positions(position("1", { qty: 0.5, openDate: NOW })))!;
  const want = { side: "buy" as const, orderQty: 0.5, claimMs: NOW - 5_000, instrId: "278" };
  assert.equal(notThisOrders(p, want), null);
  assert.deepEqual(notThisOrders({ ...p, qty: 0.500001 }, want)?.hard, true);
  assert.equal(notThisOrders({ ...p, qty: 0.5000001 }, want), null);                       // a rounding hair is not a second trade
  assert.deepEqual(notThisOrders({ ...p, side: "sell" }, want)?.hard, true);
  assert.deepEqual(notThisOrders({ ...p, instrId: "1" }, want)?.hard, false);
  assert.deepEqual(notThisOrders({ ...p, openedMs: NOW - 16_000 }, want)?.hard, false);
  assert.equal(notThisOrders({ ...p, openedMs: NOW - 14_000 }, want), null);
  assert.equal(notThisOrders({ ...p, openedMs: null, qty: 0, side: null }, want), null);   // what cannot be read is not evidence against
  assert.equal(notThisOrders({ ...p, qty: 9 }, { ...want, orderQty: null }), null);        // no order size on the row: nothing to compare
});

test("'cancelled' and tied to a position that is OPEN: the broker has said two things, and the call is neither adopted nor written off", async () => {
  const db = setup([fill({ status: "placed", order_id: "77" })]);
  const { io, b } = broker({ history: orders(mine("77", { status: "Cancelled", filledQty: 0, positionId: 555, isOpen: false })), positions: positions(position("555", { qty: 0.2 })) });
  for (let i = 0; i < 3; i++) { const out = await pass(db, io, i * 30_000); assert.deepEqual([out.voided, out.managed], [0, 0]); }
  assert.deepEqual([theFill(db).status, ledger(db).length, b.protected], ["placed", 0, []]);
  assert.match(String(theFill(db).note), /calls the order cancelled, yet ties it to a position that is open/);
  // That position is already somebody's in the ledger: then it is theirs, and the order is simply dead.
  const db2 = setup([fill({ status: "placed", order_id: "77" })], { flow_managed_positions: [{ account_id: "A1", position_id: "555", strategy_version: null, signal_id: null, status: "open" }] });
  assert.equal((await pass(db2, io)).voided, 1);
  // The positions cannot be read: not written off on a guess.
  const db3 = setup([fill({ status: "placed", order_id: "77" })]);
  b.positions = null;
  assert.equal((await pass(db3, io)).voided, 0);
});

test("two passes that overlap count one look, not two: the second one's write is refused", async () => {
  // Another pass looked at the row between this pass's read and its write.
  const db = setup([fill({ status: "cancelled", order_id: "77", cancelled_at: ago(60_000), clean: 1, checks: 3 })], {}, {
    before: (op, d) => { if (op.table === "genfx_fills" && op.kind === "update" && d.tables.genfx_fills[0].checks === 3) Object.assign(d.tables.genfx_fills[0], { checks: 4, clean: 2 }); },
  });
  const out = await settleFills(asAdmin(db), NOW, broker().io);
  // This pass would have written the row off (its look made two); the row had moved, so it did nothing.
  assert.deepEqual([out.voided, theFill(db).status, theFill(db).checks, theFill(db).clean], [0, "cancelled", 4, 2]);
  // Undisturbed, the same look does write it off.
  const db2 = setup([fill({ status: "cancelled", order_id: "77", cancelled_at: ago(60_000), clean: 1, checks: 3 })]);
  assert.equal((await settleFills(asAdmin(db2), NOW, broker().io)).voided, 1);
});

/* ── the third review: part fills, statuses by the whole word, positions that are not in the open list ── */

test("a PART FILL whose remainder is NOT IN THE RESTING LIST YET is not closed: the order is withdrawn by its id first, and booked at the size it has then", async () => {
  // 0.2 of 0.5 filled. The position list shows the position; the resting list does not show the order
  // yet; the history shows it part filled and not final. (The third version saw "nothing resting, a
  // position" and closed the call at 0.2 — the 0.3 remainder rested on, followed by nobody.)
  const start = () => {
    const db = setup([fill({ status: "placed", order_id: "77", created_at: ago(8_000) })], { flow_account_reservations: [lock({ state: "active" })] });
    const x = broker({ positions: positions(myPos("555", { qty: 0.2, avgPrice: 1.0842 })), history: orders(mine("77", { status: "PartiallyFilled", filledQty: 0.2, avgPrice: 1.0842, positionId: 555 })) });
    return { db, ...x };
  };
  {
    const { db, io, b } = start();
    const one = await pass(db, io);
    assert.deepEqual([one.managed, one.waiting, ledger(db).length, theFill(db).status, b.cancelled], [0, 1, 0, "placed", ["77"]]);
    assert.deepEqual(b.protected, [["555", 1.0825, 1.087]]);                      // its stop is on from the first look
    assert.deepEqual([theFill(db).position_id, !!theFill(db).executed_at, !!theFill(db).cancelled_at], ["555", true, true]);
    assert.equal(db.tables.flow_account_reservations.length, 1);                  // still this call's account
    // The cancel took: the position is booked at what it holds now.
    const two = await pass(db, io, 10_000);
    assert.deepEqual([two.managed, ledger(db).length, ledger(db)[0].qty, theFill(db).status, b.cancelled], [1, 1, 0.2, "managed", ["77"]]);
    assert.equal(db.tables.flow_account_reservations.length, 0);
  }
  {
    // The remainder filled an instant before the cancel ("already gone" is the same answer): booked at the whole size.
    const { db, io, b } = start();
    await pass(db, io);
    b.positions = positions(myPos("555", { qty: 0.5, avgPrice: 1.0843 }));
    const two = await pass(db, io, 10_000);
    assert.deepEqual([two.managed, ledger(db)[0].qty, ledger(db)[0].entry], [1, 0.5, 1.0843]);
  }
  {
    // The broker does not confirm the cancel: nothing is booked, the call stays open, and it is asked again.
    const { db, io, b } = start();
    b.cancelOk = false;
    for (let i = 0; i < 3; i++) { const out = await pass(db, io, i * 10_000); assert.deepEqual([out.managed, out.held, ledger(db).length, theFill(db).status], [0, 1, 0, "placed"]); }
    assert.match(String(theFill(db).note), /did not confirm the cancel of the rest/);
    assert.deepEqual(b.cancelled, ["77", "77", "77"]);
    b.cancelOk = true;
    await pass(db, io, 30_000);
    assert.deepEqual([(await pass(db, io, 40_000)).managed, ledger(db)[0].qty], [1, 0.2]);
  }
  {
    // The order's own history row is final — the broker cancelled the rest itself: nothing to withdraw, booked at once.
    const { db, io, b } = start();
    b.history = orders(mine("77", { status: "Cancelled", filledQty: 0.2, avgPrice: 1.0842, positionId: 555 }));
    const out = await pass(db, io);
    assert.deepEqual([out.managed, ledger(db)[0].qty, b.cancelled], [1, 0.2, []]);
  }
  {
    // The history cannot be read and the position holds the whole order: nothing to withdraw either.
    const { db, io, b } = start();
    b.history = null;
    b.positions = positions(myPos("555", { qty: 0.5 }));
    const out = await pass(db, io);
    assert.deepEqual([out.managed, ledger(db)[0].qty, b.cancelled], [1, 0.5, []]);
  }
});

test("a send whose id was never learned, part filled: with no id to withdraw by, it is booked only after nothing of it has rested its whole validity long", async () => {
  // Found by the label on its position; the history cannot be read, so there is no order row and no id.
  const db = setup([fill({ created_at: ago(100_000) })]);
  const { io, b } = broker({ positions: positions(myPos("555", { qty: 0.2 })), history: null });
  for (const t of [0, 30_000, 60_000]) { const out = await pass(db, io, t); assert.deepEqual([out.managed, ledger(db).length], [0, 0], String(t)); }
  assert.deepEqual([b.cancelled, b.protected.length >= 1, theFill(db).position_id], [[], true, "555"]);
  const out = await pass(db, io, 90_000);                                       // 190 seconds after the claim
  assert.deepEqual([out.managed, ledger(db)[0].qty, theFill(db).status], [1, 0.2, "managed"]);
  // Had its remainder shown up resting in the meantime, it would have been withdrawn by the id on that row.
  const db2 = setup([fill({ created_at: ago(100_000) })]);
  const x = broker({ positions: positions(myPos("555", { qty: 0.2 })), history: null });
  await pass(db2, x.io);
  x.b.working = orders(mine("77", { status: "Part Filled", filledQty: 0.2, positionId: 555 }));
  await pass(db2, x.io, 10_000);
  assert.deepEqual([x.b.cancelled, ledger(db2).length, theFill(db2).order_id], [["77"], 0, "77"]);
  x.b.working = orders();
  assert.deepEqual([(await pass(db2, x.io, 20_000)).managed, ledger(db2)[0].qty], [1, 0.2]);
});

test("EXECUTION, ONCE SEEN, IS REMEMBERED: a part fill that was stopped out while the history lagged is never written off as 'no trace'", async () => {
  // The send threw. Look 1 finds the order by its label, part filled and resting: the rest is withdrawn.
  const db = setup([fill({ created_at: ago(100_000) })], { flow_account_reservations: [lock()] });
  const { io, b } = broker({
    working: orders(mine("77", { status: "Part Filled", filledQty: 0.2, avgPrice: 1.0842, positionId: 555 })),
    positions: positions(myPos("555", { qty: 0.2, avgPrice: 1.0842 })),
  });
  await pass(db, io);
  assert.deepEqual([b.cancelled, theFill(db).status, theFill(db).position_id, theFill(db).order_id, !!theFill(db).executed_at], [["77"], "uncertain", "555", "77", true]);
  // The position is stopped out. The resting list and the position list are empty; the history runs
  // behind and shows nothing of the order. (The third version: two looks on, "no order or position at
  // the broker" — the account freed, and a trade that happened never booked.)
  b.working = orders(); b.positions = positions(); b.history = orders();
  for (const t of [10_000, 60_000, 200_000, 400_000, 900_000]) {
    const out = await pass(db, io, t);
    assert.deepEqual([out.voided, out.managed, theFill(db).status], [0, 0, "uncertain"], String(t));
  }
  assert.match(String(theFill(db).note), /not in the broker's open list/);
  assert.equal(db.tables.flow_account_reservations.length, 1);                    // the account is still held
  // The history catches up: the order, part filled then cancelled, and the stop that closed the position.
  b.history = orders(
    mine("77", { status: "Cancelled", filledQty: 0.2, avgPrice: 1.0842, positionId: 555 }),
    order("9001", { strategyId: TAG, side: "sell", type: "stop", status: "Filled", filledQty: 0.2, positionId: 555, lastModified: NOW + 5_000 }),
  );
  const out = await pass(db, io, 1_000_000);
  assert.deepEqual([out.managed, theFill(db).status, ledger(db).length, ledger(db)[0].position_id, ledger(db)[0].qty, ledger(db)[0].entry], [1, "managed", 1, "555", 0.2, 1.0842]);
  // …and if the history never does: never voided — and never booked on its silence either. Half an hour
  // on it is said out loud, once, and the row goes on holding the account, pair and side.
  const db2 = setup([fill({ position_id: "555", order_id: "77", status: "placed", created_at: ago(100_000) })]);
  const x = broker();
  for (const t of [0, 600_000, 1_200_000]) assert.deepEqual([(await pass(db2, x.io, t)).voided, ledger(db2).length, db2.tables.flow_auto_events.length], [0, 0, 0], String(t));
  for (const t of [31 * 60_000, 45 * 60_000, 3 * 3600_000]) {
    const end = await pass(db2, x.io, t);
    assert.deepEqual([end.managed, end.voided, ledger(db2).length, theFill(db2).status], [0, 0, 0, "placed"], String(t));
  }
  assert.match(String(theFill(db2).note), /^not booked — the position this order opened is not in the broker's open list/);
  const alarms = db2.tables.flow_auto_events.filter((e) => e.status === "error");
  assert.equal(alarms.length, 1);
  assert.match(String(alarms[0].reason), /nothing in its history closed it — CHECK THIS ACCOUNT/);
});

test("an order that executed with no position named for it is held — and stays held when the history can no longer be read", async () => {
  const db = setup([fill()]);
  const { io, b } = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 0 })) });
  await pass(db, io);
  assert.equal(!!theFill(db).executed_at, true);
  // The history goes away for good. Twenty minutes on, an order nobody had seen execute would be written off.
  b.history = null;
  for (const t of [60_000, 600_000, 1_200_000, 2_400_000]) assert.equal((await pass(db, io, t)).voided, 0, String(t));
  assert.deepEqual([theFill(db).status, ledger(db).length], ["uncertain", 0]);
  assert.match(String(theFill(db).note), /names no position/);
});

test("an order being cancelled is not a cancelled order: while it is in the resting list the row is not written off", async () => {
  // "PendingCancel" in the RESTING list. (The third version matched "cancel" anywhere in the word, read
  // the order as dead, and voided a placed row on that look — with the order still listed, able to fill.)
  for (const status of ["PendingCancel", "Pending Cancel", "Cancelling"]) {
    const db = setup([fill({ status: "placed", order_id: "77", created_at: ago(20_000) })], { flow_account_reservations: [lock({ state: "active" })] });
    const { io, b } = broker({ working: orders(mine("77", { status })), history: orders(mine("77", { status })) });
    const out = await pass(db, io);
    assert.deepEqual([out.voided, out.waiting, theFill(db).status, b.cancelled], [0, 1, "placed", []], status);
    assert.equal(db.tables.flow_account_reservations.length, 1);
    // A withdrawn row, half a minute on, the order still listed that way: cancelled again, not written off.
    const db2 = setup([fill({ status: "cancelled", order_id: "77", cancelled_at: ago(60_000) })]);
    const y = broker({ working: orders(mine("77", { status })), history: orders(mine("77", { status })) });
    for (let i = 0; i < 3; i++) assert.equal((await pass(db2, y.io, i * 20_000)).voided, 0, status);
    assert.equal(theFill(db2).status, "cancelled", status);
    // It fills after all: a fill, booked.
    y.b.working = orders();
    y.b.history = orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 }));
    y.b.positions = positions(myPos("555"));
    assert.deepEqual([(await pass(db2, y.io, 70_000)).managed, ledger(db2).length], [1, 1], status);
  }
});

test("a position that is NOT IN THE OPEN LIST is booked only once the history shows it closed after the call — never if somebody else's order is in it", async () => {
  // A NETTING ACCOUNT. GEN FX's buy 0.5 flattened the member's own sell 0.5: the broker names the
  // member's position for the order, and the position is gone. (The third version took "not in the
  // list" for "closed", and wrote the member's position into the ledger under GEN FX's stamp.)
  const flat = () => orders(
    order("M1", { side: "sell", status: "Filled", filledQty: 0.5, positionId: 900, createdDate: NOW - 3_600_000, lastModified: NOW - 3_600_000 }),
    mine("77", { status: "Filled", filledQty: 0.5, positionId: 900 }),
  );
  const acct = () => ({ flow_broker_accounts: [{ account_id: "A1", user_id: "u1", connection_id: "c1", genfx_eurusd: true, genfx_gbpjpy: true }] });
  const db = setup([fill({ status: "placed", order_id: "77", position_id: "900", created_at: ago(8_000) })], acct());
  const { io, b } = broker({ history: flat() });
  const out = await pass(db, io);
  assert.deepEqual([out.managed, out.held, ledger(db).length, theFill(db).status, b.protected], [0, 1, 0, "placed", []]);
  assert.match(String(theFill(db).note), /not adopted/);
  assert.deepEqual([db.tables.flow_broker_accounts[0].genfx_eurusd, db.tables.flow_broker_accounts[0].genfx_gbpjpy], [false, false]);      // the account nets: GEN FX takes itself off it
  assert.ok(db.tables.flow_auto_events.some((e) => /CHECK THIS ACCOUNT/.test(String(e.reason))));
  // The member's own BUY 1.0, GEN FX's 0.5 netted into it — and the position list merely lagging.
  const db2 = setup([fill({ status: "placed", order_id: "77", position_id: "900", created_at: ago(8_000) })], acct());
  const lag = broker({ history: orders(order("M1", { status: "Filled", filledQty: 1, qty: 1, positionId: 900, lastModified: NOW - 3_600_000 }), mine("77", { status: "Filled", filledQty: 0.5, positionId: 900 })) });
  assert.deepEqual([(await pass(db2, lag.io)).managed, ledger(db2).length, lag.b.protected], [0, 0, []]);
  lag.b.positions = positions(position("900", { qty: 1.5, openDate: NOW - 3_600_000 }));          // the list catches up: bigger than the order, older than the call
  assert.deepEqual([(await pass(db2, lag.io, 10_000)).managed, ledger(db2).length, lag.b.protected], [0, 0, []]);
  assert.equal(db2.tables.flow_broker_accounts[0].genfx_eurusd, false);

  // AN ACCOUNT THAT DOES NOT NET. The position is not listed and the history does not show it closed:
  // not listed yet, or closed and the history behind. Waited on; nothing booked.
  const db3 = setup([fill({ status: "placed", order_id: "77", position_id: "555", created_at: ago(8_000) })]);
  const y = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, avgPrice: 1.08418, positionId: 555 })) });
  for (const t of [0, 10_000, 120_000]) assert.deepEqual([(await pass(db3, y.io, t)).managed, ledger(db3).length], [0, 0], String(t));
  assert.equal(theFill(db3).status, "placed");
  // It shows up after all: adopted, with its stop put on.
  const db4 = setup([fill({ status: "placed", order_id: "77", position_id: "555", created_at: ago(8_000) })]);
  const z = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })) });
  await pass(db4, z.io);
  z.b.positions = positions(myPos("555"));
  assert.deepEqual([(await pass(db4, z.io, 10_000)).managed, z.b.protected.length], [1, 1]);
  // The history shows its stop executed: closed, and booked for the manager to close out.
  y.b.history = orders(mine("77", { status: "Filled", filledQty: 0.5, avgPrice: 1.08418, positionId: 555 }), order("9001", { side: "sell", type: "stop", status: "Filled", filledQty: 0.5, positionId: 555, lastModified: NOW + 60_000 }));
  const closed = await pass(db3, y.io, 130_000);
  assert.deepEqual([closed.managed, ledger(db3).length, ledger(db3)[0].position_id, ledger(db3)[0].entry, y.b.protected], [1, 1, "555", 1.08418, []]);
});

test("a refused first attempt being final says nothing about the order the broker TOOK: a part fill of that one is not booked on it", async () => {
  // The broker refused the order with its target (77), and took it with the stop alone (78). 0.2 of 78
  // filled; its position is listed, the order is in neither list yet. Every row the history shows is
  // final — the refusal — and that is not this call's order.
  const db = setup([fill({ status: "placed", order_id: "78", created_at: ago(8_000) })]);
  const { io, b } = broker({ positions: positions(myPos("555", { qty: 0.2 })), history: orders(mine("77", { status: "Refused" })) });
  const one = await pass(db, io);
  assert.deepEqual([one.managed, ledger(db).length, b.cancelled, theFill(db).status], [0, 0, ["78"], "placed"]);        // withdrawn by ITS id, nothing booked
  // The same with no id on the row (the send threw) — the refusal alone is the label's only row: waited on, not booked.
  const db2 = setup([fill({ created_at: ago(100_000) })]);
  const x = broker({ positions: positions(myPos("555", { qty: 0.2 })), history: orders(mine("77", { status: "Refused" })) });
  const two = await pass(db2, x.io);
  assert.deepEqual([two.managed, ledger(db2).length, x.b.cancelled], [0, 0, []]);
});

test("the order the broker took is judged by its OWN row: a sibling attempt whose status says nothing neither keeps it open nor closes it", async () => {
  // The first attempt (77) was turned away and the history calls it "Unplaced" — a word this code does not
  // read as final. The order the broker took (78) was cancelled by the broker, nothing filled.
  const db = setup([fill({ status: "placed", order_id: "78", created_at: ago(20_000) })], { flow_account_reservations: [lock({ state: "active" })] });
  const { io, b } = broker({ history: orders(mine("77", { status: "Unplaced" }), mine("78", { status: "Cancelled" })) });
  const out = await pass(db, io);
  assert.deepEqual([out.voided, theFill(db).status, b.cancelled, db.tables.flow_account_reservations.length], [1, "void", [], 0]);     // dead by its own row: at once
  // The same pair of rows with 0.2 of the taken order filled before the broker cancelled the rest: final by
  // its own row — booked at once at 0.2, nothing to withdraw.
  const db2 = setup([fill({ status: "placed", order_id: "78", created_at: ago(20_000) })]);
  const x = broker({ history: orders(mine("77", { status: "Unplaced" }), mine("78", { status: "Cancelled", filledQty: 0.2, avgPrice: 1.0842, positionId: 555 })), positions: positions(myPos("555", { qty: 0.2, avgPrice: 1.0842 })) });
  const two = await pass(db2, x.io);
  assert.deepEqual([two.managed, ledger(db2)[0].qty, x.b.cancelled], [1, 0.2, []]);
  // A send whose id was never learned: the labelled order that EXECUTED is the one the broker took, and its row being final is enough.
  const db3 = setup([fill({ created_at: ago(100_000) })]);
  const y = broker({ history: orders(mine("77", { status: "Unplaced" }), mine("78", { status: "Cancelled", filledQty: 0.2, positionId: 555 })), positions: positions(myPos("555", { qty: 0.2 })) });
  assert.deepEqual([(await pass(db3, y.io)).managed, ledger(db3)[0].qty, y.b.cancelled, theFill(db3).order_id], [1, 0.2, [], "78"]);
});

/* ── the verification pass: silence is not "closed", the broker's clock against its own, and a list that is behind ── */

test("a NETTING account whose history shows nobody else's order: the member's closed position is never booked on the history's silence", async () => {
  // GEN FX's buy flattened the member's sell. The broker names the member's position for the order; the
  // position is gone; and the member's own order, from an earlier session, is not in the history at all.
  // Nothing says "shared". (The fourth version booked it under GEN FX's stamp half an hour on, without a word.)
  const db = setup([fill({ status: "placed", order_id: "77", position_id: "900", created_at: ago(8_000) })], { flow_account_reservations: [lock({ state: "active" })] });
  const { io, b } = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 900 })) });
  for (const t of [0, 60_000, 20 * 60_000, 31 * 60_000, 2 * 3600_000]) {
    const out = await pass(db, io, t);
    assert.deepEqual([out.managed, out.voided, ledger(db).length, theFill(db).status], [0, 0, 0, "placed"], String(t));
  }
  assert.deepEqual([b.protected, b.cancelled, db.tables.flow_account_reservations.length], [[], [], 1]);            // nothing touched; the account stays held
  assert.equal(db.tables.flow_auto_events.filter((e) => /CHECK THIS ACCOUNT/.test(String(e.reason))).length, 1);    // said once
});

test("a stop-out seconds after the fill on a broker whose clock runs behind: closed, not 'traded against before the call'", async () => {
  // The broker's clock is a minute behind this desk's. By it the entry was created "70 seconds ago" and
  // the stop hit three seconds after the fill — both BEFORE the claim, by the desk's clock. (The fourth
  // version compared the stop's time with the claim's, called the position shared, and switched GEN FX
  // off on the account for good.)
  const slow = (ms: number) => NOW - 60_000 + ms;
  const acct = { flow_broker_accounts: [{ account_id: "A1", user_id: "u1", connection_id: "c1", genfx_eurusd: true, genfx_gbpjpy: true }] };
  const db = setup([fill({ status: "placed", order_id: "77", position_id: "555", created_at: ago(10_000) })], acct);
  const { io } = broker({ history: orders(
    mine("77", { status: "Filled", filledQty: 0.5, avgPrice: 1.0841, positionId: 555, createdDate: slow(-10_000), lastModified: slow(-9_500) }),
    order("9001", { side: "sell", type: "stop", status: "Filled", filledQty: 0.5, positionId: 555, createdDate: slow(-9_400), lastModified: slow(-6_500) }),
  ) });
  const out = await pass(db, io);
  assert.deepEqual([out.managed, ledger(db).length, ledger(db)[0].position_id, theFill(db).status], [1, 1, "555", "managed"]);
  assert.deepEqual([db.tables.flow_broker_accounts[0].genfx_eurusd, db.tables.flow_auto_events.length], [true, 0]);       // nothing switched off, nothing alarmed
  // A broker that ties the closing order to no position at all: the fill the other way, since the entry, is the close.
  const db2 = setup([fill({ status: "placed", order_id: "77", position_id: "555", created_at: ago(10_000) })]);
  const x = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555, createdDate: slow(-10_000), lastModified: slow(-9_500) })) });
  assert.equal((await pass(db2, x.io)).managed, 0);                                                                       // not listed, and nothing says closed: waits
  x.b.history = orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555, createdDate: slow(-10_000), lastModified: slow(-9_500) }), order("9001", { side: "sell", type: "stop", status: "Filled", filledQty: 0.5, positionId: 0, createdDate: slow(-9_400), lastModified: slow(-6_500) }));
  assert.deepEqual([(await pass(db2, x.io, 10_000)).managed, ledger(db2).length], [1, 1]);
});

test("the order history counts the whole order filled while the position list still shows the part: booked once the list has caught up, at the whole size", async () => {
  // (The fourth version booked 0.2 lots and never looked again.)
  const db = setup([fill({ status: "placed", order_id: "77", created_at: ago(8_000) })]);
  const { io, b } = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, avgPrice: 1.0842, positionId: 555 })), positions: positions(myPos("555", { qty: 0.2, avgPrice: 1.0842 })) });
  const one = await pass(db, io);
  assert.deepEqual([one.managed, ledger(db).length, theFill(db).status, b.protected.length], [0, 0, "placed", 1]);          // protected, not booked at the part
  assert.match(String(theFill(db).note), /has not caught up/);
  b.positions = positions(myPos("555", { qty: 0.5, avgPrice: 1.0842 }));
  const two = await pass(db, io, 10_000);
  assert.deepEqual([two.managed, ledger(db)[0].qty], [1, 0.5]);
  // It never catches up (half was closed by hand in those seconds): half a minute on it is booked at what is there.
  const db2 = setup([fill({ status: "placed", order_id: "77", created_at: ago(8_000) })]);
  const x = broker({ history: orders(mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })), positions: positions(myPos("555", { qty: 0.2 })) });
  for (const t of [0, 10_000, 20_000]) assert.equal((await pass(db2, x.io, t)).managed, 0, String(t));
  assert.deepEqual([(await pass(db2, x.io, 35_000)).managed, ledger(db2)[0].qty], [1, 0.2]);
});
