import test from "node:test";
import assert from "node:assert/strict";
import { activePipSize, activeQuote, breakEvenPosition, parseOpenPositions, parseTradeAction, partialQuantity, positionRevision, tradeView, type BrokerPosition } from "../src/lib/floor/activeTradeModel";
import { executePositionAction, type PositionActionPort } from "../src/lib/floor/positionAction";
import { ownedTradeAccount, writePartialReference, clearPartialReference } from "../src/lib/floor/activeTrades";
import type { ActiveTradeActionRequest, ActiveTradeScope } from "../src/lib/floor/activeTradeTypes";
import type { TLInstrumentSpec } from "../command-center/adapters/tradelocker";
import type { PartialIntent } from "../src/lib/flow/partialOperation";

const scope: ActiveTradeScope = { accountId: "fixture-account", environment: "demo" };
const position: BrokerPosition = { id: "fixture-position", instrumentId: "fixture-gold", symbol: "XAUUSD", side: "buy", qty: 1, entry: 2400, stop: 2390, target: 2420, stopKnown: true };
const spec: TLInstrumentSpec = { tradableInstrumentId: "fixture-gold", routeId: "fixture-info", name: "XAUUSD", lotStep: .01, minLot: .01, maxLot: 100, tickSize: .01, tickValue: 1, contractSize: 100, pricePrecision: 2, quantityPrecision: 2, currency: "USD" };
const quote = () => activeQuote({ bid: 2402, ask: 2402.2 }, Date.now());
const view = (p = position) => tradeView(scope, p, p.symbol, quote(), spec, [{}], "available");
const action = (kind: ActiveTradeActionRequest["action"], fraction: .25 | .5 = .5): ActiveTradeActionRequest => ({ ...scope, positionId: position.id, action: kind, revision: positionRevision(scope, position), confirm: true, ...(kind === "partial" ? { fraction } : {}) });

test("positions require named columns, exact sides and membership; malformed data cannot look like no trades", () => {
  const keys = ["side", "id", "qty", "tradableInstrumentId", "avgPrice", "stopLossId"];
  const config = { d: { positionsConfig: { columns: keys.map((id) => ({ id })) } } };
  const row = ["SELL", "p", .2, "i", 150, 0];
  assert.equal(parseOpenPositions([row], config, scope.accountId)[0].side, "sell");
  assert.equal(parseOpenPositions([row], config, scope.accountId)[0].stopKnown, true);
  assert.throws(() => parseOpenPositions([row], {}, scope.accountId));
  const valid = { id: "p", tradableInstrumentId: "i", qty: 1, side: "buy", avgPrice: 2400, stopLoss: 2390 };
  assert.throws(() => parseOpenPositions([{ ...valid, accountId: "somebody-else" }], {}, scope.accountId));
  assert.throws(() => parseOpenPositions([{ ...valid, side: "unknown" }], {}, scope.accountId));
  assert.throws(() => parseOpenPositions([valid, valid], {}, scope.accountId));
  assert.equal(parseOpenPositions([{ ...valid, stopLoss: "unreadable" }], {}, scope.accountId)[0].stopKnown, false);
});

test("linked stop orders, including missing or ambiguous proof, govern whether BE is safe", () => {
  const raw = { id: "p", tradableInstrumentId: "i", qty: 1, side: "buy", avgPrice: 2400, stopLossId: "sl" };
  const stop = { id: "sl", positionId: "p", type: "stop", status: "New", stopPrice: 2401 };
  assert.equal(parseOpenPositions([raw], {}, scope.accountId, [stop])[0].stop, 2401);
  assert.equal(parseOpenPositions([raw], {}, scope.accountId, null)[0].stopKnown, false);
  assert.equal(parseOpenPositions([raw], {}, scope.accountId, [stop, { ...stop, stopPrice: 2403 }])[0].stopKnown, false);
});

