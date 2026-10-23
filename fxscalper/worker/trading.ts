import { randomBytes } from "node:crypto";
import { PAIRS, type PairKey } from "@/lib/fxscalper/pairs";
import { M1_MS, type Evaluation } from "@/lib/fxscalper/strategy";
import { planEntry, protectionAfterFill, type Plan } from "@/lib/fxscalper/plan";
import { eligibleLots, tradePnl } from "@/lib/fxscalper/risk";
import { entryBlackout, fxDayStart } from "@/lib/fxscalper/clock";
import { LIVE_STATES, type TradeRow, type TradeState } from "@/lib/fxscalper/store";
import { P, type Priority } from "@/lib/fxscalper/tl/transport";
import { cancelOrder, closeAllAccountPositions, closePosition, getExecutions, getOrdersHistory, modifyPosition, placeMarketOrder, type Order, type Position } from "@/lib/fxscalper/tl/api";
import { Bot, TAG_PREFIX, chargesOf, type PairState } from "./bot";

/**
 * THE FX SCALPER'S TRADING — entries, each trade's life, reconciliation, owner commands, the daily limit.
 *
 * EXITS FIRST. A separate fast pass (`exits`, every 250 ms) requests every due close — the 120-second
 * time exit, an owner/safety close-all, the worker's own 10-pip target where the broker's could not be
 * set — straight from the books: it does not wait for a positions read, for another step of the same
 * trade, or for the journal. A close sent for a position that is already gone is answered "not found"
 * and is harmless, so a due close is always sent rather than delayed. The broker's own stop and target
 * do the rest without the worker: a position stays protected while the worker restarts or the network
 * is down.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();
const hhmm = (ms: number) => iso(ms).slice(11, 16);
const SIDE = (s: "buy" | "sell") => s.toUpperCase();
/** Order states after which nothing more will fill. */
const FINAL = new Set(["filled", "cancelled", "canceled", "refused", "unplaced", "removed", "rejected", "expired"]);
const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[ _-]/g, "");
const isLive = (s: TradeState) => (LIVE_STATES as readonly string[]).includes(s);

/** A trade being worked on, and since when; a step that hangs releases the trade after 30 s. */
const busy = new Map<string, number>();
const BUSY_MAX_MS = 30_000;
const isBusy = (id: string) => { const at = busy.get(id); return at != null && Date.now() - at < BUSY_MAX_MS; };
const protect = new Map<string, { attempts: number; lastTry: number }>();
const closing = new Map<string, { attempts: number; lastAt: number }>();
const looks = new Map<string, number>();
const lastUncertainLook = new Map<string, number>();
const stopCheckAt = new Map<string, number>();
const targetQuoteAt = new Map<string, number>();
/** Positions seen to be gone from the broker: no more close requests for them. */
const goneAt = new Map<string, number>();
/** When each closing trade last asked the broker's records for its exit fill (they are asked every 5 s). */
const exitLookAt = new Map<string, number>();
/** Trades that reached an end state recently: a stale snapshot of the books must not bring them back. */
const finishedAt = new Map<string, number>();
let lastPricingAt = 0;

export function makeTag(pair: PairKey, closeT: number): string {
  return `${TAG_PREFIX}${pair}-${Math.floor(closeT / M1_MS).toString(36)}-${randomBytes(2).toString("hex")}`.slice(0, 31);
}

/** Move a trade on; the in-memory book follows the database, never the other way round. */
async function move(bot: Bot, t: TradeRow, from: TradeState[], patch: Partial<TradeRow>): Promise<boolean> {
  if (bot.fence == null) return false;
  const ok = await bot.store.updateTrade(bot.owner, bot.fence, t.id, from, patch);
  if (ok) {
    const cur = bot.trades.get(t.id) ?? t;
    const next = { ...cur, ...patch, updated_at: iso(Date.now()) } as TradeRow;
    if (isLive(next.state)) { bot.trades.set(t.id, next); finishedAt.delete(t.id); }
    else { bot.trades.delete(t.id); finishedAt.set(t.id, Date.now()); goneAt.delete(t.id); exitLookAt.delete(t.id); }
    return true;
  }
  const fresh = await bot.store.tradeById(t.id);
  if (fresh && isLive(fresh.state)) bot.trades.set(t.id, fresh);
  else bot.trades.delete(t.id);
  return false;
}

const pipOf = (bot: Bot, pair: string) => bot.pairs.get(pair as PairKey)?.spec?.pipSize ?? PAIRS[pair as PairKey]?.pip ?? 0.0001;
const tickOf = (bot: Bot, pair: string) => bot.pairs.get(pair as PairKey)?.spec?.tickSize ?? pipOf(bot, pair) / 10;

// =====================================================================================================
// ENTRIES
// =====================================================================================================

/** Every minute: fetch each pair's just-closed candle, evaluate it, act on a signal inside its window. */
export async function minuteCycle(bot: Bot): Promise<void> {
  if (!bot.session?.ready) return;
  const minuteStart = Math.floor(Date.now() / M1_MS) * M1_MS;
  const signalT = minuteStart - M1_MS;
  const deadline = minuteStart + bot.settings.strategy.signalExpirySec * 1000;
  const pairs = [...bot.pairs.values()].filter((p) => p.spec);
  await Promise.all(pairs.map((ps) => onePair(bot, ps, signalT, minuteStart, deadline).catch((e) => bot.noteError(`minute ${ps.key}`, e))));
}

async function onePair(bot: Bot, ps: PairState, signalT: number, minuteStart: number, deadline: number): Promise<void> {
  const fetchBy = deadline - 1500;
  // A closed or silent market (weekend, halt, a quote that has not moved for 5 minutes) gets one look,
  // not a retry loop: no candle is coming.
  const quiet = (ps.symbolStatus != null && ps.symbolStatus.toUpperCase() !== "FULLY_OPEN") || (ps.quote != null && Date.now() - ps.quote.changedAt > 300_000) || entryBlackout(Date.now(), bot.settings.session) != null;
  let have = ps.bars.some((b) => b.t === signalT);
  let tries = 0;
  while (!have && Date.now() < fetchBy && !(quiet && tries > 0)) {
    tries++;
    await bot.refreshBars(ps.key, P.SIGNAL, fetchBy);
    have = ps.bars.some((b) => b.t === signalT);
    if (!have && !quiet) await sleep(400);
  }
  if (!have) {
    ps.decision = { at: Date.now(), code: "no_candle", text: quiet ? `No ${hhmm(signalT)} candle (the market is closed or not moving).` : `No ${hhmm(signalT)} candle from the broker within ${Math.round((fetchBy - minuteStart) / 1000)} s (no trading that minute, or the broker was slow).` };
    return;
  }
  if (ps.evaluatedT === signalT) return;              // one decision per candle, ever
  ps.barLagMs = Date.now() - minuteStart;
  const ev = bot.evaluatePair(ps.key);
  if (!ev || ev.candleT !== signalT) return;
  if (ev.status !== "signal") {
    ps.decision = { at: Date.now(), code: ev.status, text: ev.reason };
    return;
  }
  await bot.exclusive(() => tryEntry(bot, ps, ev, deadline));
}

