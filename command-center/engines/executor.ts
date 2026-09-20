/**
 * THE EXECUTION ENGINE.
 *
 * Everything in this file exists to prevent two failures that cost real money:
 *
 *   1. SENDING THE SAME ORDER TWICE. A double-click, a browser refresh, a worker retry and a network
 *      timeout must all mean ONE order. The unique idempotency key is claimed in the database BEFORE the
 *      broker is contacted, so a second attempt finds the first and reports its state instead of trading.
 *
 *   2. BELIEVING SOMETHING THAT DID NOT HAPPEN. An accepted order is not an open position, and a timeout
 *      is not a failure — it is an unknown. On any uncertain outcome this engine RECONCILES against the
 *      broker's own view and never, under any circumstance, re-sends.
 *
 * THE BRAIN cannot call anything here directly. Only an authorised path can, and only after the
 * deterministic validator has approved.
 */
import { randomUUID } from "node:crypto";
import { db } from "../adapters/db";
import { audit } from "../adapters/db";
import {
  createOrder, closePosition, modifyPosition, listPositions, ordersHistory, parsePositions, orderIdOf,
  getConfig, positionColumns, DEFAULT_POSITION_COLUMNS, type PositionColumns,
} from "../adapters/tradelocker";
import { stopMoveAllowed } from "../core/risk";
import { roundPrice, roundQty, toPips } from "../core/instrument";
import { STYLE_MODE, type Style } from "../core/style";
import type { MarketSnapshot, Side } from "../core/types";
import { goldInstrument, session, syncAccountState, type Session } from "./broker";
import { accountHistory } from "./accountHistory";
import { validate, type Sizing } from "./validator";

/** The execution lifecycle, as the product reports it. Order state and position state are NOT the same. */
export type ExecState =
  | "submitting" | "order_accepted" | "waiting_for_fill" | "position_open"
  | "modification_requested" | "modification_confirmed"
  | "close_requested" | "position_closed"
  | "error" | "reconciliation_required";

const c = () => {
  const x = db();
  if (!x) throw new Error("Database is not configured");
  return x;
};

const nowIso = () => new Date().toISOString();

/* ── preparing ──────────────────────────────────────────────────────────── */

export type PrepareInput = {
  accountRowId: string;
  side: Side;
  style: Style;
  entry: number | null;
  stop: number;
  takeProfit: number | null;
  riskPct: number;
  origin: "member" | "brain" | "auto";
  snapshot: MarketSnapshot | null;
  thesis?: Record<string, unknown> | null;
  evidence?: string[];
};

export type Prepared =
  | { ok: true; intentId: string; sizing: Sizing; price: number; warnings: string[]; instrument: { pipSize: number; minLot: number; lotStep: number; source: string }; account: { equity: number | null; currency: string | null; isLive: boolean } }
  | { ok: false; reason: string; hard: boolean; warnings: string[] };

/**
 * Work out what this trade would actually be, and write the intent down BEFORE anything is sent.
 * An intent that is never executed is a harmless row; an execution with no recorded intent is untraceable.
 */
