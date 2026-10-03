import { test } from "node:test";
import assert from "node:assert/strict";
import { PAIRS } from "../src/lib/genfx/pairs";
import { UNSETTLED, sameSide, maxEntryFor, fxTag, readable, carriesLabels, restingEntrySides, restingSuspects, ourOrders, positionPast, readPositions, suspects, recheckDelayMs, ORDER_COLUMNS, SEND_DEADLINE_MS, LAST_ARRIVAL_MS, NO_TRACE_VOID_MS, CLAIM_DEAD_MS } from "../src/lib/genfx/fills";
import { order, position, orders, positions, unnamed, orderCols } from "./_genfx_broker";
import { positionForOrder } from "../src/lib/flow/brokerEvidence";

/*
 * The rules that decide whether an order or a position at the broker is GEN FX's own, and whether a
 * list from the broker says anything at all. Everything here is pure, and every row is laid out the
 * way the broker lays it out. The standing question for each rule: can a member's own trade — same
 * pair, same side, same size — ever be taken for GEN FX's? And can silence ever be taken for "none"?
 */
const E = PAIRS.EURUSD, J = PAIRS.GBPJPY;
const TAG = fxTag("EURUSD:quick:buy:10840:10842:20261005", "A1");
const who = (o: { orderId?: string | null; side?: "buy" | "sell" } = {}) => ({ tag: TAG, orderId: o.orderId ?? null, side: o.side ?? ("buy" as const) });

test("the label: the same for the same call and account, different for any other, inside the broker's limit", () => {
  assert.equal(fxTag("k", "A1"), fxTag("k", "A1"));
  assert.notEqual(fxTag("k", "A1"), fxTag("k", "A2"));
  assert.notEqual(fxTag("k", "A1"), fxTag("k2", "A1"));
  assert.match(TAG, /^gfx-[0-9a-f]{24}$/);
  assert.ok(TAG.length <= 31);
});

test("sides: the same side blocks, and so does a side nobody can read", () => {
  assert.equal(sameSide("buy", "BUY "), true);
  assert.equal(sameSide("buy", "sell"), false);
  assert.equal(sameSide(null, "sell"), true);
  assert.equal(sameSide("long", "buy"), true);
  assert.deepEqual(UNSETTLED, ["reserved", "sending", "placed", "uncertain", "cancelled"]);
});

test("the worst fill: a quarter of the stop distance past the quote, whatever the stop, rounded to the safe side", () => {
  assert.equal(maxEntryFor(E, "buy", 1.08412, 1.0825), 1.08452);       // 16.2 pips of stop → 4.05 pips of chase, floored
  assert.equal(maxEntryFor(E, "sell", 1.08408, 1.0858), 1.08365);      // 17.2 pips → 4.3, the cap rounded UP
  assert.equal(maxEntryFor(J, "buy", 201.42, 201.0), 201.525);
  // A tight stop gets a tight chase — never a fixed minimum that would be a third or a half of the stop.
  const cap = maxEntryFor(E, "buy", 1.084, 1.0837);                     // a 3-pip stop
  assert.ok(cap - 1.084 <= 0.25 * 0.0003 + 1e-9, String(cap));
  for (const [fill, stop] of [[1.08437, 1.08211], [1.08363, 1.08599], [1.1, 1.0981]] as const) {
    const side = stop < fill ? "buy" : "sell";
    const worst = Math.abs(maxEntryFor(E, side, fill, stop) - stop) / Math.abs(fill - stop);
    assert.ok(worst <= 1.25 + 1e-9, `${fill}/${stop}: ${worst}`);
  }
});

test("a list of bare rows without its column names cannot be read — and an empty list can", () => {
  const list = orders(order("1"));
  assert.equal(readable(list, ORDER_COLUMNS), true);
  assert.equal(readable(unnamed(list), ORDER_COLUMNS), false);
  assert.equal(readable({ rows: [], cols: undefined }, ORDER_COLUMNS), true);          // "none" is an answer
  assert.equal(readable(null, ORDER_COLUMNS), false);
  // Named rows carry their own names.
  assert.equal(readable({ rows: [{ id: "1", side: "buy", status: "New" }], cols: undefined }, ORDER_COLUMNS), true);
  // The names are there but the one that matters is not.
  const rest: Record<string, number> = { ...orderCols };
  delete rest.strategyId;
  assert.equal(readable({ rows: [order("1")], cols: rest }, ORDER_COLUMNS), false);
  assert.equal(readable({ rows: [order("1"), null], cols: undefined }, ORDER_COLUMNS), false);
  // The broker has to give the label back on resting orders AND in the history, or GEN FX does not trade there.
  assert.equal(carriesLabels(orderCols, orderCols), true);
  assert.equal(carriesLabels(orderCols, rest), false);
  assert.equal(carriesLabels(undefined, orderCols), false);
});

