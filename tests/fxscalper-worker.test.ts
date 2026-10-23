import test from "node:test";
import assert from "node:assert/strict";
import { Bot } from "../fxscalper/worker/bot";
import { commands, dayCheck, exits, manageAll, minuteCycle, reconcile } from "../fxscalper/worker/trading";
import { seal } from "../src/lib/fxscalper/crypto";
import { P } from "../src/lib/fxscalper/tl/transport";
import type { Bar } from "../src/lib/fxscalper/strategy";
import { MemoryStore, SimBroker, type PlaceMode } from "./_fxscalper-sim";

/**
 * FX Scalper worker, end to end, against a SIMULATED broker and an in-memory database: signal → order
 * → fill → protection → time exit / target → booked result, plus the failure paths (an order whose
 * outcome is unknown, protection that cannot be verified, a restart mid-trade, owner commands).
 * Nothing here reaches a real account.
 */

process.env.FX_SCALPER_ENC_KEY = "11".repeat(32);
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
const setNow = (ms: number) => { offset = ms - realNow(); };
const advance = (ms: number) => { offset += ms; };

// Wednesday 2026-10-21 14:30 UTC = 10:30 New York: no blackout window.
const MINUTE = Date.UTC(2026, 9, 21, 14, 30, 0);
const SIGNAL_T = MINUTE - 60_000;

function signalBars(dir: 1 | -1 = 1): Bar[] {
  const bars: Bar[] = [];
  let c = 1.1;
  for (let i = 0; i < 1500; i++) { const o = c; c = o + dir * 0.00002; bars.push({ t: 0, o, h: Math.max(o, c) + 0.00003, l: Math.min(o, c) - 0.00003, c }); }
  for (let i = 0; i < 5; i++) { const o = c; c = o - dir * 0.0001; bars.push({ t: 0, o, h: Math.max(o, c) + 0.00001, l: Math.min(o, c) - 0.00001, c }); }
  const o = c; c = o + dir * 0.0004; bars.push({ t: 0, o, h: Math.max(o, c) + 0.00001, l: Math.min(o, c) - 0.00001, c });
  return bars.map((b, i) => ({ ...b, t: SIGNAL_T - (bars.length - 1 - i) * 60_000, o: +b.o.toFixed(5), h: +b.h.toFixed(5), l: +b.l.toFixed(5), c: +b.c.toFixed(5) }));
}

async function setup(opts: { mode?: PlaceMode; slip?: number; refuseModify?: boolean; stopped?: boolean; at?: number } = {}) {
  setNow(opts.at ?? MINUTE + 1500);
  const sim = new SimBroker();
  sim.placeMode = opts.mode ?? "fill";
  sim.fillSlipPips = opts.slip ?? 0;
  sim.refuseModify = Boolean(opts.refuseModify);
  const bars = signalBars();
  sim.bars.set("1", bars);
  const last = bars[bars.length - 1].c;
  sim.quotes.set("1", { bid: last, ask: +(last + 0.00004).toFixed(5) });
  sim.quotes.set("2", { bid: 150, ask: 150.004 });
  globalThis.fetch = sim.fetch();
  const store = new MemoryStore(seal("ref1"), seal("acc1"));
  if (opts.stopped) store.control = { ...store.control, mode: "stopped" };
  const bot = new Bot(store);
  assert.ok(await bot.takeLease());
  await (bot as unknown as { loadControl: () => Promise<void> }).loadControl();
  await bot.prepareSession();
  assert.ok(bot.session?.ready, `session ready (${bot.session?.error})`);
  await bot.refreshState(P.SYNC);
  await bot.freshPositions(0, P.SYNC);
  await reconcile(bot);
  await dayCheck(bot);
  return { sim, store, bot, last };
}