export async function prepare(userId: string, i: PrepareInput): Promise<Prepared> {
  const s = await session(userId, i.accountRowId);
  if (!s.ok) return { ok: false, reason: s.reason, hard: true, warnings: [] };

  const inst = await goldInstrument(s.session);
  if (!inst.ok) return { ok: false, reason: inst.reason, hard: true, warnings: [] };

  const state = await syncAccountState(s.session);
  const equity = state?.equity ?? state?.balance ?? s.session.account.equity ?? s.session.account.balance ?? null;

  const open = await openPositionsFor(userId, i.accountRowId);
  // The day's real losses, streak and cooldown. Unreadable history is a refusal inside validate().
  const history = await accountHistory(userId, i.accountRowId, equity ?? 0);

  const v = validate({
    account: s.session.account,
    snapshot: i.snapshot,
    side: i.side,
    style: i.style,
    entry: i.entry,
    stop: i.stop,
    takeProfit: i.takeProfit,
    riskPct: i.riskPct,
    equity,
    instrument: inst.resolved.instrument,
    pipSize: inst.resolved.pipSize,
    spread: i.snapshot?.spread ?? null,
    openPositions: open.length,
    openRiskPct: 0,
    history,
    origin: i.origin,
  });
  if (!v.ok) return { ok: false, reason: v.reason, hard: v.hard, warnings: v.warnings };

  const { data, error } = await c().from("cc_trade_intents").insert({
    user_id: userId,
    account_row_id: i.accountRowId,
    origin: i.origin,
    side: i.side,
    style: i.style,
    entry: v.referencePrice,
    stop: i.stop,
    targets: i.takeProfit != null ? [i.takeProfit] : [],
    risk_pct: i.riskPct,
    qty: v.sizing.qty,
    risk_amount: v.sizing.riskAmount,
    stop_pips: v.sizing.stopPips,
    snapshot_at: i.snapshot ? new Date(i.snapshot.at).toISOString() : null,
    thesis: i.thesis ?? null,
    evidence: i.evidence ?? [],
    status: "prepared",
  }).select("id").single();
  if (error || !data) return { ok: false, reason: "Could not record the trade intent.", hard: true, warnings: v.warnings };

  return {
    ok: true,
    intentId: (data as { id: string }).id,
    sizing: v.sizing,
    price: v.referencePrice,
    warnings: v.warnings,
    instrument: {
      pipSize: inst.resolved.pipSize,
      minLot: inst.resolved.instrument.minLot,
      lotStep: inst.resolved.instrument.lotStep,
      source: inst.resolved.source,
    },
    account: { equity, currency: s.session.account.currency, isLive: s.session.account.is_live },
  };
}


/**
 * The broker's position column order, read once per process.
 *
 * /trade/config is static for a connection, so asking on every order would be waste. Cached with the
 * safe defaults as a fallback: getting the columns slightly wrong degrades a field, while not asking
 * at all was what dropped every position row.
 */
let positionColsCache: { at: number; cols: PositionColumns } | null = null;
async function positionColumnsFor(sess: Session): Promise<PositionColumns> {
  if (positionColsCache && Date.now() - positionColsCache.at < 3600_000) return positionColsCache.cols;
  try {
    const cfg = await getConfig(sess.auth);
    const cols = cfg.ok ? positionColumns(cfg.data) : DEFAULT_POSITION_COLUMNS;
    positionColsCache = { at: Date.now(), cols };
    return cols;
  } catch {
    return DEFAULT_POSITION_COLUMNS;
  }
}

async function openPositionsFor(userId: string, accountRowId: string) {
  const { data } = await c().from("cc_positions")
    .select("id, broker_position_id, side, qty, entry")
    .eq("user_id", userId).eq("account_row_id", accountRowId).is("closed_at", null);
  return (data ?? []) as { id: string; broker_position_id: string | null; side: string; qty: number; entry: number }[];
}

/* ── executing ──────────────────────────────────────────────────────────── */

export type ExecuteResult = {
  ok: boolean;
  state: ExecState;
  executionId: string;
  orderId?: string | null;
  positionId?: string | null;
  message: string;
  /** True when the outcome is genuinely unknown and reconciliation is still running. Never a failure. */
  uncertain?: boolean;
};

/**
 * Send the order.
 *
 * `idempotencyKey` must be stable for one intended trade: generate it in the UI when the confirm button is
 * first rendered, not when it is clicked, so a double-click carries the same key.
 */