test("resting entries: anybody's entry on this instrument counts; protection does not; what cannot be read is not 'none'", () => {
  const sides = (...rows: unknown[][]) => restingEntrySides(orders(...rows), 278);
  assert.deepEqual([...sides(order("1"))!], ["buy"]);
  assert.deepEqual([...sides(order("1", { side: "sell" }), order("2"))!].sort(), ["buy", "sell"]);
  assert.equal(sides()!.size, 0);
  // Another instrument's order is not this pair's.
  assert.equal(sides(order("1", { tradableInstrumentId: 99 }))!.size, 0);
  // A position's stop and target are not entries: they are LINKED to the position.
  assert.equal(sides(order("1", { side: "sell", type: "limit", positionId: 555 }), order("2", { side: "sell", type: "stop", positionId: 555 }))!.size, 0);
  // A stop order with no position behind it is a stop ENTRY — the member's own breakout order — and it is exposure.
  // (The second version skipped every stop-type order, and would have placed beside it.)
  assert.deepEqual([...sides(order("1", { side: "sell", type: "stop" }))!], ["sell"]);
  assert.deepEqual([...sides(order("1", { side: "buy", type: "stop", positionId: 0 }))!], ["buy"]);
  // Finished orders are not resting — by the status's whole word.
  for (const status of ["Cancelled", "Canceled", "Filled", "Refused", "Rejected", "Expired"]) assert.equal(sides(order("1", { status }))!.size, 0, status);
  // A status this code has never seen is still an order that has not executed.
  for (const status of ["PendingNew", "Modified", "WaitingMarket", "Part Filled", "Accepted", ""]) assert.deepEqual([...sides(order("1", { status }))!], ["buy"], status);
  // …and so is one that only CONTAINS a finished word, or whose meaning has not been seen on a live account.
  // (The third version matched "cancel" anywhere in the word, and read an order being cancelled as gone.)
  for (const status of ["PendingCancel", "Pending Cancel", "Cancelling", "Unfilled", "Unplaced", "Removed"]) assert.deepEqual([...sides(order("1", { status }))!], ["buy"], status);
  // A side that cannot be read blocks both ways.
  assert.deepEqual([...sides(order("1", { side: "" }))!].sort(), ["buy", "sell"]);
  // The list cannot be read: null, never an empty set. (The first version answered "nothing resting".)
  assert.equal(restingEntrySides(unnamed(orders(order("1"))), 278), null);
  assert.equal(restingEntrySides(null, 278), null);
});

test("this call's order is the one with its id or its label — never one that merely looks like it", () => {
  // The member's own order: same pair, side, size and price, no label. It is nobody's business here.
  const theirs = order("M1");
  assert.deepEqual(ourOrders(orders(theirs), orders(), who())!.seen, 0);
  // Ours by label, resting.
  const mine = ourOrders(orders(theirs, order("77", { strategyId: TAG })), orders(), who())!;
  assert.deepEqual([mine.seen, mine.orderIds, mine.working, mine.filled, mine.dead, mine.pending], [1, ["77"], ["77"], false, false, false]);
  // Ours by id, even with the label missing.
  assert.deepEqual(ourOrders(orders(order("77")), orders(), who({ orderId: "77" }))!.working, ["77"]);
  // Labelled, but the other way: the position's stop, its target, or the order that closed it.
  const legs = ourOrders(
    orders(order("78", { strategyId: TAG, side: "sell", type: "stop", positionId: 555 }), order("79", { strategyId: TAG, side: "sell", type: "limit", positionId: 555 })),
    orders(order("80", { strategyId: TAG, side: "sell", type: "market", status: "Filled", filledQty: 0.5, positionId: 555 })), who())!;
  assert.equal(legs.seen, 0);
  // Somebody else's label.
  assert.equal(ourOrders(orders(order("81", { strategyId: "gfx-000000000000000000000000" })), orders(), who())!.seen, 0);
  // The label compares without regard to case or stray spaces.
  assert.equal(ourOrders(orders(order("82", { strategyId: ` ${TAG.toUpperCase()} ` })), orders(), who())!.seen, 1);
});