async function tryEntry(bot: Bot, ps: PairState, ev: Evaluation, deadline: number): Promise<void> {
  const pair = ps.key;
  const side = ev.side!;
  const spec = ps.spec!;
  const s = bot.settings;
  const signal = { candleT: ev.candleT, closeT: ev.closeT, open: ev.open, close: ev.close, values: ev.values, checks: side === "buy" ? ev.buy : ev.sell };
  const skip = async (code: string, text: string, data: Record<string, unknown> = {}, level: "info" | "warn" = "info") => {
    ps.decision = { at: Date.now(), code, text };
    await bot.event(level, "signal_skipped", `${pair} ${SIDE(side)} signal (${hhmm(ev.candleT)} candle) not taken: ${text}`, { code, signal, ...data }, pair);
  };

  const blockers = bot.entryBlockers();
  if (blockers.length) return skip("blocked", blockers[0], { blockers });
  if (!s.pairs[pair].enabled) return skip("pair_off", "this pair is switched off in the settings.");
  if (ps.symbolStatus && ps.symbolStatus.toUpperCase() !== "FULLY_OPEN") return skip("market_status", `the broker reports ${spec.brokerSymbol} as ${ps.symbolStatus}.`);
  if (Date.now() > deadline - 300) return skip("expired", `the ${s.strategy.signalExpirySec}-second window after the candle closed has passed.`);

  // Another position on this instrument that is not the bot's: on an account that nets, the bot's order
  // would change it. The bot sits the pair out instead.
  const positions = await bot.freshPositions(1500, P.ENTRY);
  if (!positions) return skip("no_positions", "the account's positions could not be read.");
  const foreign = positions.filter((p) => p.tradableInstrumentId === spec.tradableInstrumentId && !(p.strategyId ?? "").startsWith(TAG_PREFIX));
  if (foreign.length) return skip("foreign_position", `another position is open on ${spec.brokerSymbol} (not the bot's).`);

  const before = ps.quote ? { bid: ps.quote.bid, ask: ps.quote.ask, changedAt: ps.quote.changedAt } : null;
  const q = await bot.fetchQuote(pair, P.ENTRY, deadline - 300);
  if (!q) return skip("no_quote", "no fresh quote from the broker in time.");
  // TradeLocker's quote carries no timestamp. A price identical to one that has not moved for a minute
  // is treated as a delayed feed, not as a market that is standing still.
  if (before && before.bid === q.bid && before.ask === q.ask && Date.now() - before.changedAt > 60_000) {
    return skip("stale_quote", `the broker's quote has not changed for ${Math.round((Date.now() - before.changedAt) / 1000)} s.`);
  }
  const src = spec.barSource === "ASK" ? q.ask : spec.barSource === "BID" ? q.bid : (q.bid + q.ask) / 2;
  const drift = (side === "buy" ? src - ev.close : ev.close - src) / spec.pipSize;
  if (drift > s.strategy.maxSignalDriftPips + 1e-9) {
    return skip("moved", `price is ${drift.toFixed(1)} pips ${side === "buy" ? "above" : "below"} the signal close (limit ${s.strategy.maxSignalDriftPips}).`);
  }

  if (Date.now() - bot.stateAt > 10_000) await bot.refreshState(P.ENTRY);
  const equity = bot.equity();
  const eligible = bot.eligibleEquity();
  if (equity == null || eligible == null || !bot.state) return skip("no_state", "the account's equity could not be read.");
  const gross = bot.grossNotional();
  if (gross.value == null) return skip("notional_unknown", `not every open position can be valued yet (${gross.unknown.join(", ")}).`);
  const open = [...bot.trades.values()].map((t) => ({ pair: t.pair as PairKey, side: t.side, riskCash: Number(t.reserved_risk) }));
  const res = planEntry({
    side, spec, quote: q, atr: ev.values.atr, settings: s, slippagePips: bot.slippageInUse(),
    account: { currency: bot.session!.currency ?? "USD", equity, eligibleEquity: eligible, availableFunds: bot.state.availableFunds ?? null, grossNotional: gross.value },
    open, rates: bot.rates(),
  });
  if (!res.ok) return skip(res.code, res.reason, res.detail ?? {});
  const plan = res.plan;

  if (Date.now() > deadline - 250) return skip("expired", "the signal window closed while the trade was being planned.");
  const tag = makeTag(pair, ev.closeT);
  const reserved = await bot.store.reserveTrade({
    owner: bot.owner, fence: bot.fence!, controlVersion: bot.control!.version, maxLive: s.risk.maxConcurrent,
    maxRisk: (s.risk.maxOpenRiskPct / 100) * eligible,
    row: {
      signal_key: `${pair}:${ev.candleT}`, tag, settings_version: bot.settingsVersion, account_id: bot.session!.accountId, acc_num: bot.session!.accNum,
      pair, broker_symbol: spec.brokerSymbol, tradable_instrument_id: spec.tradableInstrumentId, side, candle_t: iso(ev.candleT),
      signal, plan: { ...plan, quote: { bid: q.bid, ask: q.ask, receivedAt: q.receivedAt, latencyMs: q.latencyMs }, slippageInUse: bot.slippageInUse(), driftPips: drift, equity, eligible },
      qty: plan.lots, planned_entry: plan.entryRef, planned_stop: plan.stopPrice, planned_target: plan.targetPrice, stop_pips: plan.stopPips, reserved_risk: plan.riskCash,
    },
  });
  if (!reserved.id) return skip("not_reserved", reserved.reason, {}, "warn");
  const id = reserved.id;
  bot.inEntry.add(id);
  try {
    const t = await bot.store.tradeById(id);
    if (!t) return;
    bot.trades.set(id, t);
    // Written BEFORE the order leaves: whatever happens next, a later pass knows what to look for.
    if (!(await move(bot, t, ["reserved"], { state: "sending", sent_at: iso(Date.now()) }))) return skip("not_sent", "the intent could not be marked as sending.", {}, "warn");
    const t1 = bot.trades.get(id)!;
    if (Date.now() > deadline - 100 || !bot.leaseOk(2000)) {
      await move(bot, t1, ["sending"], { state: "not_placed", error: "the signal window closed before the order could be sent" });
      return skip("expired", "the signal window closed before the order could be sent.");
    }
    const c = bot.conn();
    if (!c) { await move(bot, t1, ["sending"], { state: "not_placed", error: "no broker session" }); return; }
    const r = await placeMarketOrder(c, { tradableInstrumentId: spec.tradableInstrumentId, routeId: spec.tradeRouteId, side, qty: plan.lots, stopLoss: plan.stopPrice, takeProfit: plan.targetPrice, strategyId: tag }, deadline);
    const t2 = bot.trades.get(id) ?? t1;
    if (r.ok) {
      bot.ordersToday++;
      await move(bot, t2, ["sending"], { state: "acknowledged", order_id: r.data.orderId, ack_at: iso(Date.now()), ack_latency_ms: r.latencyMs });
      ps.decision = { at: Date.now(), code: "sent", text: `${SIDE(side)} ${plan.lots} lots sent at ${plan.entryRef}; order ${r.data.orderId} acknowledged in ${r.latencyMs} ms.` };
      await bot.event("info", "order_acknowledged", describePlan(pair, plan, r.data.orderId, r.latencyMs), { plan, signal }, pair, id);
    } else if (r.uncertain) {
      await move(bot, t2, ["sending"], { state: "uncertain", error: r.error });
      ps.decision = { at: Date.now(), code: "uncertain", text: `Order outcome unknown (${r.error}); asking the broker before anything else.` };
      await bot.event("warn", "order_uncertain", `${pair} ${SIDE(side)} order outcome unknown: ${r.error}. Entries wait until the broker's records settle it.`, {}, pair, id);
    } else {
      await move(bot, t2, ["sending"], { state: r.error.startsWith("not sent") ? "not_placed" : "rejected", error: r.error });
      ps.decision = { at: Date.now(), code: "rejected", text: `Order not placed: ${r.error}` };
      await bot.event("warn", "order_rejected", `${pair} ${SIDE(side)} order not placed: ${r.error}`, { plan }, pair, id);
      if (r.unauthorized) void bot.ensureToken(true);
    }
  } finally {
    bot.inEntry.delete(id);
  }
}