export async function execute(userId: string, intentId: string, idempotencyKey: string, snapshot: MarketSnapshot | null): Promise<ExecuteResult> {
  const key = `${userId}:${idempotencyKey}`.slice(0, 200);

  // 1. Claim the key FIRST. If this insert loses the race, another attempt owns this trade and we report
  //    its state rather than sending anything.
  const claim = await c().from("cc_trade_executions").insert({
    user_id: userId, intent_id: intentId, idempotency_key: key, state: "submitting",
  }).select("id").single();

  if (claim.error) {
    const { data: existing } = await c().from("cc_trade_executions")
      .select("id, state, broker_order_id, broker_position_id, error")
      .eq("idempotency_key", key).eq("user_id", userId).maybeSingle();
    if (existing) {
      const e = existing as { id: string; state: ExecState; broker_order_id: string | null; broker_position_id: string | null; error: string | null };
      return {
        ok: e.state !== "error",
        state: e.state,
        executionId: e.id,
        orderId: e.broker_order_id,
        positionId: e.broker_position_id,
        message: e.state === "error" ? (e.error ?? "That order was rejected.") : "That order has already been sent — showing its current state rather than sending it again.",
      };
    }
    return { ok: false, state: "error", executionId: "", message: "Could not start the execution." };
  }
  const executionId = (claim.data as { id: string }).id;

  const fail = async (message: string, state: ExecState = "error") => {
    await c().from("cc_trade_executions").update({ state, error: message.slice(0, 400), settled_at: nowIso() }).eq("id", executionId);
    await c().from("cc_trade_intents").update({ status: "rejected", reject_reason: message.slice(0, 300) }).eq("id", intentId);
    return { ok: false, state, executionId, message };
  };

  // 2. Re-read everything. The market has moved since the preview was rendered.
  const { data: intentRow } = await c().from("cc_trade_intents").select("*").eq("id", intentId).eq("user_id", userId).maybeSingle();
  if (!intentRow) return fail("That trade intent no longer exists.");
  const intent = intentRow as {
    id: string; account_row_id: string; side: Side; style: Style; entry: number | null; stop: number;
    targets: number[]; risk_pct: number; status: string; thesis: Record<string, unknown> | null;
  };
  if (intent.status === "executed") return fail("That intent has already been executed.");

  const s = await session(userId, intent.account_row_id);
  if (!s.ok) return fail(s.reason);
  const inst = await goldInstrument(s.session);
  if (!inst.ok) return fail(inst.reason);

  const st = await syncAccountState(s.session);
  const equity = st?.equity ?? st?.balance ?? s.session.account.equity ?? null;
  const open = await openPositionsFor(userId, intent.account_row_id);
  const history = await accountHistory(userId, intent.account_row_id, equity ?? 0);

  const v = validate({
    account: s.session.account, snapshot, side: intent.side, style: intent.style,
    entry: null, stop: intent.stop, takeProfit: intent.targets?.[0] ?? null,
    riskPct: intent.risk_pct, equity, instrument: inst.resolved.instrument, pipSize: inst.resolved.pipSize,
    spread: snapshot?.spread ?? null, openPositions: open.length, openRiskPct: 0, history, origin: "member",
  });
  if (!v.ok) return fail(v.reason);

  /*
   * THE BROKER IS ASKED BEFORE THE ORDER GOES, AND THE BROKER IS THE TRUTH.
   *
   * Everything above this line — the interlock, the cooldown, the hourly count, the one-position limit
   * — is computed from cc_positions, which is OUR record of what we opened. On the first live night a
   * dropped `if` in parsePositions meant nothing was ever written there, so all four guards read an
   * empty table, agreed nothing was open, and let the next entry through. Every twenty-five seconds.
   * Eighteen orders. Fourteen live positions on a funded account.
   *
   * Not one of those guards was wrong. They were all reading the same bookkeeping, and the bookkeeping
   * was broken — which is exactly the failure mode that reading our own records can never catch.
   *
   * So the last question before an order is sent goes to the broker: do I ALREADY hold gold on this
   * account? It costs one call on the act path only, and it is immune to any bug in our own records.
   *
   * IT FAILS CLOSED. If the broker cannot be asked, the answer is no. "I cannot tell whether I am
   * already in this trade" is not a reason to enter it again.
   */
  const liveCheck = await listPositions(s.session.auth);
  if (!liveCheck.ok) {
    return fail("Could not read the broker's open positions, so THE BRAIN cannot tell whether it is already in this trade. Refusing rather than risking a second entry.");
  }
  const cols = await positionColumnsFor(s.session);
  const alreadyOpen = parsePositions(liveCheck.data, cols)
    .filter((p) => !inst.ok || !p.instrumentId || p.instrumentId === inst.spec.tradableInstrumentId);
  if (alreadyOpen.length) {
    return fail(
      `The broker already reports ${alreadyOpen.length} open position${alreadyOpen.length === 1 ? "" : "s"} ` +
      `on this account. THE BRAIN holds one at a time.`,
    );
  }

  await c().from("cc_trade_intents").update({ status: "executing" }).eq("id", intentId);
  await c().from("cc_trade_executions").update({ account_row_id: intent.account_row_id, qty: v.sizing.qty }).eq("id", executionId);

  // 3. Send it. strategyId carries our own id so a broker row can always be traced back to a reason.
  const tag = `cc-${executionId.replace(/-/g, "").slice(0, 26)}`;
  const spec = inst.spec;
  const order = await createOrder(s.session.auth, {
    tradableInstrumentId: spec.tradableInstrumentId,
    routeId: spec.routeId,
    qty: roundQty(v.sizing.qty, inst.resolved.instrument),
    side: intent.side,
    type: "market",
    validity: "IOC",
    stopLoss: roundPrice(intent.stop, spec),
    takeProfit: intent.targets?.[0] != null ? roundPrice(intent.targets[0], spec) : undefined,
    strategyId: tag,
  });

  await audit({
    actor: "command-center", action: "order_submitted", userId, accountId: s.session.account.account_id,
    reason: `${intent.side} ${v.sizing.qty} XAUUSD, stop ${intent.stop}`, price: v.referencePrice,
  });

  if (!order.ok) {
    if (order.uncertain) {
      // The single most dangerous moment in the whole system. We do NOT resend. We go and look.
      await c().from("cc_trade_executions").update({
        state: "reconciliation_required", uncertain: true, error: order.error.slice(0, 400),
      }).eq("id", executionId);
      const rec = await reconcile(userId, executionId, tag);
      return { ...rec, uncertain: true };
    }
    return fail(order.error || "The broker rejected that order.");
  }

  const orderId = orderIdOf(order.data);
  await c().from("cc_trade_executions").update({
    state: "order_accepted", broker_order_id: orderId, last_response: (order.data ?? null) as Record<string, unknown> | null,
  }).eq("id", executionId);

  // 4. Accepted is not open. Go and confirm against the broker's own position list.
  const rec = await reconcile(userId, executionId, tag);
  if (rec.state === "position_open") {
    await c().from("cc_trade_intents").update({ status: "executed" }).eq("id", intentId);
  }
  return rec;
}