test("a fill is execution: a quantity filled or a status that says so — a position id alone is not one", () => {
  const filled = ourOrders(orders(), orders(order("77", { strategyId: TAG, status: "Filled", filledQty: 0.5, avgPrice: 1.08415, positionId: 555, isOpen: false })), who())!;
  assert.deepEqual([filled.filled, filled.filledQty, filled.avgPrice, filled.positionIds, filled.working, filled.dead], [true, 0.5, 1.08415, ["555"], [], false]);
  // Cancelled with nothing filled — and a position id on the row all the same. That is not a fill.
  const cancelled = ourOrders(orders(), orders(order("77", { strategyId: TAG, status: "Cancelled", positionId: 555, isOpen: false })), who())!;
  assert.deepEqual([cancelled.filled, cancelled.positionIds, cancelled.dead], [false, [], true]);
  for (const status of ["Refused", "Rejected", "Expired", "Canceled"]) assert.equal(ourOrders(orders(), orders(order("77", { strategyId: TAG, status })), who())!.dead, true, status);
  // "DoneForDay" is not "filled".
  const done = ourOrders(orders(), orders(order("77", { strategyId: TAG, status: "DoneForDay" })), who())!;
  assert.deepEqual([done.filled, done.dead, done.pending], [false, false, true]);
  // In the history, not finished, not resting: the broker has not said yet.
  assert.equal(ourOrders(orders(), orders(order("77", { strategyId: TAG, status: "New" })), who())!.pending, true);
  // Part filled and still resting: filled AND working.
  const part = ourOrders(orders(order("77", { strategyId: TAG, status: "Part Filled", filledQty: 0.2, avgPrice: 1.0842, positionId: 555 })), orders(), who())!;
  assert.deepEqual([part.filled, part.filledQty, part.working, part.positionIds], [true, 0.2, ["77"], ["555"]]);
  // Part filled, then cancelled: still a fill — it left a position.
  const partCancelled = ourOrders(orders(), orders(order("77", { strategyId: TAG, status: "Cancelled", filledQty: 0.2, positionId: 555 })), who())!;
  assert.deepEqual([partCancelled.filled, partCancelled.dead, partCancelled.positionIds], [true, false, ["555"]]);
  // The same order in both lists is one order.
  const both = ourOrders(orders(order("77", { strategyId: TAG })), orders(order("77", { strategyId: TAG })), who())!;
  assert.deepEqual([both.seen, both.working], [1, ["77"]]);
  // A margin retry: the refused first order and the accepted second.
  const retry = ourOrders(orders(order("78", { strategyId: TAG, qty: 0.01 })), orders(order("77", { strategyId: TAG, status: "Refused" })), who())!;
  assert.deepEqual([retry.seen, retry.working, retry.dead, retry.filled], [2, ["78"], false, false]);
  // The id worth remembering is an order the broker TOOK — resting, else executed — never the refused attempt.
  assert.equal(retry.liveId, "78");
  assert.equal(ourOrders(orders(), orders(order("77", { strategyId: TAG, status: "Refused" })), who())!.liveId, null);
  assert.equal(ourOrders(orders(), orders(order("77", { strategyId: TAG, status: "Refused" }), order("78", { strategyId: TAG, status: "Filled", positionId: 555 })), who())!.liveId, "78");
  // A row that did NOT execute and is tied to a position all the same: not a fill — and reported, so the caller can look at that position.
  assert.deepEqual(cancelled.links, ["555"]);
  assert.deepEqual([filled.links, partCancelled.links, retry.links], [[], [], []]);
});