function describePlan(pair: string, p: Plan, orderId: string, ms: number): string {
  return `${pair} ${SIDE(p.side)} ${p.lots} lots at ${p.entryRef} (order ${orderId}, ${ms} ms): stop ${p.stopPrice} (${p.stopPips} pips), target ${p.targetPrice} (${p.targetPips} pips${p.tpMode === "after_fees" ? ", after fees" : ""}); at the stop about −${p.riskCash.toFixed(2)}, at the target about +${p.estNetAtTarget.toFixed(2)} after charges; costs ${p.costs.totalPips} pips; margin about ${p.marginEst.toFixed(2)}.`;
}

// =====================================================================================================
// EXITS — every 250 ms, independent of everything else
// =====================================================================================================

export async function exits(bot: Bot, wait = false): Promise<void> {
  if (!bot.session) return;
  const now = Date.now();
  const work: Promise<void>[] = [];
  for (const t of [...bot.trades.values()]) {
    if (!t.position_id || bot.inEntry.has(t.id)) continue;
    const fail = (e: unknown) => bot.noteError(`exit ${t.pair}`, e);
    if (t.state === "open") {
      const due = Date.parse(t.time_exit_due_at ?? "");
      if (Number.isFinite(due) && now >= due) work.push(requestClose(bot, t, "time_exit").catch(fail));
      else if (bot.closeAllReason) work.push(requestClose(bot, t, bot.closeAllReason).catch(fail));
      else if (t.protection === "failed") work.push(requestClose(bot, t, "protection_failed").catch(fail));
      else work.push(workerTarget(bot, t).catch(fail));
    } else if (t.state === "closing" && t.close_reason !== "broker" && !goneAt.has(t.id)) {
      // Asked to close and not yet confirmed gone: ask again every few seconds until the broker confirms.
      const since = Date.parse(t.close_requested_at ?? t.updated_at);
      if (now - since >= 5000) work.push(requestClose(bot, t, t.close_reason ?? "time_exit").catch(fail));
    }
  }
  if (wait) await Promise.all(work);
}

/**
 * The 10-pip target, by the worker, for a trade whose broker-side target could not be set exactly at
 * fill ± target pips: close when the executable bid (buy) / ask (sell) reaches it.
 */
async function workerTarget(bot: Bot, t: TradeRow): Promise<void> {
  const b = t.broker as { target?: string };
  if (t.protection !== "verified" || b.target === "verified" || t.target_price == null || t.fill_price == null) return;
  const plan = t.plan as unknown as Partial<Plan>;
  const pip = pipOf(bot, t.pair);
  const target = t.side === "buy" ? Number(t.fill_price) + Number(plan.targetPips ?? bot.settings.strategy.tpPips) * pip : Number(t.fill_price) - Number(plan.targetPips ?? bot.settings.strategy.tpPips) * pip;
  const ps = bot.pairs.get(t.pair as PairKey);
  let q = ps?.quote ?? null;
  if (!q || Date.now() - q.receivedAt > 1000) {
    const last = targetQuoteAt.get(t.pair) ?? 0;
    if (Date.now() - last < 1000) return;
    targetQuoteAt.set(t.pair, Date.now());
    q = (await bot.fetchQuote(t.pair as PairKey, P.PROTECT)) as typeof q;
    if (!q) return;
  }
  const exitPx = t.side === "buy" ? q.bid : q.ask;
  if (t.side === "buy" ? exitPx >= target - 1e-9 : exitPx <= target + 1e-9) await requestClose(bot, t, "take_profit");
}

// =====================================================================================================
// EACH TRADE'S LIFE
// =====================================================================================================

/**
 * Move every trade on. Trades are worked on concurrently and independently: one trade's slow broker call
 * never holds up another's. `wait` (tests) resolves when this pass's work has finished.
 */
export async function manageAll(bot: Bot, wait = false): Promise<void> {
  if (!bot.session?.ready) return;
  const work: Promise<void>[] = [];
  for (const t of [...bot.trades.values()]) {
    if (isBusy(t.id) || bot.inEntry.has(t.id)) continue;
    busy.set(t.id, Date.now());
    work.push(progress(bot, t).catch((e) => bot.noteError(`trade ${t.pair}`, e)).finally(() => busy.delete(t.id)));
  }
  if (bot.closeAllReason && bot.reconciled && ![...bot.trades.values()].length) await bot.clearCloseAll();
  if (wait) await Promise.all(work);
}

async function progress(bot: Bot, t: TradeRow): Promise<void> {
  const age = Date.now() - Date.parse(t.created_at);
  switch (t.state) {
    case "reserved":
      // Never marked as sending: nothing can have been sent.
      if (age > 5000) await move(bot, t, ["reserved"], { state: "not_placed", error: "the worker stopped before sending; nothing was sent" });
      return;
    case "sending":
      await move(bot, t, ["sending"], { state: "uncertain", error: "the worker stopped while sending; asking the broker" });
      return;
    case "acknowledged":
      return resolveAck(bot, t);
    case "uncertain": {
      const last = lastUncertainLook.get(t.id) ?? 0;
      if (Date.now() - last < 3000) return;
      lastUncertainLook.set(t.id, Date.now());
      return resolveUncertain(bot, t, P.SYNC);
    }
    case "open":
      return manageOpen(bot, t);
    case "closing":
      return confirmClose(bot, t);
    default:
      return;
  }
}

type Found = { position: Position | null; order: Order | null };

/** Is this the trade's ENTRY order (not the stop or target attached to its position)? */
const isEntryOrder = (o: Order, t: TradeRow) => o.side === t.side && !/stop|limit/i.test(o.type ?? "");

/**
 * Where is this trade at the broker? Its position by id or label; else its entry order — by order id
 * first, by label only among orders on the trade's own side that are not a stop or a target.
 */
async function lookup(bot: Bot, t: TradeRow, priority: Priority): Promise<Found | null> {
  const positions = await bot.freshPositions(1000, priority);
  if (!positions) return null;
  const position = positions.find((p) => t.position_id && p.id === t.position_id)
    ?? positions.find((p) => p.strategyId === t.tag && (p.side == null || p.side === t.side)) ?? null;
  if (position) return { position, order: null };
  const c = bot.conn();
  const cols = bot.session?.columns;
  if (!c || !cols) return null;
  const from = Date.parse(t.sent_at ?? t.created_at) - 120_000;
  const h = await getOrdersHistory(c, cols, { fromMs: from, tradableInstrumentId: t.tradable_instrument_id }, priority);
  if (!h.ok) return null;
  const pick = (list: Order[]) => list.find((o) => t.order_id && o.id === t.order_id) ?? list.find((o) => o.strategyId === t.tag && isEntryOrder(o, t)) ?? null;
  let order = pick(h.data.orders);
  if (!order) {
    const live = await bot.freshOrders(1000, priority);
    if (!live) return null;
    order = pick(live);
  }
  return { position: null, order };
}

/** What a final order filled: its filled quantity, or (a "Filled" order that does not say) its quantity. */
function filledOf(o: Order): number {
  if ((o.filledQty ?? 0) > 0) return o.filledQty as number;
  return norm(o.status) === "filled" && (o.qty ?? 0) > 0 ? (o.qty as number) : 0;
}