test("running pips use the side's closing quote and known symbol pip scales, never absolute movement", () => {
  assert.equal(view().pips, 20);
  assert.equal(view({ ...position, side: "sell" }).pips, -22);
  const yen = tradeView(scope, { ...position, symbol: "USDJPY", entry: 150 }, "USDJPY", activeQuote({ bid: 150.1, ask: 150.11 }, Date.now()), spec, [{}], "available");
  assert.equal(yen.pips, 10);
  assert.equal(activePipSize("EUR/USD"), .0001);
  assert.equal(activePipSize("EURUSD.pro"), .0001);
  assert.equal(activePipSize("XAUUSD.r"), .1);
  assert.equal(activePipSize("GOLDMINER"), null);
  assert.equal(activePipSize("some-stock"), null);
  assert.equal(activePipSize("DOGEUSD"), null);
  assert.equal(view({ ...position, symbol: "some-stock" }).pips, null);
});

test("stale, crossed or one-sided quotes remove pips and partial/BE, while verified close remains possible", () => {
  assert.equal(activeQuote({ bid: 4, ask: 3 }, Date.now()).state, "unavailable");
  assert.equal(activeQuote({ bid: 4, ask: null }, Date.now()).state, "unavailable");
  assert.equal(activeQuote({ bid: 4, ask: 5, raw: { d: { timestamp: Date.now() - 31_000 } } }, Date.now()).state, "unavailable");
  const old = { ...quote(), at: new Date(Date.now() - 31_000).toISOString() };
  const stale = tradeView(scope, position, "XAUUSD", old, spec, [{}], "available");
  assert.equal(stale.pips, null);
  assert.equal(stale.actions.close.allowed, true);
  assert.equal(stale.actions.partial[0].allowed, false);
  assert.equal(stale.actions.breakeven.allowed, false);
});

test("partials respect the broker's exact lot step, minimum slice and minimum remaining position", () => {
  assert.deepEqual(partialQuantity(.10, .25, spec), { allowed: true, reason: null, qty: .02 });
  assert.deepEqual(partialQuantity(.006, .5, { ...spec, lotStep: .001, minLot: .001 }), { allowed: true, reason: null, qty: .003 });
  assert.equal(partialQuantity(.01, .5, spec).allowed, false);
  assert.equal(partialQuantity(.015, .5, spec).allowed, false);
  assert.equal(partialQuantity(.04, .25, { ...spec, minLot: .02 }).allowed, false);
  assert.equal(partialQuantity(1, .5, null).allowed, false);
});

test("BE preserves the five-pip cushion, refuses tighter stops on either side and respects both stop permissions", () => {
  assert.equal(breakEvenPosition(position, "XAUUSD", quote(), spec).stop, 2400.5);
  assert.equal(breakEvenPosition({ ...position, stop: 2401 }, "XAUUSD", quote(), spec).allowed, false);
  assert.equal(breakEvenPosition({ ...position, side: "sell", stop: 2399 }, "XAUUSD", activeQuote({ bid: 2397.9, ask: 2398 }, Date.now()), spec).allowed, false);
  assert.equal(breakEvenPosition({ ...position, stopKnown: false }, "XAUUSD", quote(), spec).allowed, false);
  assert.equal(tradeView(scope, position, "XAUUSD", quote(), spec, [{ permissions: { allow_stop_move: false } }], "available").actions.breakeven.allowed, false);
});

test("review identity binds account, environment, position, side, quantity and entry; explicit confirmation is required", () => {
  const revision = positionRevision(scope, position);
  for (const changed of [{ ...position, qty: .9 }, { ...position, entry: 2401 }, { ...position, side: "sell" as const }]) assert.notEqual(positionRevision(scope, changed), revision);
  assert.notEqual(positionRevision({ ...scope, environment: "live" }, position), revision);
  assert.equal(parseTradeAction({ ...action("close"), confirm: false }), null);
  assert.equal(parseTradeAction({ ...action("partial"), fraction: 1 }), null);
  assert.equal(parseTradeAction({ ...action("close"), environment: "guess" }), null);
  assert.equal((parseTradeAction({ ...action("partial"), qty: 999, stop: 2 }) as unknown as Record<string, unknown>).qty, undefined);
});