const orderPosts = (sim: SimBroker) => sim.calls.filter((c) => c.method === "POST" && c.path.endsWith("/orders"));
const only = (store: MemoryStore) => { const t = [...store.trades.values()]; assert.equal(t.length, 1, "one trade row"); return t[0]; };
/** Time passes; the worker's lease job (every 3 s in production) keeps its lease alive meanwhile. */
const keepLease = (bot: Bot) => {
  const store = bot.store as MemoryStore;
  if (store.lease.owner === bot.owner && store.lease.fence === bot.fence) {
    store.lease.expiresAt = Date.now() + 15_000;
    bot.leaseValidUntil = Date.now() + 14_000;
  }
};
const pass = async (bot: Bot, n = 1, stepMs = 400) => {
  for (let i = 0; i < n; i++) {
    keepLease(bot);
    advance(stepMs);
    keepLease(bot);
    await exits(bot, true);
    await manageAll(bot, true);
  }
};
const jump = (bot: Bot, ms: number) => { keepLease(bot); advance(ms); keepLease(bot); };

test("happy path: signal → one market order with stop and 10-pip target → fill → protection verified → 120 s time exit → booked from the fills", async () => {
  const { sim, store, bot, last } = await setup();
  assert.deepEqual(bot.entryBlockers(), [], "nothing blocks entries");
  await minuteCycle(bot);
  const posts = orderPosts(sim);
  assert.equal(posts.length, 1, "exactly one order");
  const body = posts[0].body as Record<string, unknown>;
  const ask = +(last + 0.00004).toFixed(5);
  assert.equal(body.type, "market");
  assert.equal(body.validity, "IOC");
  assert.equal(body.qty, 0.1, "the 0.10-lot cap binds on a $100k account");
  assert.equal(body.takeProfit, +(ask + 0.001).toFixed(5), "target = ask + 10 pips");
  assert.equal(body.stopLoss, +(ask - 0.0003).toFixed(5), "stop = ask − 3 pips");
  assert.match(String(body.strategyId), /^OMFX-EURUSD-/);
  let t = only(store);
  assert.equal(t.state, "acknowledged");

  await pass(bot);
  t = only(store);
  assert.equal(t.state, "open");
  assert.equal(t.fill_price, ask);
  assert.equal(Date.parse(t.time_exit_due_at!) - Date.parse(t.filled_at!), 120_000);

  await pass(bot, 2);
  t = only(store);
  assert.equal(t.protection, "verified", "stop and target found on the broker at the right prices");
  assert.equal(sim.calls.filter((c) => c.method === "PATCH").length, 0, "nothing to fix when the fill matched the plan");

  jump(bot, 119_000);
  await exits(bot, true);
  t = only(store);
  assert.equal(t.state, "closing", "the close is requested by the exits pass on its own");
  assert.equal(t.close_reason, "time_exit");
  assert.equal(sim.calls.filter((c) => c.method === "DELETE").length, 1);

  await pass(bot);
  t = only(store);
  assert.equal(t.state, "closed");
  assert.equal(t.exit_price, last, "closed at the bid");
  assert.ok(Math.abs((t.gross_pnl as number) + 0.4) < 1e-6, "−0.4 pip spread on 0.1 lot = −$0.40");
  assert.ok(Math.abs((t.net_pnl as number) + 1.0) < 1e-6, "minus $0.60 round-trip commission");
  assert.equal(t.pnl_final, true);
  assert.ok(store.events.some((e) => e.kind === "close_requested") && store.events.some((e) => e.kind === "closed"));
  assert.equal(orderPosts(sim).length, 1, "never a second order");
});