async function resolveAck(bot: Bot, t: TradeRow): Promise<void> {
  const f = await lookup(bot, t, P.ENTRY);
  if (!f) return;
  if (f.position) return onFilled(bot, t, { positionId: f.position.id, qty: f.position.qty, price: f.position.avgPrice, at: f.position.openDate, source: "position", slOrderId: f.position.stopLossId, tpOrderId: f.position.takeProfitId });
  const o = f.order;
  if (o) {
    const filled = filledOf(o);
    if (filled > 0 && o.positionId) return onFilled(bot, t, { positionId: o.positionId, qty: filled, price: o.avgPrice, at: o.lastModified, source: "order history" });
    if (FINAL.has(norm(o.status)) && filled === 0) {
      if (await move(bot, t, ["acknowledged"], { state: "not_filled", error: `the broker reports the order as ${o.status} with nothing filled` })) {
        await bot.event("warn", "not_filled", `${t.pair} ${SIDE(t.side)} order ${t.order_id} ended ${o.status} with nothing filled.`, {}, t.pair, t.id);
      }
      return;
    }
  }
  if (t.ack_at && Date.now() - Date.parse(t.ack_at) > 20_000) {
    if (await move(bot, t, ["acknowledged"], { state: "uncertain", error: "no fill seen 20 s after the broker acknowledged the order" })) {
      await bot.event("warn", "fill_unseen", `${t.pair} order ${t.order_id}: no fill seen 20 s after acknowledgement; reconciling.`, {}, t.pair, t.id);
    }
  }
}

async function resolveUncertain(bot: Bot, t: TradeRow, priority: Priority): Promise<void> {
  const f = await lookup(bot, t, priority);
  if (!f) return;
  if (f.position) return onFilled(bot, t, { positionId: f.position.id, qty: f.position.qty, price: f.position.avgPrice, at: f.position.openDate, source: "position (reconciled)", slOrderId: f.position.stopLossId, tpOrderId: f.position.takeProfitId });
  if (f.order) {
    const o = f.order;
    const filled = filledOf(o);
    if (filled > 0 && o.positionId) return onFilled(bot, t, { positionId: o.positionId, qty: filled, price: o.avgPrice, at: o.lastModified, source: "order history (reconciled)" });
    if (FINAL.has(norm(o.status)) && filled === 0) {
      await move(bot, t, ["uncertain"], { state: "not_filled", order_id: o.id, error: `the broker's records show the order ${o.status} with nothing filled` });
      return;
    }
    return; // still working at the broker: wait
  }
  const n = (looks.get(t.id) ?? 0) + 1;
  looks.set(t.id, n);
  const since = Date.parse(t.sent_at ?? t.created_at);
  if (n >= 3 && Date.now() - since > 90_000) {
    if (await move(bot, t, ["uncertain"], { state: "not_placed", error: "no trace of the order at the broker 90 s after it was sent (positions, open orders and order history all checked)" })) {
      await bot.event("warn", "not_placed", `${t.pair}: no trace of the uncertain order at the broker after 90 s; treated as not placed. A position carrying its label (${t.tag}) would still be found and managed.`, {}, t.pair, t.id);
    }
    looks.delete(t.id);
  }
}

async function onFilled(bot: Bot, t: TradeRow, f: { positionId: string; qty: number | null; price: number | null; at: number | null; source: string; slOrderId?: string | null; tpOrderId?: string | null }): Promise<void> {
  const s = bot.settings;
  const plan = t.plan as unknown as Partial<Plan>;
  const pip = pipOf(bot, t.pair);
  const tick = tickOf(bot, t.pair);
  // Without a readable price the planned one stands in (flagged) — the time exit must start regardless.
  const priceKnown = f.price != null && f.price > 0;
  const fill = priceKnown ? (f.price as number) : Number(t.planned_entry);
  const lots = f.qty != null && f.qty > 0 ? f.qty : Number(t.qty);
  const filledAt = Math.min(f.at ?? Date.now(), Date.now());
  const prot = protectionAfterFill({ side: t.side, fill, attachedStop: Number(t.planned_stop), plannedStopPips: Number(t.stop_pips), targetPips: Number(plan.targetPips ?? s.strategy.tpPips), pipSize: pip, tickSize: tick });
  const stopPipsNow = Math.abs(fill - prot.stop) / pip;
  const pipValue = Number(plan.pipValuePerLot);
  const perLot = (stopPipsNow + bot.slippageInUse()) * (Number.isFinite(pipValue) ? pipValue : 0) + Number(plan.commissionRtPerLot ?? 0) + Number(plan.otherRtPerLot ?? 0);
  const slip = (t.side === "buy" ? fill - Number(t.planned_entry) : Number(t.planned_entry) - fill) / pip;
  const ok = await move(bot, t, ["acknowledged", "uncertain", "sending", "not_placed", "not_filled", "rejected"], {
    state: "open", position_id: f.positionId, filled_qty: lots, fill_price: fill, filled_at: iso(filledAt),
    time_exit_due_at: iso(filledAt + s.strategy.maxHoldSec * 1000), stop_price: prot.stop, target_price: prot.target,
    reserved_risk: lots * perLot, protection: "pending",
    broker: {
      ...t.broker, fillSource: f.source, entrySlipPips: Math.round(slip * 100) / 100, partialFill: lots < Number(t.qty),
      ...(f.slOrderId ? { slOrderId: f.slOrderId } : {}), ...(f.tpOrderId ? { tpOrderId: f.tpOrderId } : {}),
      ...(priceKnown ? {} : { fillPriceAssumed: true }),
    },
  });
  if (!ok) return;
  await bot.event("info", "filled", `${t.pair} ${SIDE(t.side)} ${lots} lots filled at ${fill}${priceKnown ? "" : " (price not reported; planned price used)"} (planned ${t.planned_entry}, ${slip >= 0 ? "slipped" : "improved"} ${Math.abs(slip).toFixed(1)} pips). Stop ${prot.stop}${prot.stopMoved ? " (tightened to the planned distance)" : ""}, target ${prot.target}; time exit at ${iso(filledAt + s.strategy.maxHoldSec * 1000).slice(11, 19)} UTC.`, { lots, fill, stop: prot.stop, target: prot.target }, t.pair, t.id);
  bot.positionsAt = 0;
  bot.ordersAt = 0;
}

async function manageOpen(bot: Bot, t: TradeRow): Promise<void> {
  const now = Date.now();
  const positions = await bot.freshPositions(1000, P.PROTECT);
  if (!positions) return; // cannot see — the exits pass still sends due closes, and the broker's stop and target stand
  let pos = positions.find((p) => p.id === t.position_id) ?? null;
  if (!pos) {
    const filledAge = now - Date.parse(t.filled_at ?? t.updated_at);
    if (filledAge < 3000) return; // the list can be a moment behind a fresh fill
    const again = await bot.freshPositions(0, P.PROTECT);
    pos = again?.find((p) => p.id === t.position_id) ?? null;
    if (again && !pos) {
      await move(bot, t, ["open"], { state: "closing", close_reason: t.close_reason ?? "broker" });
      return;
    }
    if (!pos) return;
  }
  // Due closes are the exits pass's job; here: protection, then observation.
  if (t.protection === "failed") return;
  if (t.protection !== "verified") return verifyProtection(bot, t, pos);
  // Every 10 s: is the stop still on the broker? (By the orders list as well as the position's own
  // stop-order id, so a broker that leaves the id empty does not look like a missing stop.)
  if (now - (stopCheckAt.get(t.id) ?? 0) > 10_000) {
    stopCheckAt.set(t.id, now);
    const orders = await bot.freshOrders(3000, P.PROTECT);
    if (orders) {
      const hasStop = (pos.stopLossId != null && orders.some((o) => o.id === pos!.stopLossId)) || orders.some((o) => o.positionId === pos!.id && /stop/i.test(o.type ?? ""));
      if (!hasStop) {
        protect.delete(t.id);
        await move(bot, t, ["open"], { protection: "pending" });
        await bot.event("warn", "stop_missing", `${t.pair}: the position's stop is no longer on the broker; putting it back.`, {}, t.pair, t.id);
        return;
      }
    }
  }
  if (bot.qtyCheck.state === "unverified") checkQuantity(bot, t, pos);
}