test("a status is read by its whole word: an order being cancelled is not a cancelled order, and the resting list is of orders that can still fill", () => {
  const hist = (status: string, o: Record<string, unknown> = {}) => ourOrders(orders(), orders(order("77", { strategyId: TAG, status, ...o })), who({ orderId: "77" }))!;
  const rest = (status: string, o: Record<string, unknown> = {}) => ourOrders(orders(order("77", { strategyId: TAG, status, ...o })), orders(), who({ orderId: "77" }))!;
  // In the RESTING list an order is resting, whatever its status reads — unless it is filled in full.
  // (The third version matched "cancel" anywhere in the word: "PendingCancel" read as dead, and a
  // placed row was written off while its order was still listed and could fill.)
  for (const status of ["PendingCancel", "Pending Cancel", "Cancelling", "Cancelled", "Unplaced", "Removed", "New", ""]) {
    const o = rest(status);
    assert.deepEqual([o.working, o.dead, o.pending, o.finalIds, o.deadIds], [["77"], false, false, [], []], status);
  }
  assert.deepEqual([rest("Filled", { filledQty: 0.5 }).working, rest("Filled", { filledQty: 0.5 }).filled], [[], true]);
  // In the HISTORY, "dead" is the broker's word only in so many words.
  for (const status of ["Cancelled", "Canceled", "Refused", "Rejected", "Expired"]) assert.deepEqual([hist(status).dead, hist(status).finalIds, hist(status).deadIds, hist(status).unfinished], [true, ["77"], ["77"], []], status);
  // A word that only contains one of those, and the two whose meaning has not been seen live, say nothing:
  // the order is neither dead nor resting — it is unfinished, and its id is given so it can be withdrawn.
  for (const status of ["PendingCancel", "Pending Cancel", "Cancelling", "Unplaced", "Removed", "New", "Working"]) {
    const o = hist(status);
    assert.deepEqual([o.dead, o.pending, o.finalIds, o.deadIds, o.unfinished, o.working], [false, true, [], [], ["77"], []], status);
  }
  // "Unfilled" is not "filled".
  assert.deepEqual([hist("Unfilled").filled, hist("Unfilled").pending], [false, true]);
  for (const status of ["Filled", "PartiallyFilled", "Partially Filled", "Part Filled", "Partial Fill"]) assert.equal(hist(status).filled, true, status);
});

test("an order is final only by the history's own word — asked per order: a refused sibling neither closes the order the broker took nor keeps it open", () => {
  const of = (working: unknown[][], history: unknown[][]) => ourOrders(orders(...working), orders(...history), who())!;
  const mine = (id: string, o: Record<string, unknown> = {}) => order(id, { strategyId: TAG, ...o });
  const ids = (o: ReturnType<typeof of>) => [o.finalIds, o.deadIds];
  // Filled in full: final, and not dead.
  assert.deepEqual(ids(of([], [mine("77", { status: "Filled", filledQty: 0.5, positionId: 555 })])), [["77"], []]);
  // Filled in full by its quantities, whatever the status reads.
  assert.deepEqual(ids(of([], [mine("77", { status: "Done", filledQty: 0.5, positionId: 555 })])), [["77"], []]);
  // Part filled, and the broker cancelled the rest: final — it left a position, so not dead.
  assert.deepEqual(ids(of([], [mine("77", { status: "Cancelled", filledQty: 0.2, positionId: 555 })])), [["77"], []]);
  // Cancelled with nothing filled: final and dead.
  assert.deepEqual(ids(of([], [mine("77", { status: "Cancelled" })])), [["77"], ["77"]]);
  // Part filled and NOT final: the remainder is somewhere — whether or not the resting list shows it yet.
  assert.deepEqual(ids(of([], [mine("77", { status: "PartiallyFilled", filledQty: 0.2, positionId: 555 })])), [[], []]);
  assert.deepEqual(ids(of([mine("77", { status: "Part Filled", filledQty: 0.2, positionId: 555 })], [])), [[], []]);
  // The history calls it final and the resting list still shows it: not final until the list lets go.
  assert.deepEqual(ids(of([mine("77")], [mine("77", { status: "Cancelled" })])), [[], []]);
  // A refused first attempt and a filled second: each by its own row.
  assert.deepEqual(ids(of([], [mine("77", { status: "Refused" }), mine("78", { status: "Filled", filledQty: 0.01, qty: 0.01, positionId: 555 })])), [["77", "78"], ["77"]]);
  // The refused attempt is final and the order the broker took is not in the history yet: 78 is NOT final.
  assert.deepEqual(ids(of([], [mine("77", { status: "Refused" })])), [["77"], ["77"]]);
  // A first attempt whose status says nothing ("Unplaced") beside a taken order that was cancelled: the
  // taken order is dead by its own row — "every row is dead" is false, and is not what is asked.
  const sib = of([], [mine("77", { status: "Unplaced" }), mine("78", { status: "Cancelled" })]);
  assert.deepEqual([sib.finalIds, sib.deadIds, sib.unfinished, sib.dead], [["78"], ["78"], ["77"], false]);
  // Nothing seen, or only the resting list readable: nothing is final without the history.
  assert.deepEqual(ids(of([], [])), [[], []]);
  assert.deepEqual([ourOrders(orders(mine("77")), null, who())!.finalIds, ourOrders(orders(), null, who())!.finalIds], [[], []]);
});

