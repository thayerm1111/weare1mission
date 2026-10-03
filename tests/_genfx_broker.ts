/**
 * A stand-in TradeLocker account for the GEN FX tests. It sends what the real one sends: rows as bare
 * arrays, with the column names separate — the names and their order are the broker's own (the
 * official client's OrdersColumns and PositionsColumns), so a test that passes here is reading the
 * shape production reads. Rows are built by name and laid out by those columns.
 */
import { type Rows } from "../src/lib/genfx/fills";

export const ORDER_COLS = ["id", "tradableInstrumentId", "routeId", "qty", "side", "type", "status", "filledQty", "avgPrice", "price", "stopPrice", "validity", "expireDate", "createdDate", "lastModified", "isOpen", "positionId", "stopLoss", "stopLossType", "takeProfit", "takeProfitType", "strategyId"];
export const POSITION_COLS = ["id", "tradableInstrumentId", "routeId", "side", "qty", "avgPrice", "stopLossId", "takeProfitId", "openDate", "unrealizedPl", "strategyId"];

const mapOf = (cols: string[]): Record<string, number> => Object.fromEntries(cols.map((c, i) => [c, i]));
export const orderCols = mapOf(ORDER_COLS);
export const positionCols = mapOf(POSITION_COLS);
const lay = (cols: string[], o: Record<string, unknown>): unknown[] => cols.map((c) => o[c] ?? null);

/** An order row. Defaults: a EUR/USD (instrument 278) buy limit of 0.5, resting, with no label. */
export const order = (id: string, o: Record<string, unknown> = {}): unknown[] =>
  lay(ORDER_COLS, { id, tradableInstrumentId: 278, routeId: 1, qty: 0.5, side: "buy", type: "limit", status: "New", filledQty: 0, avgPrice: 0, price: 1.0845, validity: "GTC", createdDate: Date.now(), isOpen: true, positionId: 0, stopLoss: 1.0825, takeProfit: 1.087, strategyId: "", ...o });
/** A position row. Defaults: a EUR/USD buy of 0.5 opened now, with no label. */
export const position = (id: string, o: Record<string, unknown> = {}): unknown[] =>
  lay(POSITION_COLS, { id, tradableInstrumentId: 278, routeId: 1, side: "buy", qty: 0.5, avgPrice: 1.08412, stopLossId: 9001, takeProfitId: 9002, openDate: Date.now(), unrealizedPl: 0, strategyId: "", ...o });

export const orders = (...rows: unknown[][]): Rows => ({ rows, cols: orderCols });
export const positions = (...rows: unknown[][]): Rows => ({ rows, cols: positionCols });
/** The same rows with the column names lost — what a failed /trade/config read leaves behind. */
export const unnamed = (list: Rows): Rows => ({ rows: list.rows, cols: undefined });
