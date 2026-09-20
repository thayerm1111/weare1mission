/**
 * READING THE BROKER'S OPEN POSITIONS.
 *
 * This file exists because of fourteen live positions on a funded account.
 *
 * parsePositions began with `if (Array.isArray(r)) return [];` — "columnar rows need the config;
 * handled by the caller". The caller did not handle it. TradeLocker sends positions as columnar
 * arrays, so every row was dropped and the function reported an empty account while fourteen
 * positions were open.
 *
 * Downstream, the interlock, the cooldown, the hourly entry count and the one-position limit are all
 * computed from what that produced. Four guards, none of them wrong, every one of them reading a table
 * that one dropped `if` kept empty — so the engine re-entered every twenty-five seconds, eighteen
 * times.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePositions, positionColumns, DEFAULT_POSITION_COLUMNS,
} from "../command-center/adapters/tradelocker";

/** A columnar row in this broker's default order: id, instrument, ?, side, qty, avgPrice. */
const row = (id: string, instr: string, side: string, qty: number, avg: number) =>
  [id, instr, "XAUUSD", side, qty, avg];

test("COLUMNAR POSITIONS ARE NOT INVISIBLE", () => {
  // The whole incident in one assertion.
  const body = { d: { positions: [
    row("111", "8542", "sell", 1.98, 4379.2),
    row("222", "8542", "sell", 2.00, 4378.6),
  ] } };

  const out = parsePositions(body);
  assert.equal(out.length, 2, "two open positions must read as two, not zero");
  assert.equal(out[0].id, "111");
  assert.equal(out[0].instrumentId, "8542");
  assert.equal(out[0].side, "sell");
  assert.equal(out[0].qty, 1.98);
  assert.equal(out[0].avgPrice, 4379.2);
});

test("an empty account still reads as empty", () => {
  // The guard must not now hallucinate positions that are not there, which would block every entry.
  assert.equal(parsePositions({ d: { positions: [] } }).length, 0);
  assert.equal(parsePositions({ d: {} }).length, 0);
  assert.equal(parsePositions(null).length, 0);
});

test("object-keyed rows still work — the shape varies by broker build", () => {
  const body = { d: { positions: [
    { id: "333", tradableInstrumentId: "8542", side: "buy", qty: 0.5, avgPrice: 4300, stopLoss: 4290 },
  ] } };
  const out = parsePositions(body);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "333");
  assert.equal(out[0].sl, 4290);
});

test("column order comes from the broker's own config when it gives one", () => {
  const config = { d: { positionsConfig: { columns: [
    { id: "id" }, { id: "side" }, { id: "qty" }, { id: "tradableInstrumentId" }, { id: "avgPrice" },
  ] } } };
  const cols = positionColumns(config);
  assert.equal(cols.idIdx, 0);
  assert.equal(cols.sideIdx, 1);
  assert.equal(cols.qtyIdx, 2);
  assert.equal(cols.instrIdx, 3);
  assert.equal(cols.avgIdx, 4);

  const out = parsePositions({ d: { positions: [["777", "sell", 3.5, "8542", 4380]] } }, cols);
  assert.equal(out.length, 1);
  assert.equal(out[0].qty, 3.5, "read by the broker's stated order, not a guess");
  assert.equal(out[0].instrumentId, "8542");
});

test("an unreadable config falls back to the order FLOW has used for months", () => {
  assert.deepEqual(positionColumns(null), DEFAULT_POSITION_COLUMNS);
  assert.deepEqual(positionColumns({ d: {} }), DEFAULT_POSITION_COLUMNS);
  assert.deepEqual(positionColumns({ d: { positionsConfig: [] } }), DEFAULT_POSITION_COLUMNS);
});

test("a row with no id is skipped rather than invented", () => {
  const out = parsePositions({ d: { positions: [[null, "8542", "XAUUSD", "sell", 1, 4379]] } });
  assert.equal(out.length, 0, "a position we cannot name is not a position we can manage");
});