/* ── reconciliation ─────────────────────────────────────────────────────── */

/** How long after submitting we keep looking before calling it unresolved. */
const RECONCILE_TRIES = 4;
const RECONCILE_GAP_MS = 1200;

/**
 * Ask the broker what actually happened, and write down only what it says.
 *
 * Matching is by our own strategyId tag first. Only if that is absent do we fall back to shape matching
 * (instrument, side, and opened within the last two minutes) — and that fallback is deliberately narrow,
 * because adopting the wrong position is worse than admitting we are unsure.
 */
export async function reconcile(userId: string, executionId: string, tag?: string): Promise<ExecuteResult> {
  const { data: row } = await c().from("cc_trade_executions").select("*").eq("id", executionId).eq("user_id", userId).maybeSingle();
  if (!row) return { ok: false, state: "error", executionId, message: "Unknown execution." };
  const exec = row as {
    id: string; intent_id: string | null; account_row_id: string | null; qty: number | null;
    broker_order_id: string | null; reconcile_count: number; state: ExecState;
  };
  if (exec.state === "position_open" || exec.state === "position_closed") {
    return { ok: true, state: exec.state, executionId, message: "Already settled." };
  }
  if (!exec.account_row_id) return { ok: false, state: "error", executionId, message: "Execution has no account." };

  const s = await session(userId, exec.account_row_id);
  if (!s.ok) return { ok: false, state: "reconciliation_required", executionId, message: s.reason };

  const { data: intentRow } = exec.intent_id
    ? await c().from("cc_trade_intents").select("*").eq("id", exec.intent_id).maybeSingle()
    : { data: null };
  const intent = intentRow as {
    side: Side; style: Style; stop: number; targets: number[]; account_row_id: string; thesis: Record<string, unknown> | null; risk_pct: number;
  } | null;

  const inst = await goldInstrument(s.session);
  const instrumentId = inst.ok ? inst.spec.tradableInstrumentId : null;

  for (let attempt = 0; attempt < RECONCILE_TRIES; attempt++) {
    const pos = await listPositions(s.session.auth);
    if (pos.ok) {
      const rows = parsePositions(pos.data);
      const raw = JSON.stringify(pos.data ?? "");
      const tagged = tag && raw.includes(tag)
        ? rows.find((p) => raw.indexOf(tag) > -1 && (!instrumentId || p.instrumentId === instrumentId))
        : undefined;
      const candidate = tagged ?? rows.find((p) =>
        (!instrumentId || p.instrumentId === instrumentId) &&
        (!intent || p.side === intent.side) &&
        (p.openedAt == null || Date.now() - p.openedAt < 120_000));

      if (candidate) {
        const positionRowId = await recordPosition(userId, s.session, executionId, candidate, intent, inst.ok ? inst.resolved.pipSize : null, inst.ok ? inst.resolved.instrument.pipValuePerLot : null);
        await c().from("cc_trade_executions").update({
          state: "position_open", broker_position_id: candidate.id, fill_price: candidate.avgPrice,
          settled_at: nowIso(), reconcile_count: exec.reconcile_count + attempt + 1, uncertain: false,
        }).eq("id", executionId);
        return { ok: true, state: "position_open", executionId, orderId: exec.broker_order_id, positionId: positionRowId, message: "Position open." };
      }
    }

    /*
     * NO POSITION YET — WAS OUR ORDER REJECTED, AND IF SO, WHY?
     *
     * This used to stringify the WHOLE orders history and test two things independently: does the blob
     * contain our order id, and does the blob contain the word "Cancelled" anywhere at all. Those are
     * unrelated facts. Any cancelled order in the account's history — someone else's, a FLOW order from
     * last week — made every one of our orders report as cancelled, whatever actually happened to it.
     *
     * So the diagnosis could be pure coincidence, and the broker's real reason, which is sitting in the
     * row, was never read. Now the row matching OUR order id is found, and only that row decides. Its
     * contents are attached to the error, because "the broker said no" is not an answer anybody can act
     * on — an order history row is market metadata, no credentials pass through here.
     */
    const hist = await ordersHistory(s.session.auth);
    if (hist.ok && exec.broker_order_id) {
      const row = findOrderRow(hist.data, exec.broker_order_id);
      if (row) {
        const rowText = JSON.stringify(row);
        if (/(Cancelled|Canceled|Rejected|Refused)/i.test(rowText)) {
          const detail = `The broker rejected the order. It said: ${rowText.slice(0, 400)}`;
          await c().from("cc_trade_executions").update({ state: "error", error: detail.slice(0, 500), settled_at: nowIso() }).eq("id", executionId);
          return { ok: false, state: "error", executionId, message: detail };
        }
      }
    }

    if (attempt < RECONCILE_TRIES - 1) await new Promise((r) => setTimeout(r, RECONCILE_GAP_MS));
  }

  await c().from("cc_trade_executions").update({
    state: "reconciliation_required", reconcile_count: exec.reconcile_count + RECONCILE_TRIES,
  }).eq("id", executionId);
  return {
    ok: false,
    state: "reconciliation_required",
    executionId,
    orderId: exec.broker_order_id,
    uncertain: true,
    message: "The order went to the broker but no matching position has appeared yet. Nothing will be re-sent — THE BRAIN is still checking.",
  };
}