test("what the history says about a position: closed since this order went in, or never this order's alone — on the broker's own clock", () => {
  const T = 1_790_000_000_000;                                                           // when the broker says this call's order was created
  const mine = (id: string, o: Record<string, unknown> = {}) => order(id, { strategyId: TAG, status: "Filled", filledQty: 0.5, positionId: 555, createdDate: T, lastModified: T + 400, ...o });
  const other = (id: string, o: Record<string, unknown> = {}) => order(id, { status: "Filled", filledQty: 0.5, positionId: 555, createdDate: T + 5_000, lastModified: T + 5_000, ...o });
  const past = (...rows: unknown[][]) => positionPast(orders(...rows), "555", { tag: TAG, orderIds: ["77"], side: "buy", instrId: "278" });
  // This call's own entry — by id, or by label — is neither.
  assert.deepEqual(past(mine("77")), { closed: false, shared: false });
  assert.deepEqual(past(order("77", { status: "Filled", filledQty: 0.5, positionId: 555, createdDate: T })), { closed: false, shared: false });      // by id, label lost
  assert.deepEqual(past(mine("90")), { closed: false, shared: false });                                                                            // by label, another attempt
  // Its stop executed after it went in: closed.
  assert.deepEqual(past(mine("77"), other("78", { side: "sell", type: "stop", createdDate: T + 450, lastModified: T + 60_000 })), { closed: true, shared: false });
  // (Its stop is made the instant the position opens — which can be a moment before the entry's own row was last touched. Still after the entry was CREATED.)
  assert.deepEqual(past(mine("77"), other("78", { side: "sell", type: "stop", createdDate: T + 200, lastModified: T + 60_000 })), { closed: true, shared: false });
  // A stop that was cancelled, or is tied to another position, closed nothing.
  assert.deepEqual(past(mine("77"), other("78", { side: "sell", type: "stop", status: "Cancelled", filledQty: 0 }), other("79", { side: "sell", positionId: 556 })), { closed: false, shared: false });
  // Somebody else's order went into the same position the same way — before or after: the account nets.
  assert.deepEqual(past(mine("77"), other("M1", { createdDate: T - 3_600_000, lastModified: T - 3_600_000 })), { closed: false, shared: true });
  assert.deepEqual(past(mine("77"), other("M2")), { closed: false, shared: true });
  // An order the other way, tied to the position, from BEFORE this call's order existed: the position was there first.
  assert.deepEqual(past(mine("77"), other("M3", { side: "sell", createdDate: T - 3_600_000, lastModified: T - 3_600_000 })), { closed: false, shared: true });
  // …and "before" is by when the order was CREATED: a resting sell made an hour earlier that executed just now was still there first.
  assert.deepEqual(past(mine("77"), other("M4", { side: "sell", createdDate: T - 3_600_000, lastModified: T + 9_000 })), { closed: false, shared: true });
  // THE BROKER'S CLOCK AGAINST ITS OWN. The whole history is a minute behind this desk (T is "a minute ago"
  // here): the stop that hit three seconds after the fill is still AFTER the entry. (Measured against the
  // desk's clock, it read as "traded against before the call" — and switched GEN FX off on the account.)
  assert.deepEqual(past(mine("77", { createdDate: T - 60_000, lastModified: T - 59_600 }), other("78", { side: "sell", type: "stop", createdDate: T - 59_500, lastModified: T - 57_000 })), { closed: true, shared: false });
  // Until this call's own entry is in the history there is nothing to measure an order the other way against: neither.
  assert.deepEqual(past(other("78", { side: "sell", type: "stop" })), { closed: false, shared: false });
  // A CLOSING ORDER TIED TO NO POSITION — not every broker ties one to what it closed. On this instrument,
  // the other way, executed since the entry: closed. Before the entry, another instrument, or the same way: nothing.
  assert.deepEqual(past(mine("77"), other("C1", { side: "sell", positionId: 0, lastModified: T + 30_000 })), { closed: true, shared: false });
  assert.deepEqual(past(mine("77"), other("C2", { side: "sell", positionId: 0, createdDate: T - 9_000, lastModified: T - 8_000 })), { closed: false, shared: false });
  assert.deepEqual(past(mine("77"), other("C3", { side: "sell", positionId: 0, tradableInstrumentId: 1 })), { closed: false, shared: false });
  assert.deepEqual(past(mine("77"), other("C4", { side: "buy", positionId: 0 })), { closed: false, shared: false });
  assert.deepEqual(positionPast(orders(mine("77"), other("C1", { side: "sell", positionId: 0 })), "555", { tag: TAG, orderIds: ["77"], side: "buy", instrId: null }), { closed: false, shared: false });      // instrument unknown: not counted
  // A side that cannot be read is evidence of neither.
  assert.deepEqual(past(mine("77"), other("X", { side: "" })), { closed: false, shared: false });
  // No history, no answer.
  assert.equal(positionPast(null, "555", { tag: TAG, orderIds: ["77"], side: "buy", instrId: "278" }), null);
  assert.equal(positionPast(unnamed(orders(mine("77"))), "555", { tag: TAG, orderIds: ["77"], side: "buy", instrId: "278" }), null);
});