async function verifyProtection(bot: Bot, t: TradeRow, pos: Position): Promise<void> {
  const c = bot.conn();
  if (!c || t.stop_price == null || t.target_price == null || t.fill_price == null) return;
  const tick = tickOf(bot, t.pair);
  const pip = pipOf(bot, t.pair);
  const orders = await bot.freshOrders(800, P.PROTECT);
  if (!orders) return;
  const sl = orders.find((o) => pos.stopLossId != null && o.id === pos.stopLossId) ?? orders.find((o) => o.positionId === pos.id && /stop/i.test(o.type ?? ""));
  const tp = orders.find((o) => pos.takeProfitId != null && o.id === pos.takeProfitId) ?? orders.find((o) => o.positionId === pos.id && /limit/i.test(o.type ?? ""));
  const slPx = sl ? sl.stopPrice ?? sl.price : null;
  const tpPx = tp ? tp.price ?? tp.stopPrice : null;
  const half = tick / 2;
  const slExact = slPx != null && Math.abs(slPx - t.stop_price) <= half;
  const tpExact = tpPx != null && Math.abs(tpPx - t.target_price) <= half;
  // Acceptable: on the right side of the fill and no further away than the stop the trade was sized on.
  const slAcceptable = slPx != null && (t.side === "buy" ? slPx < t.fill_price && slPx >= Number(t.planned_stop) - half : slPx > t.fill_price && slPx <= Number(t.planned_stop) + half);
  const st = protect.get(t.id) ?? { attempts: 0, lastTry: 0 };
  protect.set(t.id, st);
  const brokerIds = { ...t.broker, slOrderId: sl?.id ?? null, tpOrderId: tp?.id ?? null };
  if (slExact && tpExact) {
    if (await move(bot, t, ["open"], { protection: "verified", protection_verified_at: iso(Date.now()), broker: { ...brokerIds, target: "verified" } })) {
      await bot.event("info", "protected", `${t.pair}: stop ${slPx} and target ${tpPx} verified on the broker.`, {}, t.pair, t.id);
    }
    protect.delete(t.id);
    return;
  }
  const now = Date.now();
  // Give the broker's lists a moment to show the last change before judging or trying again.
  if (now - st.lastTry < 1500) return;
  if (st.attempts < 3) {
    st.attempts++;
    st.lastTry = now;
    const m = await modifyPosition(c, pos.id, { stopLoss: t.stop_price, takeProfit: t.target_price });
    if (!m.ok) await bot.event("warn", "protect_refused", `${t.pair}: setting stop ${t.stop_price} / target ${t.target_price} was refused: ${m.error}`, {}, t.pair, t.id);
    bot.ordersAt = 0;
    bot.positionsAt = 0;
    return;
  }
  if (slAcceptable) {
    // The stop stands; the risk is what THAT stop risks. Without the exact broker target, the worker
    // closes at fill ± target pips itself (workerTarget). A broker target NEARER than that would close
    // the trade short of the target, so it is removed; if the broker refuses even that, it stays and
    // the record says so (closing the trade instead would book its costs as a certain loss).
    let tpNote: string | null = null;
    const nearer = tpPx != null && (t.side === "buy" ? tpPx < t.target_price - half : tpPx > t.target_price + half);
    if (nearer) {
      const rm = await modifyPosition(c, pos.id, { takeProfit: null });
      tpNote = rm.ok ? `removed the broker target at ${tpPx} (nearer than ${t.target_price})` : `the broker kept its target at ${tpPx} (nearer than ${t.target_price}; removal refused: ${rm.error})`;
      bot.ordersAt = 0;
    }
    const plan = t.plan as unknown as Partial<Plan>;
    const pipValue = Number(plan.pipValuePerLot);
    const lots = Number(t.filled_qty ?? t.qty);
    const risk = lots * ((Math.abs(Number(t.fill_price) - (slPx as number)) / pip + bot.slippageInUse()) * (Number.isFinite(pipValue) ? pipValue : 0) + Number(plan.commissionRtPerLot ?? 0) + Number(plan.otherRtPerLot ?? 0));
    const target = tpPx == null ? "missing" : tpExact ? "verified" : tpNote ?? `at ${tpPx} instead of ${t.target_price}`;
    if (await move(bot, t, ["open"], { protection: "verified", protection_verified_at: iso(now), stop_price: slPx, reserved_risk: risk, broker: { ...brokerIds, target } })) {
      await bot.event("warn", "protected_partly", `${t.pair}: the stop is on the broker at ${slPx}; the broker target could not be set to ${t.target_price} (${target}), so the worker closes at that price itself. The stop and the 120-second exit still apply.`, {}, t.pair, t.id);
    }
    protect.delete(t.id);
    return;
  }
  // No acceptable stop after three tries: close it and stop new entries.
  bot.protectionAlarm = `The stop on the ${t.pair} position could not be verified; the position was closed and new entries are paused until you resume.`;
  if (await move(bot, t, ["open"], { protection: "failed", broker: brokerIds })) {
    await bot.event("error", "protection_failed", `${t.pair}: no acceptable stop on the broker after 3 attempts (seen: ${slPx ?? "none"}). Closing the position and pausing new entries.`, {}, t.pair, t.id);
  }
  await bot.pauseEntries(`the stop on a ${t.pair} position could not be verified`);
  const fresh = bot.trades.get(t.id);
  if (fresh) await requestClose(bot, fresh, "protection_failed");
}

/** Ask the broker to close the whole position. Throttled per trade; "already gone" counts as done. */
async function requestClose(bot: Bot, t: TradeRow, reason: string): Promise<void> {
  const st = closing.get(t.id) ?? { attempts: 0, lastAt: 0 };
  closing.set(t.id, st);
  const now = Date.now();
  if (now - st.lastAt < 3000 || !t.position_id) return;
  if (!bot.leaseOk(1000)) return;
  const c = bot.conn();
  if (!c) return;
  st.attempts++;
  st.lastAt = now;
  const r = await closePosition(c, t.position_id);
  bot.positionsAt = 0;
  const gone = !r.ok && /not found|no such|does not exist|already closed|no position/i.test(r.error);
  if (r.ok || gone) {
    if (gone) goneAt.set(t.id, Date.now());
    const cur = bot.trades.get(t.id) ?? t;
    // Already gone before this request: its stop or target (or someone) closed it — the exit fill says which.
    if (cur.state === "open") await move(bot, cur, ["open"], { state: "closing", close_requested_at: cur.close_requested_at ?? iso(now), close_reason: gone ? "broker" : cur.close_reason ?? reason });
    if (st.attempts === 1) await bot.event("info", "close_requested", `${t.pair}: close requested (${reason.replace(/_/g, " ")}). Not closed until the broker confirms.`, {}, t.pair, t.id);
    return;
  }
  await bot.event("warn", "close_refused", `${t.pair}: the close request was refused (${r.error}); trying again.`, {}, t.pair, t.id, `close:${t.id}`, 15_000);
  if (st.attempts >= 5 && st.attempts % 5 === 0) {
    bot.protectionAlarm = `The ${t.pair} position could not be closed after ${st.attempts} attempts.`;
    await bot.pauseEntries(`a ${t.pair} position could not be closed`);
  }
}

