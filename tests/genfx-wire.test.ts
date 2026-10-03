import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb, type Row, type FakeDb } from "./_genfx_fakedb";
import { ORDER_COLS, POSITION_COLS, order, position } from "./_genfx_broker";

/*
 * THE REAL ORDER PATH, END TO END. Everything else in the GEN FX tests hands placement and the books a
 * pretend broker one layer up. Here nothing is pretended above the network: placement's own desk
 * (place.deskIo), the desk's one order function (executor.placeFixedLotFollower), the broker client
 * (tradelocker.createOrder and its request scheduler, relay and all) and the books pass's own broker
 * reads (settle.brokerIo) all run as they do in production, against a small TradeLocker that lives in
 * `fetch`. Only the login and the market-data reads are stood in for.
 *
 * What is held here is what no other test can see: that the label, the size, the cap and the deadline
 * actually reach the wire; that one send is one order when a relay fails; and that what the books pass
 * reads back off the wire is enough to finish the job.
 *
 * The broker client reads its relay settings when it is loaded, so they are set first, and everything
 * that touches it is imported inside the tests.
 */
process.env.BROKER_RELAYS = "https://relay.test";
process.env.BROKER_RELAY_SECRET = "s3cret";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;          // the order function's own activity log has no database here, and says nothing

const HOST = "https://demo.tradelocker.com/backend-api";
type Req = { path: string; method: string; body: Record<string, unknown> | null; via: "relay" | "direct"; at: number };
type Reply = { status: number; body: unknown };
const ok = (d: unknown): Reply => ({ status: 200, body: { s: "ok", d } });
const refused = (errmsg: string): Reply => ({ status: 200, body: { s: "error", errmsg } });
// (A 204 carries no body — a Response cannot be built with one. The first version of this stub tried, and
//  so every stop change on a DIRECT-routed account threw inside the stub rather than in the code under test.)
const json = (status: number, obj: unknown) => new Response(status === 204 || status === 304 ? null : typeof obj === "string" ? obj : JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/** A TradeLocker account that remembers what it was sent and answers the way the real one does: bare array rows, names in /trade/config. */
class Broker {
  reqs: Req[] = [];
  working: unknown[][] = [];
  history: unknown[][] = [];
  positions: unknown[][] = [];
  seq = 700;
  bid = 1.0841; ask = 1.08412;
  instrument: Record<string, unknown> = { tradableInstrumentId: 278, name: "EURUSD", routes: [{ id: 1, type: "TRADE" }, { id: 2, type: "INFO" }] };
  historyCols = ORDER_COLS;
  /** What to do with an order: the default accepts it and fills it at once. Return a Reply to answer; mutate the lists to show the result. */
  onOrder: (body: Record<string, unknown>, n: number, self: Broker) => Reply | Promise<Reply> = (body, _n, self) => self.fill(body);
  /** What a relay answers AFTER it forwarded the request (the broker has already acted on it). Null: the broker's own reply. */
  relayAfter: (req: Req, n: number) => Response | null = () => null;
  /** What a relay answers INSTEAD of forwarding the request (nothing reaches the broker through it). Null: it forwards. */
  relayInstead: (path: string, method: string) => Response | null = () => null;
  /** Thrown by the network for a path (before anything is sent). */
  dead: (path: string) => boolean = () => false;

  orderPosts() { return this.reqs.filter((r) => r.method === "POST" && r.path.endsWith("/orders")); }
  patches() { return this.reqs.filter((r) => r.method === "PATCH"); }
  deletes() { return this.reqs.filter((r) => r.method === "DELETE"); }

  accept(body: Record<string, unknown>, o: Record<string, unknown> = {}): { id: string; reply: Reply } {
    const id = String(++this.seq);
    this.working.push(order(id, { qty: body.qty, side: body.side, type: body.type, price: body.price, stopLoss: body.stopLoss ?? null, takeProfit: body.takeProfit ?? null, strategyId: body.strategyId ?? "", status: "New", ...o }));
    return { id, reply: ok({ orderId: id }) };
  }
  fill(body: Record<string, unknown>, o: { avg?: number; positionLabel?: unknown } = {}): Reply {
    const id = String(++this.seq), pid = `P${id}`;
    const avg = o.avg ?? this.ask;
    this.history.push(order(id, { qty: body.qty, side: body.side, type: body.type, price: body.price, strategyId: body.strategyId ?? "", status: "Filled", filledQty: body.qty, avgPrice: avg, positionId: pid, isOpen: false }));
    this.positions.push(position(pid, { qty: body.qty, side: body.side, avgPrice: avg, strategyId: o.positionLabel === undefined ? body.strategyId ?? "" : o.positionLabel, openDate: Date.now() }));
    return ok({ orderId: id });
  }

  async handle(path: string, method: string, body: Record<string, unknown> | null, via: Req["via"]): Promise<Reply> {
    const req: Req = { path, method, body, via, at: Date.now() };
    this.reqs.push(req);
    const cols = (names: string[]) => ({ columns: names.map((id) => ({ id })) });
    if (method === "GET" && path.endsWith("/instruments")) return ok({ instruments: [this.instrument] });
    if (method === "GET" && path.startsWith("/trade/quotes")) return ok({ bp: this.bid, ap: this.ask });
    if (method === "GET" && path === "/trade/config") return ok({ ordersConfig: cols(ORDER_COLS), ordersHistoryConfig: cols(this.historyCols), positionsConfig: cols(POSITION_COLS) });
    if (method === "GET" && path.endsWith("/ordersHistory")) return ok({ ordersHistory: this.history });
    if (method === "GET" && path.endsWith("/orders")) return ok({ orders: this.working });
    if (method === "GET" && path.endsWith("/positions")) return ok({ positions: this.positions });
    if (method === "POST" && path.endsWith("/orders")) return this.onOrder(body ?? {}, this.orderPosts().length, this);
    if (method === "PATCH" && path.startsWith("/trade/positions/")) return { status: 204, body: "" };
    if (method === "DELETE" && path.startsWith("/trade/orders/")) {
      const id = path.split("/").pop()!;
      const row = this.working.find((r) => String(r[0]) === id);
      if (!row) return { status: 404, body: { s: "error", errmsg: "order not found" } };
      this.working = this.working.filter((r) => r !== row);
      const done = [...row]; done[ORDER_COLS.indexOf("status")] = "Cancelled"; done[ORDER_COLS.indexOf("isOpen")] = false;
      this.history.push(done);
      return ok({});
    }
    return { status: 404, body: { s: "error", errmsg: `test broker: unhandled ${method} ${path}` } };
  }
}

const realFetch = globalThis.fetch;
function install(b: Broker): void {
  let relayed = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const parse = (s: unknown): Record<string, unknown> | null => { try { return s ? JSON.parse(String(s)) : null; } catch { return null; } };
    if (url.startsWith("https://relay.test")) {
      const outer = parse(init?.body) ?? {};
      const path = String(outer.path), method = String(outer.method).toUpperCase();
      if (b.dead(path)) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      const instead = b.relayInstead(path, method);
      if (instead) return instead;
      const r = await b.handle(path, method, parse(outer.body), "relay");
      const after = b.relayAfter(b.reqs[b.reqs.length - 1], ++relayed);
      return after ?? json(200, { status: r.status, text: typeof r.body === "string" ? r.body : JSON.stringify(r.body) });
    }
    if (url.startsWith(HOST)) {
      const path = url.slice(HOST.length);
      if (b.dead(path)) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      const r = await b.handle(path, String(init?.method ?? "GET").toUpperCase(), parse(init?.body), "direct");
      return json(r.status, r.body);
    }
    throw new Error(`test: unexpected network call ${url}`);
  }) as typeof fetch;
}