test("an order found by its id that does not carry the label it was sent with: the broker is not giving labels back", () => {
  assert.equal(ourOrders(orders(order("77", { strategyId: TAG })), orders(), who({ orderId: "77" }))!.labelLost, false);
  assert.equal(ourOrders(orders(order("77", { strategyId: "" })), orders(), who({ orderId: "77" }))!.labelLost, true);
  assert.equal(ourOrders(orders(), orders(order("77", { strategyId: TAG.slice(0, 20), status: "Filled" })), who({ orderId: "77" }))!.labelLost, true);      // cut short
  assert.equal(ourOrders(orders(order("77", { strategyId: ` ${TAG.toUpperCase()}` })), orders(), who({ orderId: "77" }))!.labelLost, false);                // case and spaces are not a loss
  // Found by label alone, there is nothing to compare.
  assert.equal(ourOrders(orders(order("77", { strategyId: TAG })), orders(), who())!.labelLost, false);
});

test("an unlabelled order that could be a lost send: resting on this pair and side, created since — and nothing else", () => {
  const since = 1_790_000_000_000;
  const list = orders(
    order("old", { createdDate: since - 60_000 }),                                  // the member's own, there before the call
    order("new", { createdDate: since + 5_000 }),                                   // could be it
    order("undated", { createdDate: "" }),                                          // no time: could be it
    order("stop", { type: "stop", createdDate: since + 5_000 }),                    // a stop entry is an entry
    order("else", { createdDate: since + 5_000, strategyId: "AURIC:1" }),           // somebody else's label: theirs
    order("ours", { createdDate: since + 5_000, strategyId: TAG }),                 // labelled: found the proper way, not a suspect
    order("sell", { createdDate: since + 5_000, side: "sell" }),
    order("gold", { createdDate: since + 5_000, tradableInstrumentId: 1 }),
    order("leg", { createdDate: since + 5_000, positionId: 555 }),                  // a position's protection
    order("done", { createdDate: since + 5_000, status: "Cancelled" }),
    order("blind", { createdDate: since + 5_000, side: "" }),                       // a side nobody can read: could be it
  );
  assert.deepEqual(restingSuspects(list, { instrId: "278", side: "buy", sinceMs: since }), ["new", "undated", "stop", "blind"]);
});

test("the clocks agree with each other: nothing can arrive after the look that would call it gone", () => {
  // No attempt starts after the send deadline; fifteen seconds to abandon it, and a relay's own twenty.
  assert.ok(LAST_ARRIVAL_MS >= SEND_DEADLINE_MS + 20_000);
  // A claim is first looked at after the last moment its order could have arrived…
  assert.ok(CLAIM_DEAD_MS >= LAST_ARRIVAL_MS);
  // …and two clean looks, ten seconds apart or more, fit between that moment and the write-off.
  assert.ok(NO_TRACE_VOID_MS - LAST_ARRIVAL_MS >= 60_000);
});