async function confirmClose(bot: Bot, t: TradeRow): Promise<void> {
  const positions = await bot.freshPositions(1000, P.PROTECT);
  if (!positions) return;
  const pos = positions.find((p) => p.id === t.position_id);
  if (pos) {
    goneAt.delete(t.id);
    if (t.close_reason === "broker") {
      // It is still there: the earlier list that missed it was a moment behind.
      await move(bot, t, ["closing"], { state: "open", close_reason: null });
    }
    // Otherwise the exits pass keeps asking until the broker confirms.
    return;
  }
  goneAt.set(t.id, Date.now());
  const lastLook = exitLookAt.get(t.id) ?? 0;
  if (Date.now() - lastLook < 5000) return;
  exitLookAt.set(t.id, Date.now());
  const exit = await exitFill(bot, t);
  const since = Date.parse(t.close_requested_at ?? t.updated_at);
  if (!exit) {
    if (Date.now() - since > 120_000) {
      if (await move(bot, t, ["closing"], { state: "closed", closed_at: iso(Date.now()), pnl_final: false, closed_lots: t.filled_qty, eligible_lots: 0, error: "closed at the broker; the exit price was not found in its records yet" })) {
        await bot.event("warn", "closed_unpriced", `${t.pair}: the position is gone from the broker but its exit price was not found yet; counted as its full risk until it is.`, {}, t.pair, t.id);
      }
    }
    return;
  }
  const booked = await bookClose(bot, t, exit, ["closing"]);
  if (!booked) return;
  closing.delete(t.id);
  protect.delete(t.id);
  stopCheckAt.delete(t.id);
  exitLookAt.delete(t.id);
  void dayCheck(bot).catch((e) => bot.noteError("day", e));
}

/** Price and book a close from the broker's exit fill. Returns false if the row had already moved on. */
async function bookClose(bot: Bot, t: TradeRow, exit: { price: number; at: number; reason: string }, from: TradeState[]): Promise<boolean> {
  const ps = bot.pairs.get(t.pair as PairKey);
  const spec = ps?.spec;
  const ccy = bot.session?.currency ?? "USD";
  const lots = Number(t.filled_qty ?? t.qty);
  // The broker's own stop or target filling is the reason whenever its fill is the exit — even if a
  // close of ours was on its way; otherwise the reason the close was asked for.
  const reason = exit.reason === "take_profit" || exit.reason === "stop_loss" ? exit.reason : t.close_reason && t.close_reason !== "broker" ? t.close_reason : exit.reason;
  const quote = spec?.quote ?? PAIRS[t.pair as PairKey]?.quote ?? "USD";
  const lotSize = spec?.lotSize ?? 100_000;
  const wasAssumed = Boolean((t.broker as { fillPriceAssumed?: boolean }).fillPriceAssumed);
  let fillAssumed = wasAssumed;
  let fill = t.fill_price != null ? Number(t.fill_price) : null;
  if (fillAssumed) {
    const entry = await entryFill(bot, t);
    if (entry != null) { fill = entry; fillAssumed = false; }
  }
  const pnl = fill != null && !fillAssumed
    ? tradePnl({ side: t.side, lots, lotSize, fill, exit: exit.price, quoteCcy: quote, accountCcy: ccy, rates: bot.rates(), ...chargesOf(t, bot.settings) })
    : null;
  const hold = t.filled_at ? (exit.at - Date.parse(t.filled_at)) / 1000 : null;
  const ok = await move(bot, t, from, {
    state: "closed", exit_price: exit.price, closed_at: iso(exit.at), close_reason: reason, fill_price: fill,
    ...(wasAssumed && !fillAssumed ? { broker: { ...t.broker, fillPriceAssumed: false, fillSource: "executions (after the close)" } } : {}),
    gross_pnl: pnl?.gross ?? null, commission: pnl?.commission ?? null, other_charges: pnl?.other ?? null, net_pnl: pnl?.net ?? null,
    pnl_final: pnl != null, conversion: pnl ? { rate: pnl.rate, from: quote, to: ccy } : null, closed_lots: lots,
    eligible_lots: eligibleLots(lots, hold, bot.settings.payout),
    error: pnl ? null : fillAssumed ? "the entry price was never reported; the result is not booked" : "no conversion rate to price the result",
  });
  if (!ok) return false;
  if (pnl) {
    bot.dayRealized += pnl.net + (from.includes("closed") ? Math.abs(Number(t.reserved_risk) || 0) : 0);
  }
  const pips = fill != null ? ((t.side === "buy" ? exit.price - fill : fill - exit.price) / pipOf(bot, t.pair)) : null;
  await bot.event(pnl && pnl.net < 0 ? "warn" : "info", "closed", `${t.pair} ${SIDE(t.side)} closed by ${reason.replace(/_/g, " ")} at ${exit.price}${pips != null ? ` (${pips >= 0 ? "+" : ""}${pips.toFixed(1)} pips)` : ""}${hold != null ? ` after ${hold.toFixed(0)} s` : ""}: net ${pnl ? pnl.net.toFixed(2) : "unknown"} ${ccy}.`, { exit, pnl, hold }, t.pair, t.id);
  return true;
}

/** The closing fill: the broker's executions first, then its order history. */
async function exitFill(bot: Bot, t: TradeRow): Promise<{ price: number; at: number; reason: string } | null> {
  const c = bot.conn();
  const cols = bot.session?.columns;
  if (!c || !cols || !t.position_id) return null;
  const opposite = t.side === "buy" ? "sell" : "buy";
  const after = Date.parse(t.filled_at ?? t.created_at) - 1000;
  const reasonFor = (orderId: string | null): string => {
    const b = t.broker as { slOrderId?: string; tpOrderId?: string };
    if (orderId && b.tpOrderId && orderId === b.tpOrderId) return "take_profit";
    if (orderId && b.slOrderId && orderId === b.slOrderId) return "stop_loss";
    return "closed_externally";
  };
  // An exit by an order whose id was never recorded (a stop hit before it was verified) is named by the
  // closing order's own type in the broker's history.
  const byType = async (orderId: string | null, list?: Order[]): Promise<string> => {
    const r = reasonFor(orderId);
    if (r !== "closed_externally" || !orderId) return r;
    let orders: Order[] = list ?? [];
    if (!list) {
      const hist = await getOrdersHistory(c, cols, { fromMs: after - 60_000, tradableInstrumentId: t.tradable_instrument_id }, P.SYNC);
      if (hist.ok) orders = hist.data.orders;
    }
    const o = orders.find((x) => x.id === orderId);
    const type = norm(o?.type);
    return type.includes("stop") ? "stop_loss" : type.includes("limit") ? "take_profit" : r;
  };
  const ex = await getExecutions(c, cols, P.SYNC);
  if (ex.ok) {
    const fills = ex.data.filter((e) => e.positionId === t.position_id && e.side === opposite && (e.createdDate ?? 0) >= after && e.price != null && (e.qty ?? 0) > 0);
    if (fills.length) {
      const q = fills.reduce((a, e) => a + (e.qty ?? 0), 0);
      const price = fills.reduce((a, e) => a + (e.price ?? 0) * (e.qty ?? 0), 0) / q;
      return { price, at: Math.max(...fills.map((e) => e.createdDate ?? 0)) || Date.now(), reason: await byType(fills[fills.length - 1].orderId) };
    }
  }
  const h = await getOrdersHistory(c, cols, { fromMs: after - 60_000, tradableInstrumentId: t.tradable_instrument_id }, P.SYNC);
  if (h.ok) {
    const closes = h.data.orders.filter((o) => o.positionId === t.position_id && o.side === opposite && filledOf(o) > 0 && o.avgPrice != null);
    if (closes.length) {
      const q = closes.reduce((a, o) => a + filledOf(o), 0);
      const price = closes.reduce((a, o) => a + (o.avgPrice ?? 0) * filledOf(o), 0) / q;
      return { price, at: Math.max(...closes.map((o) => o.lastModified ?? 0)) || Date.now(), reason: await byType(closes[closes.length - 1].id, h.data.orders) };
    }
  }
  return null;
}