/**
 * Find the orders-history row for ONE order id.
 *
 * The shape varies by broker build — rows may be objects keyed by name or columnar arrays whose
 * indices come from /trade/config — so this does not assume either. It walks the payload and returns
 * the first row that actually contains the id, which is the only row entitled to say what happened to
 * that order.
 */
export function findOrderRow(body: unknown, orderId: string): unknown | null {
  const want = String(orderId);
  const seen = new Set<unknown>();

  const containsId = (node: unknown): boolean => {
    if (node == null) return false;
    if (typeof node !== "object") return String(node) === want;
    if (Array.isArray(node)) return node.some((v) => typeof v !== "object" && String(v) === want);
    return Object.values(node as Record<string, unknown>)
      .some((v) => typeof v !== "object" && String(v) === want);
  };

  const walk = (node: unknown, depth: number): unknown | null => {
    if (node == null || typeof node !== "object" || depth > 5 || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) {
        if (containsId(child)) return child;
        const deeper = walk(child, depth + 1);
        if (deeper) return deeper;
      }
      return null;
    }
    for (const child of Object.values(node as Record<string, unknown>)) {
      if (containsId(child)) return child;
      const deeper = walk(child, depth + 1);
      if (deeper) return deeper;
    }
    return null;
  };

  return walk(body, 0);
}