function sandbox(options: { settle?: boolean; uncertain?: boolean; expire?: boolean } = {}) {
  let qty = 1, stop = 2390, open = true, reservation: PartialIntent | null = null, reads = 0, sends = 0, releases = 0;
  let permission = true;
  const port: PositionActionPort = {
    now: Date.now,
    async read() { reads++; const trade = open ? view({ ...position, qty, stop }) : null; if (trade && !permission) trade.actions.partial.forEach((plan) => { plan.allowed = false; plan.reason = "switched off"; }); return { trade, observedAt: Date.now() - (options.expire ? 6000 : 0) }; },
    async close(amount) { sends++; if (options.settle) { if (amount) qty -= amount; else open = false; } return options.uncertain ? { ok: false, uncertain: true } : { ok: true }; },
    async modify(price) { sends++; if (options.settle) stop = price; return { ok: true }; },
    partialStore: { async reserve(intent) { const created = reservation == null; reservation ??= intent; return { created, intent: reservation }; } },
    async releasePartial() { releases++; reservation = null; },
  };
  return { port, count: () => ({ sends, reads, releases }), block() { permission = false; }, tighter() { stop = 2401; } };
}

test("a broker acknowledgement is pending until the exact close or stop is read back", async () => {
  assert.equal((await executePositionAction(action("close"), sandbox().port)).body.state, "pending");
  assert.equal((await executePositionAction(action("close"), sandbox({ settle: true }).port)).body.state, "confirmed");
  assert.equal((await executePositionAction(action("breakeven"), sandbox().port)).body.state, "pending");
  assert.equal((await executePositionAction(action("breakeven"), sandbox({ settle: true }).port)).body.state, "confirmed");
});

test("stale review, expired position read and a stop tightened before dispatch never mutate", async () => {
  const stale = sandbox();
  assert.equal((await executePositionAction({ ...action("close"), revision: "a".repeat(32) }, stale.port)).body.state, "refused");
  assert.equal(stale.count().sends, 0);
  const expired = sandbox({ expire: true });
  assert.equal((await executePositionAction(action("close"), expired.port)).body.state, "refused");
  assert.equal(expired.count().sends, 0);
  const moved = sandbox(); const original = moved.port.read; let calls = 0;
  moved.port.read = async () => { if (++calls === 2) moved.tighter(); return original(); };
  assert.equal((await executePositionAction(action("breakeven"), moved.port)).body.state, "refused");
  assert.equal(moved.count().sends, 0);
});

test("unknown and concurrent partial attempts keep one durable reservation and dispatch at most one slice", async () => {
  const pending = sandbox({ uncertain: true });
  const answers = await Promise.all([executePositionAction(action("partial"), pending.port), executePositionAction(action("partial"), pending.port)]);
  assert.ok(answers.every((answer) => answer.body.state === "pending"));
  assert.equal(pending.count().sends, 1);
  assert.equal((await executePositionAction(action("partial"), pending.port)).body.state, "pending");
  assert.equal(pending.count().sends, 1);
  assert.equal(pending.count().releases, 0);
  const confirmed = sandbox({ settle: true });
  assert.equal((await executePositionAction(action("partial"), confirmed.port)).body.state, "confirmed");
  assert.equal(confirmed.count().sends, 1);
});

test("permissions revoked after reservation prevent the send and release only the unused reservation", async () => {
  const fixture = sandbox(); const reserve = fixture.port.partialStore.reserve;
  fixture.port.partialStore.reserve = async (intent) => { const r = await reserve(intent); fixture.block(); return r; };
  assert.equal((await executePositionAction(action("partial"), fixture.port)).body.state, "refused");
  assert.equal(fixture.count().sends, 0);
  assert.equal(fixture.count().releases, 1);
});