/** The entry fill's price from the broker's executions (for a fill whose price was not reported at the time). */
async function entryFill(bot: Bot, t: TradeRow): Promise<number | null> {
  const c = bot.conn();
  const cols = bot.session?.columns;
  if (!c || !cols || !t.position_id) return null;
  const ex = await getExecutions(c, cols, P.SYNC);
  if (!ex.ok) return null;
  const fills = ex.data.filter((e) => e.positionId === t.position_id && e.side === t.side && e.price != null && (e.qty ?? 0) > 0 && (!t.order_id || !e.orderId || e.orderId === t.order_id));
  if (!fills.length) return null;
  const q = fills.reduce((a, e) => a + (e.qty ?? 0), 0);
  return fills.reduce((a, e) => a + (e.price ?? 0) * (e.qty ?? 0), 0) / q;
}

/**
 * The broker should read an order's qty as LOTS. On the first open bot position that has moved a few
 * pips, compare the position's P&L with what that many lots would make. Units instead of lots would be
 * off by the lot size (100,000×) — unmistakable — and stops the bot.
 */
function checkQuantity(bot: Bot, t: TradeRow, pos: Position): void {
  const ps = bot.pairs.get(t.pair as PairKey);
  const spec = ps?.spec;
  const q = ps?.quote;
  if (!spec || !q || pos.unrealizedPl == null || t.fill_price == null || Date.now() - q.receivedAt > 3000) return;
  if ((t.broker as { fillPriceAssumed?: boolean }).fillPriceAssumed) return;
  const exit = t.side === "buy" ? q.bid : q.ask;
  const pips = Math.abs(exit - Number(t.fill_price)) / spec.pipSize;
  if (pips < 2) return;
  const est = tradePnl({ side: t.side, lots: Number(t.filled_qty ?? t.qty), lotSize: spec.lotSize, fill: Number(t.fill_price), exit, quoteCcy: spec.quote, accountCcy: bot.session?.currency ?? "USD", rates: bot.rates(), commissionPerLotPerSide: 0, otherRtPerLot: 0 });
  if (!est || est.gross === 0) return;
  const ratio = pos.unrealizedPl / est.gross;
  if (ratio > 0.25 && ratio < 4) {
    bot.qtyCheck = { state: "verified", detail: `${t.pair}: broker P&L ${pos.unrealizedPl.toFixed(2)} vs ${est.gross.toFixed(2)} expected for ${t.filled_qty} lots (${iso(Date.now()).slice(0, 16)}Z).` };
    void bot.event("info", "qty_verified", `Order sizes confirmed as lots: ${bot.qtyCheck.detail}`, {}, t.pair, t.id);
  } else if (Math.abs(ratio) < 0.001 || Math.abs(ratio) > 1000) {
    bot.qtyCheck = { state: "contradicted", detail: `${t.pair}: broker P&L ${pos.unrealizedPl} against ${est.gross.toFixed(2)} expected for ${t.filled_qty} lots.` };
    void bot.event("error", "qty_contradicted", `The broker is NOT reading order sizes as lots (${bot.qtyCheck.detail}). Emergency stop.`, {}, t.pair, t.id);
    void emergency(bot, "the broker did not read order sizes as lots").catch((e) => bot.noteError("emergency", e));
  }
}

// =====================================================================================================
// RECONCILIATION
// =====================================================================================================

/**
 * Bring the books and the broker into line: load what the books have that memory does not, settle
 * uncertain orders by their order id and label, look after bot-labelled positions, price closes that
 * were booked without a price — and only then allow entries (startup).
 *
 * A snapshot of the books can be older than a step that has just moved a trade on, so it never
 * REMOVES or OVERWRITES what memory has: a trade missing from it is asked about by itself.
 */
export async function reconcile(bot: Bot): Promise<void> {
  if (!bot.session?.ready || bot.fence == null) return;
  const snapshot = await bot.store.liveTrades();
  const ids = new Set(snapshot.map((t) => t.id));
  for (const [id, at] of finishedAt) if (Date.now() - at > 10 * 60_000) finishedAt.delete(id);
  for (const t of snapshot) {
    if (bot.trades.has(t.id) || bot.inEntry.has(t.id)) continue;
    if (finishedAt.has(t.id)) {
      // Finished since this snapshot was read? Ask about it by itself.
      const row = await bot.store.tradeById(t.id);
      if (!row || !isLive(row.state)) continue;
    }
    bot.trades.set(t.id, t);
  }
  for (const id of [...bot.trades.keys()]) {
    if (ids.has(id) || bot.inEntry.has(id) || isBusy(id)) continue;
    const row = await bot.store.tradeById(id);
    if (row && isLive(row.state)) bot.trades.set(id, row);
    else if (!isBusy(id) && !bot.inEntry.has(id)) bot.trades.delete(id);
  }

  const positions = await bot.freshPositions(1000, P.SYNC);
  if (!positions) { bot.reconcileNote = "the broker's positions could not be read"; return; }

  for (const t of [...bot.trades.values()]) {
    if (isBusy(t.id) || bot.inEntry.has(t.id)) continue;
    if (!["reserved", "sending", "uncertain"].includes(t.state)) continue;
    busy.set(t.id, Date.now());
    try {
      if (t.state === "reserved" || t.state === "sending") await progress(bot, t);
      else await resolveUncertain(bot, t, P.SYNC);
    } catch (e) {
      bot.noteError(`reconcile ${t.pair}`, e);
    } finally {
      busy.delete(t.id);
    }
  }

  // Bot-labelled positions that memory does not hold as live.
  const liveTags = new Set([...bot.trades.values()].map((t) => t.tag));
  for (const p of positions) {
    const tag = p.strategyId ?? "";
    if (!tag.startsWith(TAG_PREFIX) || liveTags.has(tag)) continue;
    try {
      const row = await bot.store.tradeByTag(tag);
      if (row === undefined) continue; // cannot tell whose it is: look again next pass rather than act on a guess
      if (row && isLive(row.state)) { bot.trades.set(row.id, row); continue; } // the books have it: memory had not caught up
      if (row && ["not_placed", "not_filled", "rejected"].includes(row.state)) {
        try {
          await onFilled(bot, row, { positionId: p.id, qty: p.qty, price: p.avgPrice, at: p.openDate, source: "position (adopted)", slOrderId: p.stopLossId, tpOrderId: p.takeProfitId });
          await bot.event("warn", "adopted", `${row.pair}: a position carrying the bot's label ${tag} was found for an order recorded as ${row.state}; it is now managed (time exit from its open time).`, {}, row.pair, row.id);
          continue;
        } catch (e) {
          // Typically: the pair already has another live bot trade, so this one cannot be booked live.
          await bot.event("error", "adopt_failed", `${row.pair}: could not take over labelled position ${p.id} (${(e as Error).message}); closing it.`, {}, row.pair, row.id);
        }
      } else {
        await bot.event("error", "orphan_closed", `A position labelled as the bot's (${tag}) has no live trade in its books${row ? ` (recorded as ${row.state})` : ""}; closing it.`, { position: p });
      }
      const c = bot.conn();
      if (c && bot.leaseOk(1000)) await closePosition(c, p.id);
    } catch (e) {
      bot.noteError("reconcile orphan", e);
    }
  }

  await priceLater(bot).catch((e) => bot.noteError("pricing", e));

  const unresolved = [...bot.trades.values()].filter((t) => ["reserved", "sending", "uncertain"].includes(t.state));
  bot.reconciled = unresolved.length === 0;
  bot.reconcileNote = unresolved.length ? `${unresolved.length} order(s) still being confirmed with the broker` : `last reconciled ${iso(Date.now()).slice(11, 19)} UTC`;
}