async function recordPosition(
  userId: string,
  s: Session,
  executionId: string,
  p: { id: string; side: Side; qty: number; avgPrice: number | null; sl: number | null; tp: number | null; instrumentId: string; openedAt: number | null },
  intent: { side: Side; style: Style; stop: number; targets: number[]; thesis: Record<string, unknown> | null } | null,
  pipSize: number | null,
  pipValuePerLot: number | null,
): Promise<string | null> {
  const style = intent?.style ?? "hold";
  const entry = p.avgPrice ?? 0;
  const stop = p.sl ?? intent?.stop ?? 0;
  const { data, error } = await c().from("cc_positions").upsert({
    user_id: userId,
    account_id: s.account.account_id,
    account_row_id: s.account.id,
    connection_id: s.account.connection_id,
    execution_id: executionId,
    broker_position_id: p.id,
    side: p.side,
    style,
    mode: STYLE_MODE[style],
    strategy: "command_center",
    entry,
    qty: p.qty,
    init_qty: p.qty,
    init_stop: stop,
    cur_stop: stop,
    take_profit: p.tp ?? intent?.targets?.[0] ?? null,
    targets: intent?.targets ?? [],
    instrument_id: p.instrumentId,
    route_id: s.account.route_id,
    pip_size: pipSize,
    pip_value_per_lot: pipValuePerLot,
    state: "open",
    thesis: intent?.thesis ?? {},
    opened_at: p.openedAt ? new Date(p.openedAt).toISOString() : nowIso(),
    last_seen_at: nowIso(),
    source: "command_center",
  }, { onConflict: "account_id,broker_position_id" }).select("id").single();
  if (error || !data) return null;
  const id = (data as { id: string }).id;
  await c().from("cc_position_events").insert({
    user_id: userId, position_id: id, code: "POSITION_OPEN", channel: "voice",
    detail: `${p.side === "buy" ? "BUY" : "SELL"} XAUUSD opened at ${entry.toFixed(2)}.`,
    price: entry, data: { qty: p.qty, stop, style },
  });
  return id;
}

/* ── managing an open position ──────────────────────────────────────────── */

export type ManageAction =
  | { kind: "close" }
  | { kind: "partial"; fraction: number }
  | { kind: "break_even"; offsetPips?: number }
  | { kind: "move_stop"; price: number }
  | { kind: "take_profit"; price: number | null };

export type ManageResult = { ok: boolean; message: string; state?: ExecState };

/**
 * Act on an open position. Every path re-reads the position from the database, re-checks that it belongs
 * to this member, and — for anything touching the stop — runs it past the one-way guard that will not let
 * a stop move away from the trade.
 */