type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>) {
  const writes: { table: string; patch: Row; filters: [string, unknown][] }[] = [];
  const db = { from(table: string) {
    const filters: [string, unknown][] = []; let patch: Row | null = null;
    const selected = () => (tables[table] ?? []).filter((row) => filters.every(([key, value]) => key === "or" ? row.partial_done == null || row.partial_done === false : Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
    const answer = () => { const data = selected(); if (patch) { writes.push({ table, patch, filters }); for (const row of data) Object.assign(row, patch); } return { error: null, data }; };
    const query = {
      select() { return query; }, eq(key: string, value: unknown) { filters.push([key, value]); return query; },
      in(key: string, values: unknown[]) { filters.push([key, values]); return query; }, limit() { return query; },
      or(value: string) { filters.push(["or", value]); return query; },
      update(value: Row) { patch = value; return query; },
      async maybeSingle() { return { error: null, data: selected()[0] ?? null }; },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve(answer()).then(resolve); },
    }; return query;
  } } as unknown as Parameters<typeof ownedTradeAccount>[0];
  return { db, writes };
}
const ownTables = () => ({
  profiles: [{ id: "member", status: "active", role: "member" }],
  flow_broker_accounts: [{ user_id: "member", account_id: scope.accountId, connection_id: "connection", environment: "demo", acc_num: "7" }],
  flow_broker_connections: [{ user_id: "member", id: "connection", environment: "demo", status: "connected" }],
});
test("the account and the connection both require the signed-in owner, matching environment, and an approved membership", async () => {
  assert.equal((await ownedTradeAccount(fakeDb(ownTables()).db, "member", scope)).row.acc_num, "7");
  await assert.rejects(() => ownedTradeAccount(fakeDb(ownTables()).db, "other-user", scope));
  await assert.rejects(() => ownedTradeAccount(fakeDb(ownTables()).db, "member", { ...scope, environment: "live" }));
  const foreignConnection = ownTables(); foreignConnection.flow_broker_connections[0].user_id = "other-user";
  await assert.rejects(() => ownedTradeAccount(fakeDb(foreignConnection).db, "member", scope));
  const pending = ownTables(); pending.profiles[0].status = "pending";
  await assert.rejects(() => ownedTradeAccount(fakeDb(pending).db, "member", scope));
});

test("partial accounting persists the dispatch reference and exact slice, scoped to the owner and position, without inventing a fill", async () => {
  const { db, writes } = fakeDb({});
  assert.equal(await writePartialReference(db, "member", scope, position.id, { before_qty: .1, requested_qty: .02 }, 2402), true);
  assert.deepEqual(writes[0].patch, { partial_px: 2402, partial_frac: .2 });
  assert.deepEqual(writes[0].filters, [["user_id", "member"], ["environment", "demo"], ["account_id", scope.accountId], ["position_id", position.id], ["status", "open"]]);
  assert.equal(await writePartialReference(db, "member", scope, position.id, { before_qty: 1, requested_qty: .5 }, 2403, .5), true);
  assert.deepEqual(writes[1].patch, { partial_px: 2403, partial_frac: .5, partial_done: true, qty: .5 });
  assert.equal(await writePartialReference(db, "member", scope, position.id, { before_qty: 1, requested_qty: .5 }, NaN, .5), false);
  assert.equal(writes.length, 2);
});

test("a definite refusal clears its reference without clearing a confirmed, newer or foreign partial", async () => {
  const own = { user_id: "member", environment: "demo", account_id: scope.accountId, position_id: position.id, status: "open", partial_px: 2402, partial_frac: .5, partial_done: false };
  const rows = [{ ...own }, { ...own, partial_px: 2403 }, { ...own, partial_done: true }, { ...own, user_id: "other" }];
  const { db } = fakeDb({ flow_managed_positions: rows });
  assert.equal(await clearPartialReference(db, "member", scope, position.id, 2402, .5), true);
  assert.equal(rows[0].partial_px, null);
  assert.equal(rows[0].partial_frac, null);
  assert.equal(rows[1].partial_px, 2403);
  assert.equal(rows[2].partial_px, 2402);
  assert.equal(rows[3].partial_px, 2402);
});