/** Closes booked without a price (the broker's records were slow): price them once the records show it. */
async function priceLater(bot: Bot): Promise<void> {
  if (Date.now() - lastPricingAt < 60_000) return;
  lastPricingAt = Date.now();
  const candidates = bot.closedRecent.filter((t) => !t.pnl_final && t.position_id && t.closed_at && Date.now() - Date.parse(t.closed_at) < 24 * 3_600_000).slice(0, 5);
  for (const t of candidates) {
    const exit = await exitFill(bot, t);
    if (exit) await bookClose(bot, t, exit, ["closed"]);
  }
}

// =====================================================================================================
// OWNER COMMANDS, EMERGENCY STOP, DAILY LOSS LIMIT
// =====================================================================================================

export async function emergency(bot: Bot, why: string): Promise<void> {
  // Close-all first: nothing that fails after this line can stop the bot's positions being closed.
  await bot.setCloseAll("emergency");
  await bot.store.updateControl({ mode: "stopped", entries_paused: true, pause_reason: `emergency stop: ${why}`, stop_reason: `emergency stop: ${why}`, stopped_at: iso(Date.now()) }, null)
    .catch((e) => bot.noteError("emergency stop (control)", e));
  await bot.event("error", "emergency_stop", `Emergency stop: ${why}. New entries stopped; closing every bot position and cancelling the bot's working orders.`);
  const c = bot.conn();
  if (!c || !bot.leaseOk(1000)) return;
  const orders = await bot.freshOrders(0, P.PROTECT);
  for (const o of orders ?? []) {
    if ((o.strategyId ?? "").startsWith(TAG_PREFIX) && !o.positionId && !FINAL.has(norm(o.status))) await cancelOrder(c, o.id);
  }
}

export async function commands(bot: Bot): Promise<void> {
  // Only the worker that commands the account takes a command; one about to lose its lease leaves it.
  if (bot.fence == null || !bot.leaseOk(3000)) return;
  const list = await bot.store.pendingCommands(bot.fence);
  for (const cmd of list) {
    if (!bot.leaseOk(3000) || bot.fence == null) return;
    if (!(await bot.store.claimCommand(cmd.id, bot.fence))) continue;
    // Left running by a worker that is gone: closing the BOT's positions is always safe to redo; an
    // account-wide close is redone only while it is recent (an old one could close positions the owner
    // opened since).
    if (cmd.status === "running" && cmd.kind === "close_account_all" && Date.now() - Date.parse(cmd.created_at) > 10 * 60_000) {
      await bot.store.finishCommand(cmd.id, false, { error: "The worker restarted before confirming this account-wide close; it is more than 10 minutes old, so it was not sent again." });
      continue;
    }
    if (cmd.status === "running") await bot.event("warn", "command_resumed", `Taking over the owner's "${cmd.kind.replace(/_/g, " ")}" command left unfinished by the previous worker.`);
    try {
      if (cmd.kind === "close_bot") {
        await bot.setCloseAll("owner_close_all");
        await bot.pauseEntries("closing all bot positions (owner)").catch((e) => bot.noteError("close-all (pause)", e));
        await bot.event("warn", "close_all_bot", "Owner: close all bot positions. New entries paused.");
      } else if (cmd.kind === "emergency") {
        await emergency(bot, "owner");
      } else if (cmd.kind === "close_account_all") {
        const c = bot.conn();
        if (!c || !bot.leaseOk(1000)) { await bot.store.finishCommand(cmd.id, false, { error: "no broker session or lease" }); continue; }
        await bot.pauseEntries("every position on the account was closed (owner)").catch((e) => bot.noteError("close every position (pause)", e));
        const r = await closeAllAccountPositions(c);
        await bot.event(r.ok ? "warn" : "error", "close_account_all", r.ok ? "Owner: close EVERY position on the account — requested at the broker." : `Owner: close every position on the account — refused: ${r.error}`);
        for (const t of [...bot.trades.values()]) if (t.state === "open") await move(bot, t, ["open"], { state: "closing", close_requested_at: iso(Date.now()), close_reason: "account_close_all" });
        bot.positionsAt = 0;
        if (!r.ok) { await bot.store.finishCommand(cmd.id, false, { error: r.error }); continue; }
      }
      void watchCommand(bot, cmd.id);
    } catch (e) {
      await bot.store.finishCommand(cmd.id, false, { error: (e as Error).message });
    }
  }
}

/** A close command is done when no bot position is left open (or reports what is left after 90 s). */
async function watchCommand(bot: Bot, id: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    await sleep(1000);
    const open = [...bot.trades.values()].filter((t) => ["acknowledged", "uncertain", "open", "closing"].includes(t.state));
    if (!open.length) { await bot.store.finishCommand(id, true, { closedAt: iso(Date.now()) }).catch(() => undefined); return; }
  }
  const left = [...bot.trades.values()].map((t) => ({ pair: t.pair, state: t.state, position: t.position_id }));
  await bot.store.finishCommand(id, false, { unresolved: left, note: "still being worked on after 90 s; the worker keeps trying" }).catch(() => undefined);
}

/** The day's figures, and the daily loss limit. */
export async function dayCheck(bot: Bot): Promise<void> {
  if (!bot.session?.ready || bot.equity() == null) return;
  await bot.refreshDay();
  const d = bot.dayLossNow();
  if (d.limit == null || !bot.day || bot.day.limit_hit_at || d.loss < d.limit) return;
  const now = Date.now();
  // Close-all first: a failed write below must not leave the bot's positions open.
  await bot.setCloseAll("daily_loss_limit");
  bot.day = { ...bot.day, limit_hit_at: iso(now) };
  await bot.store.markDayLimit(bot.day.day, iso(now)).catch((e) => bot.noteError("daily limit (record)", e));
  // The next 17:00 New York: the start of the day that contains (this day's start + 25 h) — correct
  // across a 23- or 25-hour day.
  const nextDay = fxDayStart(fxDayStart(now) + 25 * 3_600_000);
  await bot.pauseEntries(`daily loss limit reached (${d.loss.toFixed(2)} of ${d.limit.toFixed(2)})`, nextDay).catch((e) => bot.noteError("daily limit (pause)", e));
  await bot.event("error", "daily_limit", `Daily loss limit reached: ${d.loss.toFixed(2)} against a limit of ${d.limit.toFixed(2)} (${bot.settings.risk.dailyLossLimitPct}% of the day's starting eligible equity). Closing the bot's positions; entries resume at 17:00 New York.`);
}

export function quotePair(bot: Bot): () => Promise<void> {
  let i = 0;
  return async () => {
    const ready = [...bot.pairs.values()].filter((p) => p.spec);
    if (!ready.length) return;
    const ps = ready[i++ % ready.length];
    await bot.fetchQuote(ps.key, P.BACKGROUND);
  };
}