test("nothing is concluded from orders that cannot be read", () => {
  assert.equal(ourOrders(null, orders(), who()), null);
  assert.equal(ourOrders(unnamed(orders(order("77", { strategyId: TAG }))), orders(), who()), null);
  // A row carrying the label whose side cannot be read: entry or protection? Not known.
  assert.equal(ourOrders(orders(order("77", { strategyId: TAG, side: "" })), orders(), who()), null);
  // The history is optional — but the answer says whether it was part of it.
  const noHist = ourOrders(orders(), null, who())!;
  assert.deepEqual([noHist.seen, noHist.history], [0, false]);
  assert.equal(ourOrders(orders(), unnamed(orders(order("77", { strategyId: TAG, status: "Filled" }))), who())!.history, false);
  assert.equal(ourOrders(orders(), orders(), who())!.history, true);
});

test("positions: read with their label and opening time, or not at all", () => {
  const list = readPositions(positions(position("555", { strategyId: TAG, openDate: 1_790_000_000_000 }), position("556", { side: "sell", qty: 1.2, openDate: 1_790_000_100_000 })))!;
  assert.deepEqual(list.map((p) => [p.id, p.instrId, p.side, p.qty, p.tag, p.openedMs]), [["555", "278", "buy", 0.5, TAG, 1_790_000_000_000], ["556", "278", "sell", 1.2, "", 1_790_000_100_000]]);
  assert.equal(readPositions(positions())!.length, 0);
  assert.equal(readPositions(unnamed(positions(position("555")))), null);
  assert.equal(readPositions(null), null);
  assert.equal(readPositions(positions(position(""))), null);                              // a row without an id was not read
  assert.equal(readPositions(positions(position("1", { openDate: 1_790_000_000 })))![0].openedMs, 1_790_000_000_000);   // seconds
});

test("a position that could be the fill, though nothing says so, holds the account — it is never adopted", () => {
  const since = 1_790_000_000_000;
  const list = readPositions(positions(
    position("old", { openDate: since - 60_000 }),                          // the member's own, opened before the call
    position("new", { openDate: since + 5_000 }),                           // unlabelled, opened since: could be it
    position("else", { openDate: since + 5_000, strategyId: "AURIC:1" }),   // somebody else's label: theirs
    position("sell", { openDate: since + 5_000, side: "sell" }),
    position("gold", { openDate: since + 5_000, tradableInstrumentId: 1 }),
    position("known", { openDate: since + 5_000 }),                         // already in the ledger
    position("undated", { openDate: "" }),                                  // no time: could be it
    position("sizeless", { openDate: since + 5_000, qty: "" }),             // a size nobody can read is not a "no"
    position("sideless", { openDate: since + 5_000, side: "" }),            // nor a side
    position("nowhere", { openDate: since + 5_000, tradableInstrumentId: "" }),   // nor an instrument
  ))!;
  const got = suspects(list, { instrId: "278", side: "buy", sinceMs: since }, new Set(["known"])).map((p) => p.id);
  assert.deepEqual(got, ["new", "undated", "sizeless", "sideless", "nowhere"]);
});

test("a row that cannot be settled is looked at less and less often", () => {
  assert.equal(recheckDelayMs(0), 0);
  assert.equal(recheckDelayMs(9), 0);
  assert.equal(recheckDelayMs(10), 120_000);
  assert.equal(recheckDelayMs(39), 120_000);
  assert.equal(recheckDelayMs(40), 600_000);
});

test("at placement, the position an order names is believed only from a row that EXECUTED — by the status's whole word", () => {
  // This is where a call's row gets its position id, and from then on the books treat it as a fill.
  const h = (status: string, o: Record<string, unknown> = {}) => [order("77", { status, positionId: 555, ...o })];
  assert.equal(positionForOrder(h("Filled", { filledQty: 0.5 }), orderCols, "77", true), "555");
  for (const status of ["Partially Filled", "PartiallyFilled", "Part Filled"]) assert.equal(positionForOrder(h(status), orderCols, "77", true), "555", status);
  assert.equal(positionForOrder(h("New", { filledQty: 0.2 }), orderCols, "77", true), "555");          // a filled quantity is execution, whatever the status reads
  // Not executed — and a status that only CONTAINS "fill" is not "filled".
  for (const status of ["New", "Cancelled", "Unfilled", "Fill Pending", ""]) assert.equal(positionForOrder(h(status), orderCols, "77", true), null, status);
  // Another order's row says nothing about this one.
  assert.equal(positionForOrder(h("Filled", { filledQty: 0.5 }), orderCols, "78", true), null);
  // Gold's orders carry no label and read as they always have: the row's position, executed or not.
  assert.equal(positionForOrder(h("New"), orderCols, "77"), "555");
});
