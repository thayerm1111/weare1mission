/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * A TRADE MOVES WITH ITS ACCOUNT (10-14, owner: "Fix whatever you gotta fix").
 *
 * Reconnecting a broker writes a new connection and deletes the old one. Open trades kept the old
 * connection's id, the manager could get no token for it, and marked them "token" on every pass without
 * managing them: four trades on two members' accounts on 10-14, one for nine days. A trade whose
 * connection no longer exists is moved to the same account (same member, account id, demo/live) under the
 * connection that has it now — and nothing else is moved.
 */
import { reset, account, trade, walk, ledger, loadManager, T, conns, logs, broker } from "./_manager";
import test from "node:test";
import assert from "node:assert/strict";

const M = loadManager();
const connection = (id: string, environment = "demo") => T("flow_broker_connections").push({ id, user_id: "u1", broker: "tradelocker", environment, status: "connected" });

/** A gold buy on account 7 placed under `conn-7`; then the member reconnects: `conn-7` is deleted and account 7 is
 *  listed under `newConn` as account number `accNum`. */
function reconnected(o: { newConn: string; env?: string; accNum?: string; oldStillThere?: boolean }) {
  reset();
  account("7");                                                   // the row as it was: conn-7
  const id = trade({ account: "7", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, qty: 0.1, tpAtBroker: 4005 });
  conns.gone.add("conn-7");
  if (o.oldStillThere) connection("conn-7");
  connection(o.newConn, o.env ?? "demo");
  T("flow_broker_accounts").push({ id: "acct-7-new", user_id: "u1", connection_id: o.newConn, account_id: "7", acc_num: o.accNum ?? "3", created_at: "2026-10-14T10:00:00Z",
    manage_trades: true, gold_be_pips: null, be_enabled: true, trail_mode: "normal", partial_pct: 0 });
  // The member's old account row went with the old connection.
  db_remove_old_account();
  return id;
}
function db_remove_old_account() {
  const rows = T("flow_broker_accounts");
  const i = rows.findIndex((r) => r.connection_id === "conn-7");
  if (i >= 0) rows.splice(i, 1);
}

test("after a reconnect the trade is moved to the new connection and looked after", async () => {
  const id = reconnected({ newConn: "conn-new", accNum: "3" });
  await walk(M, "XAUUSD", [4001, 4003.4]);                         // 34 pips up: break-even is due
  const r = ledger(id);
  assert.deepEqual([r.connection_id, r.acc_num], ["conn-new", "3"]);
  assert.notEqual(r.last_error, "token");
  assert.equal(r.be_done, true, "break-even moved, as for any other trade");
  assert.ok(broker.calls.some((c) => c.startsWith(`modify ${id} sl=`)));
  assert.deepEqual(logs.filter((l) => l.phase === "reattached").map((l) => [l.reason, l.position_id]), [["reconnected", id]]);
});

test("a connection that still exists but cannot sign in is not a reconnect: nothing is moved", async () => {
  const id = reconnected({ newConn: "conn-new", oldStillThere: true });
  await walk(M, "XAUUSD", [4001, 4003.4]);
  const r = ledger(id);
  assert.deepEqual([r.connection_id, r.last_error, r.be_done], ["conn-7", "token", false]);
  assert.equal(logs.filter((l) => l.phase === "reattached").length, 0);
});

test("a demo trade is never moved to a live connection (or the other way round)", async () => {
  const id = reconnected({ newConn: "conn-live", env: "live" });
  await walk(M, "XAUUSD", [4001, 4003.4]);
  assert.deepEqual([ledger(id).connection_id, ledger(id).last_error], ["conn-7", "token"]);
});

test("another member's account with the same number is not this member's account", async () => {
  const id = reconnected({ newConn: "conn-new" });
  const mine = T("flow_broker_accounts").find((r) => r.connection_id === "conn-new")!;
  mine.user_id = "u2";
  await walk(M, "XAUUSD", [4001]);
  assert.deepEqual([ledger(id).connection_id, ledger(id).last_error], ["conn-7", "token"]);
});