test("the broker's target fills: booked as take profit, +10 pips gross", async () => {
  const { sim, store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  const t = only(store);
  assert.equal(t.protection, "verified");
  sim.hit(t.position_id!, "tp");
  jump(bot, 3500);
  await pass(bot, 2);
  const done = only(store);
  assert.equal(done.state, "closed");
  assert.equal(done.close_reason, "take_profit");
  assert.ok(Math.abs((done.gross_pnl as number) - 10) < 1e-6, `gross ${done.gross_pnl}`);
  assert.ok(Math.abs((done.net_pnl as number) - 9.4) < 1e-6);
});

test("a fill worse than planned: the stop is tightened to the planned distance and the target re-centred, then verified", async () => {
  const { sim, store, bot } = await setup({ slip: 0.5 });
  await minuteCycle(bot);
  await pass(bot);
  let t = only(store);
  assert.equal(t.state, "open");
  assert.ok(Math.abs((t.target_price as number) - ((t.fill_price as number) + 0.001)) < 1e-9, "target = fill + 10 pips");
  assert.ok(Math.abs((t.fill_price as number) - (t.stop_price as number) - 0.0003) < 1e-9, "stop = fill − 3 pips (tightened)");
  await pass(bot, 2, 1600);
  t = only(store);
  assert.equal(sim.calls.filter((c) => c.method === "PATCH").length, 1, "one change sent");
  assert.equal(t.protection, "verified");
  const sl = sim.orders.find((o) => o.type === "stop")!;
  assert.equal(sl.stopPrice, t.stop_price);
});

test("an order whose outcome is unknown is never re-sent; the broker's records settle it (filled)", async () => {
  const { sim, store, bot } = await setup({ mode: "timeout_filled" });
  await minuteCycle(bot);
  assert.equal(orderPosts(sim).length, 1);
  assert.equal(only(store).state, "uncertain");
  assert.ok(bot.entryBlockers().some((b) => /pending reconciliation/.test(b)), "entries wait while an order is unresolved");
  await pass(bot, 2, 3100);
  assert.equal(only(store).state, "open", "found by its label at the broker");
  assert.equal(orderPosts(sim).length, 1, "still exactly one order");
});

test("an order that never reached the broker: no trace after 90 s → not placed (still one attempt)", async () => {
  const { sim, store, bot } = await setup({ mode: "timeout_lost" });
  await minuteCycle(bot);
  assert.equal(only(store).state, "uncertain");
  await pass(bot, 3, 3100);
  assert.equal(only(store).state, "uncertain", "not given up early");
  jump(bot, 90_000);
  await pass(bot, 1, 3100);
  assert.equal(only(store).state, "not_placed");
  assert.equal(orderPosts(sim).length, 1);
});

test("a refused order is recorded as rejected and not retried", async () => {
  const { sim, store, bot } = await setup({ mode: "reject" });
  await minuteCycle(bot);
  const t = only(store);
  assert.equal(t.state, "rejected");
  assert.equal(t.error, "Market closed");
  assert.equal(orderPosts(sim).length, 1);
});

test("a stop that cannot be verified: three tries, then the position is closed and new entries are paused", async () => {
  const { sim, store, bot } = await setup({ mode: "fill_no_brackets", refuseModify: true });
  await minuteCycle(bot);
  await pass(bot);
  assert.equal(only(store).state, "open");
  await pass(bot, 6, 1600);
  const t = only(store);
  assert.equal(t.protection, "failed");
  assert.equal(store.control.entries_paused, true);
  assert.ok(bot.protectionAlarm);
  assert.equal(sim.calls.filter((c) => c.method === "PATCH").length, 3);
  assert.ok(["closing", "closed"].includes(t.state), `state ${t.state}`);
  assert.equal(sim.positions.length, 0, "the unprotected position is gone");
});

test("stopped: a signal is evaluated but no order is sent", async () => {
  const { sim, store, bot } = await setup({ stopped: true });
  await minuteCycle(bot);
  assert.equal(orderPosts(sim).length, 0);
  assert.equal(store.trades.size, 0);
  assert.equal(bot.pairs.get("EURUSD")!.eval?.status, "signal");
  assert.equal(bot.pairs.get("EURUSD")!.decision?.code, "blocked");
});

test("one decision per candle: running the minute pass twice sends one order", async () => {
  const { sim, bot } = await setup();
  await minuteCycle(bot);
  await minuteCycle(bot);
  assert.equal(orderPosts(sim).length, 1);
});

test("too late: past the 10-second signal window nothing is sent", async () => {
  const { sim, bot } = await setup({ at: MINUTE + 11_000 });
  await minuteCycle(bot);
  assert.equal(orderPosts(sim).length, 0);
});

test("price already ran more than 1 pip past the signal close: skipped", async () => {
  const { sim, bot, last } = await setup();
  sim.quotes.set("1", { bid: +(last + 0.00015).toFixed(5), ask: +(last + 0.00019).toFixed(5) });
  await minuteCycle(bot);
  assert.equal(orderPosts(sim).length, 0);
  assert.equal(bot.pairs.get("EURUSD")!.decision?.code, "moved");
});

test("another position on the pair that is not the bot's: the bot sits the pair out", async () => {
  const { sim, bot } = await setup();
  sim.positions.push({ id: "9", tradableInstrumentId: "1", routeId: "10", side: "sell", qty: 1, avgPrice: 1.1, stopLossId: null, takeProfitId: null, openDate: Date.now(), unrealizedPl: 0, strategyId: "" });
  bot.positionsAt = 0;
  await minuteCycle(bot);
  assert.equal(orderPosts(sim).length, 0);
  assert.equal(bot.pairs.get("EURUSD")!.decision?.code, "foreign_position");
});

test("restart mid-trade: an order left 'sending' is found at the broker by its label; an unknown bot-labelled position is closed", async () => {
  const first = await setup();
  await minuteCycle(first.bot);
  const t = only(first.store);
  // The process "dies" right after sending: the row still says sending.
  first.store.trades.set(t.id, { ...t, state: "sending", order_id: null });
  first.sim.positions.push({ id: "77", tradableInstrumentId: "2", routeId: "20", side: "buy", qty: 0.05, avgPrice: 150, stopLossId: null, takeProfitId: null, openDate: Date.now(), unrealizedPl: 0, strategyId: "OMFX-USDJPY-zzz-0000" });
  first.store.lease.expiresAt = 0;   // the old worker's lease runs out
  const next = new Bot(first.store);
  assert.ok(await next.takeLease());
  assert.ok((next.fence as number) > (first.bot.fence as number), "the new worker has a newer fence");
  await (next as unknown as { loadControl: () => Promise<void> }).loadControl();
  await next.prepareSession();
  await next.refreshState(P.SYNC);
  await reconcile(next);
  await manageAll(next, true);
  jump(next, 3100);
  await reconcile(next);
  await manageAll(next, true);
  const row = only(first.store);
  assert.equal(row.state, "open", "adopted from the broker's records");
  assert.ok(!first.sim.positions.some((p) => p.id === "77"), "the unknown labelled position was closed");
  assert.ok(next.reconciled);
  // The old worker can no longer write anything about the trade.
  assert.equal(await first.store.updateTrade(first.bot.owner, first.bot.fence!, row.id, null, { error: "stale" }), false);
});

test("owner: close all bot positions — pauses entries and closes every bot position", async () => {
  const { sim, store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  store.commands.push({ id: "c1", kind: "close_bot", created_at: new Date(Date.now()).toISOString(), status: "pending" });
  await commands(bot);
  assert.equal(store.control.entries_paused, true);
  await pass(bot, 3, 3100);
  assert.equal(only(store).state, "closed");
  assert.equal(only(store).close_reason, "owner_close_all");
  assert.equal(sim.positions.length, 0);
});

test("daily loss limit: entries stop and the bot's open positions are closed", async () => {
  const { sim, store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  // A bad day already booked: $1,100 lost on a $100,000 day-start (limit 1% = $1,000).
  store.trades.set("old", { ...only(store), id: "old", signal_key: "x", tag: "OMFX-old", state: "closed", pair: "GBPUSD", net_pnl: -1100, pnl_final: true, closed_at: new Date(Date.now()).toISOString() });
  await dayCheck(bot);
  assert.equal(store.control.entries_paused, true);
  assert.match(String(store.control.pause_reason), /daily loss limit/);
  assert.ok(store.control.pause_until, "resumes at the next 17:00 New York");
  await pass(bot, 3, 3100);
  assert.equal(sim.positions.length, 0);
});

// ---- Regressions from the independent review (each failed before its fix) -------------------------

test("review #1: a journal write that never returns does not hold up the 120 s exit", async () => {
  const { sim, store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  store.event = () => new Promise<void>(() => { /* never answers */ });
  jump(bot, 121_000);
  await exits(bot, true);
  assert.equal(sim.calls.filter((c) => c.method === "DELETE").length, 1, "the close went out");
});

test("review #2: a stale snapshot of the books neither drops a live trade nor closes its position as an orphan", async () => {
  const { sim, store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  const t = only(store);
  const real = store.liveTrades.bind(store);
  store.liveTrades = async () => [];          // a read that started before the trade existed
  await reconcile(bot);
  store.liveTrades = real;
  assert.ok(bot.trades.has(t.id), "still in memory");
  assert.equal(sim.positions.length, 1, "its position was not closed");
  assert.ok(!store.events.some((e) => e.kind === "orphan_closed"));
});

test("review #3: after a restart, entries wait until the day's results (loss streak, daily loss) have been read", async () => {
  const { sim, store, bot } = await setup();
  const at = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < 3; i++) store.trades.set(`l${i}`, { ...([...store.trades.values()][0] ?? {}), id: `l${i}`, signal_key: `l${i}`, tag: `OMFX-l${i}`, pair: "GBPUSD", side: "buy", state: "closed", net_pnl: -5, pnl_final: true, closed_at: at, created_at: at, updated_at: at, qty: 0.1, reserved_risk: 5 } as never);
  const fresh = new Bot(store);
  store.lease.expiresAt = 0;
  assert.ok(await fresh.takeLease());
  await (fresh as unknown as { loadControl: () => Promise<void> }).loadControl();
  await fresh.prepareSession();
  await fresh.refreshState(P.SYNC);
  await reconcile(fresh);
  assert.ok(fresh.entryBlockers().some((b) => /day's results/.test(b)), "blocked until the day is read");
  await dayCheck(fresh);
  assert.ok(fresh.entryBlockers().some((b) => /losses in a row/.test(b)), "then the loss streak blocks");
  await minuteCycle(fresh);
  assert.equal(orderPosts(sim).length, 0);
});

test("review #4: the daily limit does not turn the owner's own pause into one that resumes by itself", async () => {
  const { store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  await store.updateControl({ entries_paused: true, pause_reason: "paused by the owner", pause_until: null }, "owner");
  await (bot as unknown as { loadControl: () => Promise<void> }).loadControl();
  store.trades.set("old", { ...only(store), id: "old", signal_key: "x", tag: "OMFX-old", state: "closed", pair: "GBPUSD", net_pnl: -1100, pnl_final: true, closed_at: new Date(Date.now()).toISOString() });
  await dayCheck(bot);
  assert.equal(store.control.pause_until, null, "no automatic resume");
  assert.equal(store.control.pause_reason, "paused by the owner");
  assert.equal(bot.closeAllReason, "daily_loss_limit", "the bot's positions are still closed");
  assert.equal(store.control.close_all_reason, "daily_loss_limit", "and that survives a restart");
});

test("review #5: the time exit goes out even while the positions endpoint is failing", async () => {
  const { sim, store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  sim.failPositions = true;
  jump(bot, 121_000);
  await exits(bot, true);
  assert.equal(sim.calls.filter((c) => c.method === "DELETE").length, 1);
  assert.equal(only(store).state, "closing");
});

test("review #6: an order found by its label is the ENTRY order, not the stop or target that carries the same label", async () => {
  const { sim, store, bot } = await setup({ mode: "timeout_filled" });
  await minuteCycle(bot);
  const t = only(store);
  assert.equal(t.state, "uncertain");
  // The position has already been stopped out, and the history lists a cancelled target first.
  const pos = sim.positions[0];
  sim.history.unshift({ id: "tp-1", tradableInstrumentId: "1", routeId: "10", qty: 0.1, side: "sell", type: "limit", status: "Cancelled", filledQty: 0, avgPrice: null, price: 1.2, stopPrice: null, validity: "GTC", createdDate: Date.now(), lastModified: Date.now(), isOpen: false, positionId: pos.id, stopLoss: null, takeProfit: null, strategyId: t.tag });
  sim.hit(pos.id, "sl");
  await pass(bot, 2, 3100);
  const after = only(store);
  assert.notEqual(after.state, "not_filled", "a cancelled target is not the entry");
  assert.ok(["open", "closing", "closed"].includes(after.state), `state ${after.state}`);
  assert.equal(after.fill_price, sim.execs.find((e) => e.side === "buy")!.price, "the entry price, not the exit's");
});

test("review #7: a target the broker will not take is enforced by the worker at fill + 10 pips", async () => {
  const { sim, store, bot, last } = await setup({ mode: "fill_no_tp" });
  await minuteCycle(bot);
  await pass(bot, 6, 1600);
  const t = only(store);
  assert.equal(t.protection, "verified", "the stop is on");
  assert.equal((t.broker as { target?: string }).target, "missing");
  sim.quotes.set("1", { bid: +((t.fill_price as number) + 0.001).toFixed(5), ask: +((t.fill_price as number) + 0.00104).toFixed(5) });
  await pass(bot, 2, 1100);
  const done = only(store);
  assert.equal(done.close_reason, "take_profit");
  assert.ok(sim.calls.some((c) => c.method === "DELETE"));
  void last;
});

test("review #10: a labelled position that cannot be booked (its pair already has a live trade) is closed, and reconcile carries on", async () => {
  const { sim, store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  const live = only(store);
  store.trades.set("dup", { ...live, id: "dup", signal_key: "dup", tag: "OMFX-EURUSD-dup", state: "not_placed", position_id: null });
  sim.positions.push({ id: "88", tradableInstrumentId: "1", routeId: "10", side: "buy", qty: 0.1, avgPrice: 1.1, stopLossId: null, takeProfitId: null, openDate: Date.now(), unrealizedPl: 0, strategyId: "OMFX-EURUSD-dup" });
  bot.positionsAt = 0;
  await reconcile(bot);
  assert.ok(!sim.positions.some((p) => p.id === "88"), "the duplicate was closed");
  assert.ok(sim.positions.some((p) => p.id === live.position_id), "the real trade's position is untouched");
});

// ---- Regressions from the second review --------------------------------------------------------------

test("review #11: while every bot position is being closed, new entries are blocked; the block lifts once none is left", async () => {
  const { store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  store.commands.push({ id: "c1", kind: "close_bot", created_at: new Date(Date.now()).toISOString(), status: "pending" });
  await commands(bot);
  assert.ok(bot.entryBlockers().some((b) => /Closing every bot position/.test(b)), "entries blocked during close-all");
  assert.equal(store.control.close_all_reason, "owner_close_all", "recorded for the dashboard and the server (START/Resume refused)");
  await pass(bot, 3, 3100);
  assert.equal(only(store).state, "closed");
  await pass(bot);
  assert.equal(bot.closeAllReason, null, "cleared once no bot position is left");
  assert.equal(store.control.close_all_reason, null);
  assert.ok(!bot.entryBlockers().some((b) => /Closing every bot position/.test(b)));
});

test("review #12: a pause that cannot be written does not stop the close-all", async () => {
  const { sim, store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  store.readControl = async () => { throw new Error("database unreachable"); };
  store.commands.push({ id: "c1", kind: "close_bot", created_at: new Date(Date.now()).toISOString(), status: "pending" });
  await commands(bot);
  assert.equal(bot.closeAllReason, "owner_close_all");
  await pass(bot, 3, 3100);
  assert.equal(only(store).state, "closed");
  assert.equal(only(store).close_reason, "owner_close_all");
  assert.equal(sim.positions.length, 0);
});

test("review #13: a position its own stop already closed is booked as a stop loss, and is not asked to close again and again", async () => {
  const { sim, store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  const t = only(store);
  assert.equal(t.protection, "verified");
  sim.hit(t.position_id!, "sl");
  jump(bot, 118_000);
  await pass(bot, 1, 1000);   // the time exit fires: the broker answers "Position not found"
  for (let i = 0; i < 6; i++) await pass(bot, 1, 2000);
  const done = only(store);
  assert.equal(done.state, "closed");
  assert.equal(done.close_reason, "stop_loss", "named by the fill that closed it");
  assert.ok((done.net_pnl as number) < 0);
  assert.equal(sim.calls.filter((c) => c.method === "DELETE").length, 1, "one close request; the gone position is not asked again");
});

test("review #14: a stale snapshot does not bring back a trade that has just finished", async () => {
  const { sim, store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  const openRow = { ...only(store) };
  jump(bot, 119_000);
  await exits(bot, true);
  await pass(bot);
  assert.equal(only(store).state, "closed");
  const real = store.liveTrades.bind(store);
  store.liveTrades = async () => [openRow];   // a read that started before the close was booked
  await reconcile(bot);
  store.liveTrades = real;
  assert.ok(!bot.trades.has(openRow.id), "not back in memory");
  const deletes = sim.calls.filter((c) => c.method === "DELETE").length;
  await pass(bot, 3, 2000);
  assert.equal(sim.calls.filter((c) => c.method === "DELETE").length, deletes, "nothing re-sent for it");
  assert.equal(only(store).state, "closed");
});

test("review #15: an owner command left running by a worker that is gone is taken over by the next one", async () => {
  const { sim, store, bot } = await setup();
  await minuteCycle(bot);
  await pass(bot, 3);
  // Our own running command (same fence) is never re-run…
  store.commands.push({ id: "mine", kind: "close_account_all", created_at: new Date(Date.now()).toISOString(), status: "running", claimed_fence: bot.fence });
  // …one from a previous worker (older fence) is.
  store.commands.push({ id: "old", kind: "close_bot", created_at: new Date(Date.now()).toISOString(), status: "running", claimed_fence: (bot.fence as number) - 1 });
  await commands(bot);
  assert.equal(bot.closeAllReason, "owner_close_all");
  assert.ok(!sim.calls.some((c) => c.method === "DELETE" && c.path.endsWith("/accounts/810219/positions")), "the account-wide close was not repeated");
  await pass(bot, 3, 3100);
  assert.equal(only(store).state, "closed");
  assert.ok(store.events.some((e) => e.kind === "command_resumed"));
});

test("review #16: a broker target nearer than fill + 10 pips that cannot be moved is removed; the worker closes at the real target", async () => {
  const { sim, store, bot } = await setup({ slip: 1 });
  sim.refuseTpChange = true;
  await minuteCycle(bot);
  await pass(bot, 6, 1600);
  const t = only(store);
  assert.equal(t.protection, "verified", "the stop is on (at its planned price)");
  assert.match(String((t.broker as { target?: string }).target), /removed the broker target/);
  assert.ok(!sim.orders.some((o) => o.positionId === t.position_id && o.type === "limit"), "the nearer target is gone");
  assert.ok(sim.calls.some((c) => c.method === "PATCH" && (c.body as { takeProfit?: unknown }).takeProfit === null));
  // 9 pips up: the old broker target would have closed it here; now it stays open.
  sim.quotes.set("1", { bid: +((t.fill_price as number) + 0.0009).toFixed(5), ask: +((t.fill_price as number) + 0.00094).toFixed(5) });
  await pass(bot, 2, 1100);
  assert.equal(only(store).state, "open");
  // 10 pips: the worker closes it.
  sim.quotes.set("1", { bid: +((t.fill_price as number) + 0.001).toFixed(5), ask: +((t.fill_price as number) + 0.00104).toFixed(5) });
  await pass(bot, 2, 1100);
  const done = only(store);
  assert.equal(done.close_reason, "take_profit");
  assert.ok(Math.abs((done.exit_price as number) - ((t.fill_price as number) + 0.001)) < 1e-9);
});