/** The modules under test, and two broker account numbers: one whose requests leave through the relay, one that goes direct. */
async function desk() {
  const tl = await import("../src/lib/flow/tradelocker");
  const ex = await import("../src/lib/flow/executor");
  const place = await import("../src/lib/genfx/place");
  const settle = await import("../src/lib/genfx/settle");
  const fills = await import("../src/lib/genfx/fills");
  const { GENFX_VERSION } = await import("../src/lib/genfx/control");
  const accNumVia = (route: number) => { for (let i = 1; i < 2000; i++) if (tl.pickRoute(`demo:${i}`, 2) === route) return String(i); return "1"; };
  return { tl, ex, place, settle, fills, GENFX_VERSION, relayAcc: accNumVia(1), directAcc: accNumVia(0) };
}
type Desk = Awaited<ReturnType<typeof desk>>;

let n = 0;
/** A database with one armed demo account, and placement's own desk with only the login and the market reads stood in for. */
function world(d: Desk, accNum: string) {
  const id = `W${++n}`;                                     // a fresh account and connection per test: the client caches instruments and settings by them
  const acct: Row = { user_id: "11111111-2222-3333-4444-555555555555", account_id: `A-${id}`, acc_num: accNum, connection_id: `c-${id}`, currency: "USD", risk_pct: 1, risk_mode: "aggressive", permissions: {}, kill_switch_at: null, style_quick: true, style_hold: true, style_swing: true, genfx_eurusd: true, genfx_gbpjpy: true };
  const db = fakeDb({
    genfx_control: [{ id: 1, scan_enabled: true, auto_enabled: true, auto_scope: "demo", billing_enabled: false, telegram_enabled: false, config: {}, replay_request: null }],
    flow_broker_accounts: [acct], flow_broker_connections: [{ id: acct.connection_id, environment: "demo", status: "connected" }],
    flow_trade_prefs: [], flow_managed_positions: [], genfx_fills: [], flow_account_reservations: [], flow_auto_events: [],
  }, { unique: {
    genfx_fills: [["signal_key", "account_id"], { cols: ["account_id", "pair", "side"], when: (r) => ["reserved", "sending", "placed", "uncertain", "cancelled"].includes(String(r.status)) }],
    flow_managed_positions: [{ cols: ["account_id", "position_id"], when: (r) => r.strategy_version === d.GENFX_VERSION && r.position_id != null }],
  } });
  const io = {
    ...d.place.deskIo,
    quiet: () => false, news: async () => false, price: async () => 1.0841, usdJpy: async () => 150,
    bars: async () => Array.from({ length: 60 }, () => ({ h: 1.0842, l: 1.084, c: 1.0841 })),
    login: async () => ({ token: "tok", env: "demo" as const }),
    accounts: async () => new Map([[String(acct.account_id), { equity: 10_000, currency: "USD" }]]),
  };
  const sig = { pair: "EURUSD" as const, signalKey: `zone:EURUSD:quick:buy:108400:2026100${n}`, side: "buy" as const, mode: "quick" as const, entryLow: 1.08397, entryHigh: 1.08403, stop: 1.0825, tp: 1.0872, setup: "zone" as const, alertId: null };
  const run = () => d.place.placeGenfx(sig, { admin: db as never, io });
  /** The books pass through its own broker reads, `laterMs` after now, with every row due. */
  const books = (laterMs = 0) => {
    for (const f of db.tables.genfx_fills) f.next_check_at = new Date(Date.now() - 1_000).toISOString();
    return d.settle.settleFills(db as never, Date.now() + laterMs, { ...d.settle.brokerIo(), login: async () => ({ token: "tok", env: "demo" as const }) });
  };
  return { db, acct, sig, run, books, tag: d.fills.fxTag(sig.signalKey, String(acct.account_id)), fill: () => db.tables.genfx_fills[0] };
}
const skips = (db: FakeDb) => db.tables.flow_auto_events.filter((e) => e.status === "skipped").map((e) => String(e.reason));