export async function manage(userId: string, positionRowId: string, action: ManageAction, actor: "member" | "brain"): Promise<ManageResult> {
  const { data: row } = await c().from("cc_positions").select("*").eq("id", positionRowId).eq("user_id", userId).is("closed_at", null).maybeSingle();
  if (!row) return { ok: false, message: "That position is not open." };
  const pos = row as {
    id: string; account_row_id: string; broker_position_id: string; side: Side; qty: number; entry: number;
    cur_stop: number; pip_size: number | null; permissions: Record<string, boolean> | null; partials: unknown[];
    ai_management: boolean;
  };

  const s = await session(userId, pos.account_row_id);
  if (!s.ok) return { ok: false, message: s.reason };
  const inst = await goldInstrument(s.session);
  const spec = inst.ok ? inst.spec : null;
  const pipSize = pos.pip_size ?? (inst.ok ? inst.resolved.pipSize : 0.1);

  // THE BRAIN may only do what this account has explicitly allowed it to do.
  if (actor === "brain") {
    const perm = { ...(s.session.account.permissions ?? {}), ...(pos.permissions ?? {}) };
    const needed =
      action.kind === "close" ? "ai_close"
      : action.kind === "partial" ? "ai_partial"
      : action.kind === "break_even" ? "ai_break_even"
      : "ai_protect_stop";
    if (!pos.ai_management) return { ok: false, message: "AI management is off for this position." };
    if (!perm[needed]) return { ok: false, message: `THE BRAIN is not permitted to ${action.kind.replace("_", " ")} on this account.` };
  }

  const event = async (code: string, detail: string, channel = "stream", data?: Record<string, unknown>) => {
    await c().from("cc_position_events").insert({ user_id: userId, position_id: pos.id, code, detail, channel, data: data ?? null });
  };

  if (action.kind === "close") {
    await c().from("cc_positions").update({ state: "exit_requested" }).eq("id", pos.id);
    const r = await closePosition(s.session.auth, pos.broker_position_id, 0);
    if (!r.ok) {
      await c().from("cc_positions").update({ state: "open" }).eq("id", pos.id);
      return { ok: false, message: r.uncertain ? "The close request went out but the broker has not confirmed it. THE BRAIN is checking rather than sending it again." : r.error, state: r.uncertain ? "reconciliation_required" : "error" };
    }
    await event("CLOSE_REQUESTED", "Close requested — waiting for the broker to confirm.", "voice");
    return { ok: true, message: "Close requested. The position is marked closed only once the broker confirms it.", state: "close_requested" };
  }

  if (action.kind === "partial") {
    const f = Math.min(0.95, Math.max(0.05, action.fraction));
    const qty = inst.ok ? roundQty(pos.qty * f, inst.resolved.instrument) : +(pos.qty * f).toFixed(2);
    if (!(qty > 0)) return { ok: false, message: "That partial is smaller than the minimum lot this broker accepts." };
    if (qty >= pos.qty) return { ok: false, message: "That would close the whole position — use Close instead." };
    const r = await closePosition(s.session.auth, pos.broker_position_id, qty);
    if (!r.ok) return { ok: false, message: r.uncertain ? "The partial went out but is unconfirmed. THE BRAIN is checking." : r.error };
    await event("PARTIAL_TAKEN", `Took ${Math.round(f * 100)}% off — ${qty} lots.`, "voice", { qty, fraction: f });
    return { ok: true, message: `Partial sent: ${qty} lots.` };
  }

  if (action.kind === "break_even" || action.kind === "move_stop") {
    const target = action.kind === "move_stop"
      ? action.price
      : pos.side === "buy"
        ? pos.entry + (action.offsetPips ?? 0) * pipSize
        : pos.entry - (action.offsetPips ?? 0) * pipSize;

    const guard = stopMoveAllowed(pos.side, pos.cur_stop, target);
    if (!guard.ok) return { ok: false, message: guard.reason };

    const price = spec ? roundPrice(target, spec) : +target.toFixed(2);
    const r = await modifyPosition(s.session.auth, pos.broker_position_id, { stopLoss: price });
    if (!r.ok) return { ok: false, message: r.uncertain ? "The stop change went out but is unconfirmed. THE BRAIN is checking rather than sending it again." : r.error, state: r.uncertain ? "reconciliation_required" : "error" };

    await c().from("cc_positions").update({
      cur_stop: price,
      break_even_at: action.kind === "break_even" ? nowIso() : undefined,
    }).eq("id", pos.id);
    const locked = Math.round(toPips(pos.side === "buy" ? price - pos.entry : pos.entry - price, pipSize));
    await event(
      action.kind === "break_even" ? "STOP_TO_BREAK_EVEN" : "STOP_MOVED",
      action.kind === "break_even"
        ? `Stop moved to break even${locked > 0 ? ` +${locked} pips` : ""} at ${price.toFixed(2)}.`
        : `Stop moved to ${price.toFixed(2)}${locked > 0 ? ` — ${locked} pips locked in` : ""}.`,
      "voice", { price, lockedPips: locked },
    );
    return { ok: true, message: `Stop is now ${price.toFixed(2)}.`, state: "modification_confirmed" };
  }

  // take profit
  const tp = action.price == null ? null : spec ? roundPrice(action.price, spec) : +action.price.toFixed(2);
  const r = await modifyPosition(s.session.auth, pos.broker_position_id, { takeProfit: tp });
  if (!r.ok) return { ok: false, message: r.uncertain ? "The target change is unconfirmed. THE BRAIN is checking." : r.error };
  await c().from("cc_positions").update({ take_profit: tp }).eq("id", pos.id);
  await event("TARGET_MOVED", tp == null ? "Target removed." : `Target set to ${tp.toFixed(2)}.`, "stream", { tp });
  return { ok: true, message: tp == null ? "Target removed." : `Target is now ${tp.toFixed(2)}.`, state: "modification_confirmed" };
}

export const newIdempotencyKey = () => randomUUID();

/** Test seam — the reconciler's order-row lookup, exported so its coincidence bug stays fixed. */
export { findOrderRow as __findOrderRow };
