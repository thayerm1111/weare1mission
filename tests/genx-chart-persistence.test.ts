import { call, member, idOf, T, balances, calls, spends, iso, T0 } from "./_routes";
import { test } from "node:test";
import assert from "node:assert/strict";

// The real handlers run against the in-memory database and market feed in _routes.
// Nothing is sent to a broker, a production database, Telegram, or an AI service.
test("each GENX mode reopens its exact generation candles, interval, price and levels without a new read", async () => {
  for (const [mode, interval] of [["quick", "5min"], ["intraday", "15min"], ["swing", "1h"]] as const) {
    const token = member(`chart-${mode}`, { credits: 20 });
    const made = await call("genx", "POST", "/api/genx", token, { mode });
    assert.equal(made.status, 200, made.text.slice(0, 200));
    assert.equal(made.json.ok, true);
    assert.ok(made.json.signal_id);
    assert.ok(made.json.candles.length >= 5, "the generated signal contains actual source candles");
    assert.equal(made.json.candles_tf, interval);
    const recorded = T("genx_signals").find((row) => row.id === made.json.signal_id)!;
    assert.equal(recorded.user_id, idOf(token));
    assert.deepEqual(recorded.market_snapshot.candles, made.json.candles);
    assert.equal(recorded.market_snapshot.candles_tf, interval);

    const beforeCalls = calls.length;
    const beforeSpends = spends(token);
    const beforeBalance = balances.get(idOf(token));
    const reopened = await call("genx/history", "GET", `/api/genx/history?id=${made.json.signal_id}`, token);
    assert.equal(reopened.status, 200, reopened.text.slice(0, 200));
    const saved = reopened.json.play;
    assert.equal(saved.mode, mode);
    assert.equal(saved.candles_tf, interval);
    assert.deepEqual(saved.candles, made.json.candles);
    assert.deepEqual(saved.genx, made.json.genx);
    assert.equal(saved.price, made.json.price);
    assert.equal(saved.asOf, made.json.asOf);
    assert.equal(saved.data_status, made.json.data_status);
    assert.deepEqual(spends(token), beforeSpends, "reopening a chart must not charge for another signal");
    assert.equal(balances.get(idOf(token)), beforeBalance);
    assert.ok(calls.slice(beforeCalls).every((entry) => entry.startsWith("GET supabase.invalid/")),
      "history may only read auth and the existing record; it must not refresh market data or call an AI");
  }
});

test("GENX chart snapshots remain private to the member who generated them", async () => {
  const owner = member("chart-owner", { credits: 20 });
  const stranger = member("chart-stranger", { credits: 20 });
  const made = await call("genx", "POST", "/api/genx", owner, { mode: "quick" });
  assert.ok(made.json.signal_id);
  const query = `/api/genx/history?id=${made.json.signal_id}`;
  const other = await call("genx/history", "GET", query, stranger);
  const anonymous = await call("genx/history", "GET", query, null);
  assert.deepEqual([other.status, other.json.error], [404, "not_found"]);
  assert.deepEqual([anonymous.status, anonymous.json.error], [401, "unauthorized"]);
  assert.equal(other.json.play, undefined);
  const listed = await call("genx/history", "GET", "/api/genx/history", stranger);
  assert.deepEqual(listed.json.plays, []);
});

test("older GENX records preserve their original read and explicitly lack a candle snapshot", async () => {
  const token = member("legacy-chart", { credits: 20 });
  const genx = { action: "WAIT_FOR_SELL_TRIGGER", mode: "swing", entry: 3586.29, stop_loss: 3595.97, tp1: 3554.02 };
  for (const [id, extra] of [["legacy-no-candles", {}], ["legacy-invalid-candles", { candles: "not-an-array", candles_tf: 15 }]] as const) {
    T("genx_signals").push({ id, user_id: idOf(token), created_at: iso(T0), mode: "swing", reasoning: genx,
      market_snapshot: { price: 3578.2, asOf: iso(T0), ...extra } });
    const beforeCalls = calls.length;
    const saved = await call("genx/history", "GET", `/api/genx/history?id=${id}`, token);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.play.genx, genx);
    assert.deepEqual(saved.json.play.candles, []);
    assert.equal(saved.json.play.candles_tf, null);
    assert.equal(saved.json.play.price, 3578.2);
    assert.ok(calls.slice(beforeCalls).every((entry) => entry.startsWith("GET supabase.invalid/")),
      "a missing historical snapshot must not be replaced with today's candles");
  }
  assert.deepEqual(spends(token), []);
});