test("a call, through the real order function: the label, the size, the cap and the levels are on the wire — and the broker's own record puts the fill in the ledger", async () => {
  const d = await desk(), b = new Broker();
  install(b);
  try {
    const w = world(d, d.relayAcc);
    // The member's own resting SELL on this pair is there the whole time: not this side, not GEN FX's, never touched.
    b.working.push(order("M1", { side: "sell", price: 1.09 }));
    const rep = await w.run();
    assert.deepEqual([rep.placed, rep.skipped], [1, {}]);
    const posts = b.orderPosts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].via, "relay");
    assert.deepEqual(posts[0].body, {
      tradableInstrumentId: "278", routeId: "1", side: "buy", type: "limit", qty: 0.61, validity: "GTC",
      price: 1.08452,                                            // a quarter of the stop distance past this broker's ask — not the 0.8-to-1 cap (1.08511)
      stopLoss: 1.0825, stopLossType: "absolute", takeProfit: 1.0872, takeProfitType: "absolute",
      strategyId: w.tag,
    });
    assert.match(w.tag, /^gfx-[0-9a-f]{24}$/);
    // The row has the order's id, and the position the order's own EXECUTED history row names.
    assert.deepEqual([w.fill().status, w.fill().order_id, w.fill().position_id, w.fill().qty], ["placed", "701", "P701", 0.61]);
    assert.equal(w.db.tables.flow_managed_positions.length, 0);
    assert.equal(b.patches().length, 1);                         // the order function verified the brackets on that position
    // The books pass, reading the broker itself: into the ledger at the broker's price and size, and closed.
    const out = await w.books();
    assert.equal(out.managed, 1);
    const row = w.db.tables.flow_managed_positions[0];
    assert.deepEqual([row.position_id, row.symbol, row.side, row.entry, row.init_stop, row.tp1, row.qty, row.strategy_version, row.signal_id], ["P701", "EURUSD", "buy", 1.08412, 1.0825, 1.0872, 0.61, d.GENFX_VERSION, w.sig.signalKey]);
    assert.equal(w.fill().status, "managed");
    assert.deepEqual(b.patches().at(-1)!.body, { stopLoss: 1.0825, takeProfit: 1.0872 });     // its stop and target, put on again before the manager got it
    assert.deepEqual([b.deletes().length, b.working.length], [0, 1]);                          // the member's order is still there
  } finally { globalThis.fetch = realFetch; }
});

test("placement's own broker checks, on the wire: a resting entry the same way — a stop entry too — and a broker that keeps no labels", async () => {
  const d = await desk();
  try {
    // The member's own BUY STOP is resting on the pair: exposure the same way. Nothing is sent.
    const b = new Broker(); install(b);
    const w = world(d, d.directAcc);
    b.working.push(order("M1", { side: "buy", type: "stop", price: 1.09 }));
    assert.equal((await w.run()).placed, 0);
    assert.equal(b.orderPosts().length, 0);
    assert.match(skips(w.db).at(-1)!, /one_open \(resting EUR\/USD order\)/);
    // The order history has no label column on this broker: GEN FX could not find a filled order again. Nothing is sent.
    const b2 = new Broker(); install(b2);
    b2.historyCols = ORDER_COLS.filter((c) => c !== "strategyId");
    const w2 = world(d, d.directAcc);
    assert.equal((await w2.run()).placed, 0);
    assert.equal(b2.orderPosts().length, 0);
    assert.match(skips(w2.db).at(-1)!, /no_order_labels/);
    // The broker's instrument list says a lot of this pair is 1,000 units: the size would be a hundred times off.
    const b3 = new Broker(); install(b3);
    b3.instrument = { ...b3.instrument, contractSize: 1000 };
    const w3 = world(d, d.directAcc);
    assert.equal((await w3.run()).placed, 0);
    assert.match(skips(w3.db).at(-1)!, /contract_size/);
    assert.equal(b3.orderPosts().length, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("a relay that fails AFTER it forwarded the order: one send is one order — found again by its label, followed, and withdrawn when it has rested too long", async () => {
  const d = await desk(), b = new Broker();
  install(b);
  try {
    const w = world(d, d.relayAcc);
    // The market has moved away: the order is accepted and rests. The relay's own reply is lost.
    b.onOrder = (body, _n, self) => self.accept(body).reply;
    b.relayAfter = (req) => (req.method === "POST" && req.path.endsWith("/orders") ? json(502, { error: "upstream_failed" }) : null);
    const rep = await w.run();
    assert.deepEqual([rep.placed, rep.skipped.uncertain], [0, 1]);
    assert.equal(b.orderPosts().length, 1);                      // NOT sent a second time directly
    assert.deepEqual([w.fill().status, w.fill().order_id ?? null, w.fill().qty], ["uncertain", null, 0.61]);
    // The books pass asks the broker, and finds the order by the label it carried.
    b.relayAfter = () => null;
    assert.equal((await w.books()).waiting, 1);
    assert.deepEqual([w.fill().status, w.fill().order_id], ["placed", "701"]);
    assert.equal(b.deletes().length, 0);                         // inside its validity: left to rest
    // Three minutes on it is still resting: withdrawn, by its own id.
    assert.equal((await w.books(200_000)).cancelled, 1);
    assert.deepEqual([b.deletes().map((r) => r.path), w.fill().status], [["/trade/orders/701"], "cancelled"]);
    // Half a minute after the cancel the broker's history calls it cancelled, nothing filled: written off, and the account is free.
    assert.equal((await w.books(240_000)).voided, 1);
    assert.deepEqual([w.fill().status, w.db.tables.flow_managed_positions.length, w.db.tables.flow_account_reservations.length], ["void", 0, 0]);
  } finally { globalThis.fetch = realFetch; }
});

test("the broker refuses the target, the order goes again with the stop alone, and THAT send is lost: the refused first attempt does not write the call off", async () => {
  const d = await desk(), b = new Broker();
  install(b);
  try {
    const w = world(d, d.relayAcc);
    let second: unknown[] | null = null;
    b.onOrder = (body, n, self) => {
      if (n === 1) {
        // Refused in words — and listed in the history as refused, under the label.
        self.history.push(order(String(++self.seq), { qty: body.qty, strategyId: body.strategyId, status: "Refused", isOpen: false }));
        return refused("Take profit is not allowed for this instrument");
      }
      // The second lands and rests — but the broker's lists do not show it for a few seconds.
      const { reply } = self.accept(body);
      second = self.working.pop()!;
      return reply;
    };
    b.relayAfter = (req) => (req.method === "POST" && req.path.endsWith("/orders") && b.orderPosts().length === 2 ? json(502, { error: "upstream_failed" }) : null);
    const rep = await w.run();
    assert.equal(rep.skipped.uncertain, 1);
    const posts = b.orderPosts().map((r) => r.body!);
    assert.deepEqual(posts.map((p) => [p.strategyId, p.stopLoss, p.takeProfit ?? null]), [[w.tag, 1.0825, 1.0872], [w.tag, 1.0825, null]]);     // one label, the stop on both
    // Seconds later: the refused attempt is all the broker shows. The call is NOT written off, and the account stays held.
    b.relayAfter = () => null;
    const out = await w.books(3_000);
    assert.deepEqual([out.voided, w.fill().status, w.fill().order_id ?? null, w.db.tables.flow_account_reservations.length], [0, "uncertain", null, 1]);
    // The second order appears: taken over under ITS id.
    b.working.push(second!);
    await w.books(15_000);
    assert.deepEqual([w.fill().status, w.fill().order_id], ["placed", "702"]);
  } finally { globalThis.fetch = realFetch; }
});

test("the send deadline holds all the way down: a turn in the rate-limit queue, and the retry without the target, do not go out after it", async () => {
  const d = await desk();
  try {
    const opts = (accNum: string, o: Record<string, unknown> = {}) => ({ userId: "u1", env: "demo" as const, token: "tok", connId: `c-d${++n}`, accountId: `A-d${n}`, accNum, symbol: "EURUSD", side: "buy" as const, qty: 0.61, stop: 1.0825, tp: 1.0872, source: "genfx", maxEntry: 1.08452, tag: "gfx-0123456789abcdef01234567", notAfterMs: Date.now() + 45_000, ...o });
    // Already past: nothing is sent.
    const b = new Broker(); install(b);
    assert.deepEqual(await d.ex.placeFixedLotFollower(opts(d.directAcc, { notAfterMs: Date.now() - 1 })), { ok: false, reason: "entry_deadline_passed", deferred: false });
    assert.equal(b.orderPosts().length, 0);
    // The edge rate-limits every attempt (it never reaches the broker, so it is queued again). Once the
    // deadline has passed, the next turn in the queue is not taken: a refusal, in words, with nothing sent late.
    const b2 = new Broker(); install(b2);
    b2.onOrder = () => ({ status: 429, body: "error code: 1015 you are being rate limited" });
    const deadline = Date.now() + 350;
    const r2 = await d.ex.placeFixedLotFollower(opts(d.directAcc, { notAfterMs: deadline }));
    assert.deepEqual(r2, { ok: false, reason: "entry_deadline_passed", deferred: false });
    const sentAt = b2.orderPosts().map((r) => r.at);
    assert.ok(sentAt.length >= 1 && sentAt.length <= 4, String(sentAt.length));                 // tried, queued again — and stopped
    assert.ok(sentAt.every((t) => t <= deadline), JSON.stringify(sentAt.map((t) => t - deadline)));
    // The broker takes its time refusing the target; by then the deadline has passed. The stop-only retry is not sent.
    const b3 = new Broker(); install(b3);
    b3.onOrder = async () => { await new Promise((r) => setTimeout(r, 400)); return refused("Take profit is not allowed for this instrument"); };
    const r3 = await d.ex.placeFixedLotFollower(opts(d.directAcc, { notAfterMs: Date.now() + 300 }));
    assert.equal(r3.ok, false);
    assert.equal(b3.orderPosts().length, 1);
    // No deadline (gold): the retry goes, as it always has.
    const b4 = new Broker(); install(b4);
    b4.onOrder = async (body, k, self) => { if (k === 1) { await new Promise((r) => setTimeout(r, 50)); return refused("Take profit is not allowed for this instrument"); } return self.fill(body); };
    const r4 = await d.ex.placeFixedLotFollower(opts(d.directAcc, { tag: null, notAfterMs: null, source: "genx" }));
    assert.equal(r4.ok, true);
    assert.deepEqual(b4.orderPosts().map((r) => ["strategyId" in r.body!, r.body!.takeProfit ?? null]), [[false, 1.0872], [false, null]]);
  } finally { globalThis.fetch = realFetch; }
});

test("an order whose row has NOT executed names no position for a labelled order, and nothing is modified — an unlabelled order reads as it always did", async () => {
  const d = await desk();
  try {
    const opts = (o: Record<string, unknown> = {}) => ({ userId: "u1", env: "demo" as const, token: "tok", connId: `c-s${++n}`, accountId: `A-s${n}`, accNum: d.directAcc, symbol: "EURUSD", side: "buy" as const, qty: 0.5, stop: 1.0825, tp: 1.0872, source: "genfx", maxEntry: 1.08452, tag: "gfx-0123456789abcdef01234567", ...o });
    // The order rests. Its history row is "New", nothing filled — and carries a position id all the same
    // (an account that nets would name the position the order WOULD add to: somebody else's).
    const resting = (self: Broker, body: Record<string, unknown>) => { const id = String(++self.seq); self.history.push(order(id, { strategyId: body.strategyId ?? "", status: "New", filledQty: 0, positionId: 555 })); return ok({ orderId: id }); };
    const b = new Broker(); install(b);
    b.onOrder = (body, _k, self) => resting(self, body);
    assert.deepEqual(await d.ex.placeFixedLotFollower(opts()), { ok: true, orderId: "701", positionId: null, qty: 0.5 });
    assert.equal(b.patches().length, 0);                         // position 555 is not touched
    // An order with no label — gold's — is read exactly as before this change.
    const b2 = new Broker(); install(b2);
    b2.onOrder = (body, _k, self) => resting(self, body);
    assert.deepEqual(await d.ex.placeFixedLotFollower(opts({ tag: null, source: "genx" })), { ok: true, orderId: "701", positionId: "555", qty: 0.5 });
    assert.equal(b2.patches().length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("an error thrown BEFORE any order was attempted is marked as such; one thrown by the order itself is not", async () => {
  const d = await desk();
  try {
    const opts = (accNum: string) => ({ userId: "u1", env: "demo" as const, token: "tok", connId: `c-t${++n}`, accountId: `A-t${n}`, accNum, symbol: "EURUSD", side: "buy" as const, qty: 0.5, stop: 1.0825, tp: 1.0872, source: "genfx", maxEntry: 1.08452, tag: "gfx-0123456789abcdef01234567", notAfterMs: Date.now() + 45_000 });
    // The quote request dies on the network: no order was attempted.
    const b = new Broker(); install(b);
    b.dead = (path) => path.startsWith("/trade/quotes");
    const early = await d.ex.placeFixedLotFollower(opts(d.directAcc)).then(() => null, (e: unknown) => e as { noOrderSent?: boolean });
    assert.deepEqual([early?.noOrderSent, b.orderPosts().length], [true, 0]);
    // The relay loses its reply to the order: it may be on the account. No mark.
    const b2 = new Broker(); install(b2);
    b2.relayAfter = (req) => (req.method === "POST" && req.path.endsWith("/orders") ? json(502, { error: "upstream_failed" }) : null);
    const late = await d.ex.placeFixedLotFollower(opts(d.relayAcc)).then(() => null, (e: unknown) => e as Error & { noOrderSent?: boolean });
    assert.match(String(late?.message), /relay_outcome_unknown/);
    assert.deepEqual([late?.noOrderSent, b2.orderPosts().length], [undefined, 1]);
    // And through placement: the first leaves nothing behind; the second holds the account until the broker has been asked.
    const b3 = new Broker(); install(b3);
    b3.dead = (path) => path.startsWith("/trade/quotes");
    const w = world(d, d.directAcc);
    const rep = await w.run();
    // (Placement reads this broker's quote itself first; that failing only moves it to the feed's price.
    //  The order function's own quote then fails the same way, before any order.)
    assert.deepEqual([rep.placed, rep.skipped.broker_unreadable, w.db.tables.genfx_fills.length, w.db.tables.flow_account_reservations.length, b3.orderPosts().length], [0, 1, 0, 0, 0]);
  } finally { globalThis.fetch = realFetch; }
});

test("a relay's refusal is its own only when it says so: the same status from anything in front of it does not send the order twice", async () => {
  const d = await desk();
  try {
    const opts = () => ({ userId: "u1", env: "demo" as const, token: "tok", connId: `c-r${++n}`, accountId: `A-r${n}`, accNum: d.relayAcc, symbol: "EURUSD", side: "buy" as const, qty: 0.5, stop: 1.0825, tp: 1.0872, source: "genfx", maxEntry: 1.08452, tag: "gfx-0123456789abcdef01234567", notAfterMs: Date.now() + 45_000 });
    // A 503 with no relay error in it — a proxy in front of a relay that had already forwarded the order.
    for (const after of [() => json(503, "Service Unavailable"), () => json(404, { message: "no route" }), () => json(503, { error: "upstream connect error" })]) {
      const b = new Broker(); install(b);
      b.onOrder = (body, _k, self) => self.accept(body).reply;
      b.relayAfter = (req) => (req.method === "POST" && req.path.endsWith("/orders") ? after() : null);
      await assert.rejects(() => d.ex.placeFixedLotFollower(opts()), /relay_outcome_unknown/);
      assert.deepEqual([b.orderPosts().length, b.working.length], [1, 1]);                    // one order on the account, not two
    }
  } finally { globalThis.fetch = realFetch; }
});

test("the same call on an account whose requests leave DIRECTLY: the broker's bare 204 to a stop change is a yes, there too", async () => {
  // (Until the third review every wire test that changed a stop ran through the relay, which wraps the
  //  broker's reply in JSON. The bracket check after an order, and the books' own "put the stop on again",
  //  had never been run against the broker's real answer: 204, no body.)
  const d = await desk(), b = new Broker();
  install(b);
  try {
    const w = world(d, d.directAcc);
    const rep = await w.run();
    assert.deepEqual([rep.placed, rep.skipped], [1, {}]);
    assert.deepEqual([b.orderPosts().length, b.orderPosts()[0].via, b.patches().length, b.patches()[0].via], [1, "direct", 1, "direct"]);
    // The order function's note says nothing went wrong with the brackets.
    assert.ok(!w.db.tables.flow_auto_events.some((e) => /bracket verify|CHECK SL\/TP/.test(String(e.reason))));
    const out = await w.books();
    assert.deepEqual([out.managed, w.fill().status, w.fill().protect_tries, w.db.tables.flow_managed_positions.length], [1, "managed", 0, 1]);
    assert.deepEqual([b.patches().length, b.patches().at(-1)!.body], [2, { stopLoss: 1.0825, takeProfit: 1.0872 }]);
    assert.ok(!w.db.tables.flow_auto_events.some((e) => /would not take the target|could not be confirmed/.test(String(e.reason))));
  } finally { globalThis.fetch = realFetch; }
});

test("gold's orders go through a relay exactly as they always did: a refusal is not read, it is routed round", async () => {
  // GEN FX's orders carry a label and are sent at most once, so for THEM a relay's failure has to be told
  // apart: its own refusal (nothing was forwarded) from anything else (it may have been). Telling them
  // apart means reading the refusal's body. Every other request — gold's orders among them — must not
  // wait on that body, and must take a relay's answer as it always has. (The third version read it for all.)
  const d = await desk();
  try {
    const gold = () => ({ userId: "u1", env: "demo" as const, token: "tok", connId: `c-g${++n}`, accountId: `A-g${n}`, accNum: d.relayAcc, symbol: "EURUSD", side: "buy" as const, qty: 0.5, stop: 1.0825, tp: 1.0872, source: "genx" });
    const fx = () => ({ ...gold(), source: "genfx", maxEntry: 1.08452, tag: "gfx-0123456789abcdef01234567", notAfterMs: Date.now() + 45_000 });
    const isOrder = (path: string, method: string) => method === "POST" && path.endsWith("/orders");
    // A 503 whose body never arrives. Gold: straight to a direct send, nothing waited on.
    const stalled = () => new Response(new ReadableStream({ start() { /* the body never comes */ } }), { status: 503 });
    const b = new Broker(); install(b);
    b.relayInstead = (path, method) => (isOrder(path, method) ? stalled() : null);
    const t = Date.now();
    const r = await d.ex.placeFixedLotFollower(gold());
    assert.equal(r.ok, true);
    assert.ok(Date.now() - t < 3_000, `took ${Date.now() - t}ms`);                           // (the third version: fifteen seconds, then an aborted direct send that threw)
    assert.deepEqual(b.orderPosts().map((p) => p.via), ["direct"]);
    // A 400 that carries the broker's own reply inside it: for gold that reply IS the answer, as before.
    const b2 = new Broker(); install(b2);
    b2.relayInstead = (path, method) => (isOrder(path, method) ? json(400, { status: 200, text: JSON.stringify({ s: "error", errmsg: "Not enough margin" }) }) : null);
    const r2 = await d.ex.placeFixedLotFollower(gold());
    assert.equal(r2.ok, false);
    assert.equal(b2.orderPosts().length, 0);                                                 // not sent again directly
    // The relay's own refusal, with nothing forwarded: both go direct — GEN FX too, because nothing can have reached the broker.
    for (const mk of [gold, fx]) {
      const b3 = new Broker(); install(b3);
      b3.relayInstead = (path, method) => (isOrder(path, method) ? json(401, { error: "unauthorized" }) : null);
      assert.equal((await d.ex.placeFixedLotFollower(mk())).ok, true);
      assert.deepEqual(b3.orderPosts().map((p) => p.via), ["direct"]);
    }
    // The same 400 on a GEN FX order: not the relay's own refusal, so it may have been forwarded — it is not sent again.
    const b4 = new Broker(); install(b4);
    b4.relayInstead = (path, method) => (isOrder(path, method) ? json(400, { status: 200, text: "{}" }) : null);
    await assert.rejects(() => d.ex.placeFixedLotFollower(fx()), /relay_outcome_unknown/);
    assert.equal(b4.orderPosts().length, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("a labelled order takes no position from the broker's reply to the order itself — only from the order's own EXECUTED history row", async () => {
  // The books now remember a position id for good, as proof the order executed. One writer of it was
  // unchecked: a `positionId` on the reply to the create request. (Not something TradeLocker's documented
  // reply carries — but given one for an order that was only RESTING, the fourth version withdrew the order
  // at the first look and, half an hour on, booked a trade that never happened.)
  const d = await desk();
  try {
    const b = new Broker(); install(b);
    b.onOrder = (body, _k, self) => { const { id } = self.accept(body); return ok({ orderId: id, positionId: "P-NOT-YET" }); };
    const w = world(d, d.relayAcc);
    assert.equal((await w.run()).placed, 1);
    assert.deepEqual([w.fill().status, w.fill().order_id, w.fill().position_id, b.patches().length], ["placed", "701", null, 0]);       // resting: no position, nothing modified
    const out = await w.books();
    assert.deepEqual([out.waiting, w.fill().status, b.deletes().length, w.db.tables.flow_managed_positions.length], [1, "placed", 0, 0]);  // left to rest, inside its validity
    // An unlabelled order (gold's) reads the reply as it always has.
    const b2 = new Broker(); install(b2);
    b2.onOrder = (body, _k, self) => { const { id } = self.accept(body); return ok({ orderId: id, positionId: "P9" }); };
    const r = await d.ex.placeFixedLotFollower({ userId: "u1", env: "demo" as const, token: "tok", connId: `c-n${++n}`, accountId: `A-n${n}`, accNum: d.relayAcc, symbol: "EURUSD", side: "buy" as const, qty: 0.5, stop: 1.0825, tp: 1.0872, source: "genx" });
    assert.deepEqual([r.ok, r.ok && r.positionId], [true, "P9"]);
  } finally { globalThis.fetch = realFetch; }
});
