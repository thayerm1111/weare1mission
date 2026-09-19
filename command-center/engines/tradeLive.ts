/**
 * TRADE INTELLIGENCE MODE — the server side.
 *
 * Assembles, for one member, the complete picture of their open XAUUSD position: what the broker says it
 * is, what it is worth right now, whether the reason for it still holds, and what THE BRAIN would do
 * about it. It also writes the position's own timeline, so the intelligence stream can replay the trade.
 *
 * Deliberately conservative with the broker: positions are re-read on a cadence, not on every browser
 * poll, because rate limits are route-specific and burning them on a screen refresh is how an execution
 * later fails when it actually matters.
 */
import { db } from "../adapters/db";
import { listPositions, parsePositions } from "../adapters/tradelocker";
import { goldInstrument, session, syncAccountState, selectedAccount } from "./broker";
import { STYLE, styleOf, type Style } from "../core/style";
import { toPips } from "../core/instrument";
import {
  metrics, character, protection, health, tradeFocus, tradeQuestion, tradeRead, tradeThesisState,
  type Character, type LivePosition, type Protection, type TradeMetrics, type TradeHealth, type CharacterRead,
} from "../brain/trade";
import type { MarketSnapshot, Side } from "../core/types";
import type { SnapshotDiff } from "../brain/types";
import { completionRead, COMPLETE_WINDOW_MS, type CompletedTrade, type PendingExecution } from "./experience";

const c = () => {
  const x = db();
  if (!x) throw new Error("Database is not configured");
  return x;
};
const nowIso = () => new Date().toISOString();

/** How often the broker's own position list is re-read. */
const BROKER_SYNC_MS = 12_000;

export type TradeState = {
  active: boolean;
  positionId: string | null;
  accountRowId: string | null;
  side: Side | null;
  style: Style | null;
  entry: number | null;
  qty: number | null;
  initQty: number | null;
  stop: number | null;
  initStop: number | null;
  takeProfit: number | null;
  openedAt: number | null;
  metrics: TradeMetrics | null;
  character: CharacterRead | null;
  health: TradeHealth | null;
  protection: Protection | null;
  thesisState: string | null;
  thesis: { reason?: string; expected?: string; invalidation?: string; invalidationPrice?: number } | null;
  focus: string[];
  question: string | null;
  read: string | null;
  partials: { at: number; fraction: number; qty: number; price?: number }[];
  aiManagement: boolean;
  permissions: Record<string, boolean>;
  /** A close or exit request is out and the broker has not confirmed it yet. */
  exiting: boolean;
  events: { at: number; code: string; detail: string; channel: string }[];
  /** A position found on the broker that the Command Center did not open. */
  unmanaged: { brokerPositionId: string; side: Side; qty: number; entry: number | null }[];
};

export const emptyTrade = (): TradeState => ({
  active: false, positionId: null, accountRowId: null, side: null, style: null, entry: null,
  qty: null, initQty: null, stop: null, initStop: null, takeProfit: null, openedAt: null,
  metrics: null, character: null, health: null, protection: null, thesisState: null, thesis: null,
  focus: [], question: null, read: null, partials: [], aiManagement: false, permissions: {},
  exiting: false, events: [], unmanaged: [],
});

type PositionRow = {
  id: string; user_id: string; account_row_id: string; broker_position_id: string;
  side: Side; style: string | null; entry: number; qty: number; init_qty: number | null;
  init_stop: number; cur_stop: number; take_profit: number | null; opened_at: string;
  pip_size: number | null; pip_value_per_lot: number | null;
  mfe_pips: number | null; mae_pips: number | null; break_even_at: string | null;
  partials: { at: number; fraction: number; qty: number; price?: number }[] | null;
  thesis: Record<string, unknown> | null; ai_management: boolean; permissions: Record<string, boolean> | null;
  health: number | null; last_seen_at: string | null; closed_at: string | null; state: string | null;
};

const toLive = (r: PositionRow): LivePosition => ({
  id: r.id,
  side: r.side,
  style: styleOf(r.style),
  entry: r.entry,
  qty: r.qty,
  initQty: r.init_qty ?? r.qty,
  initStop: r.init_stop,
  curStop: r.cur_stop,
  takeProfit: r.take_profit,
  openedAt: Date.parse(r.opened_at),
  pipSize: r.pip_size ?? 0.1,
  pipValuePerLot: r.pip_value_per_lot,
  mfePips: r.mfe_pips ?? 0,
  maePips: r.mae_pips ?? 0,
  breakEvenAt: r.break_even_at ? Date.parse(r.break_even_at) : null,
  partials: r.partials ?? [],
  thesis: (r.thesis ?? null) as LivePosition["thesis"],
  aiManagement: r.ai_management,
});

/**
 * Re-read the broker's own position list and make the database agree with it.
 *
 * The broker is the truth. If it says a position is gone, it is gone — whatever we last believed — and
 * the trade is closed out with a report rather than left hanging as "open" forever.
 */
async function syncFromBroker(userId: string, accountRowId: string, rows: PositionRow[], price: number | null): Promise<PositionRow[]> {
  const s = await session(userId, accountRowId);
  if (!s.ok) return rows;

  const res = await listPositions(s.session.auth);
  if (!res.ok) return rows;
  const live = parsePositions(res.data);
  const byId = new Map(live.map((p) => [p.id, p]));
  void syncAccountState(s.session);

  const out: PositionRow[] = [];
  for (const r of rows) {
    const b = byId.get(r.broker_position_id);
    if (!b) {
      // Gone from the broker. That is a close, and it is recorded as one.
      await closeOut(userId, r, price);
      continue;
    }
    const patch: Record<string, unknown> = { last_seen_at: nowIso() };
    if (b.qty !== r.qty) {
      const closed = r.qty - b.qty;
      if (closed > 0) {
        const partials = [...(r.partials ?? []), { at: Date.now(), fraction: +(closed / (r.init_qty ?? r.qty)).toFixed(3), qty: +closed.toFixed(4), price: price ?? undefined }];
        patch.partials = partials;
        await event(userId, r.id, "PARTIAL_CONFIRMED", `Broker confirmed ${closed.toFixed(2)} lots closed — ${b.qty.toFixed(2)} still running.`, "voice");
        r.partials = partials;
      }
      patch.qty = b.qty;
      r.qty = b.qty;
    }
    if (b.sl != null && b.sl !== r.cur_stop) {
      patch.cur_stop = b.sl;
      r.cur_stop = b.sl;
    }
    if (b.tp !== undefined && b.tp !== r.take_profit) { patch.take_profit = b.tp; r.take_profit = b.tp; }
    if (b.unrealisedPl != null) patch.unrealized_pnl = b.unrealisedPl;
    await c().from("cc_positions").update(patch).eq("id", r.id);
    out.push(r);
  }

  // Anything the broker has that we do not know about — opened directly in TradeLocker.
  const known = new Set(rows.map((r) => r.broker_position_id));
  const instrument = await goldInstrument(s.session);
  const goldId = instrument.ok ? instrument.spec.tradableInstrumentId : null;
  const unmanaged = live.filter((p) => !known.has(p.id) && (!goldId || p.instrumentId === goldId));
  if (unmanaged.length) {
    await c().from("cc_broker_accounts").update({ updated_at: nowIso() }).eq("id", accountRowId);
  }
  (out as PositionRow[] & { unmanaged?: typeof unmanaged }).unmanaged = unmanaged;
  return out;
}

async function closeOut(userId: string, r: PositionRow, price: number | null): Promise<void> {
  const live = toLive(r);
  const exit = price ?? r.entry;
  const m = metrics(live, exit);
  await c().from("cc_positions").update({
    closed_at: nowIso(), state: "closed", realized_pips: m.pips, qty: 0,
  }).eq("id", r.id);
  await event(userId, r.id, "POSITION_CLOSED", `Position closed at ${exit.toFixed(2)} — ${m.pips >= 0 ? "+" : ""}${Math.round(m.pips)} pips.`, "voice");
  await c().from("cc_trade_reports").insert({
    user_id: userId, position_id: r.id, side: r.side, style: styleOf(r.style),
    entry: r.entry, exit_price: exit, qty: r.init_qty ?? r.qty,
    pips: m.pips, pnl: m.money, r: m.r, mfe_pips: m.mfePips, mae_pips: m.maePips,
    held_ms: Date.now() - Date.parse(r.opened_at), partials: r.partials ?? [],
    exit_reason: "Closed at the broker.", thesis: r.thesis ?? {},
  });
}

async function event(userId: string, positionId: string, code: string, detail: string, channel = "stream", data?: Record<string, unknown>): Promise<void> {
  try {
    await c().from("cc_position_events").insert({ user_id: userId, position_id: positionId, code, detail, channel, data: data ?? null });
  } catch { /* the timeline must never break the trade */ }
}

/**
 * The whole trade picture for this member, right now.
 *
 * `snapshot` is the market read the rest of the Command Center is already using, so the trade and the
 * market can never disagree about the price of gold.
 */
export async function tradeState(userId: string, snapshot: MarketSnapshot | null, diffs: SnapshotDiff[] = []): Promise<TradeState> {
  const out = emptyTrade();
  const account = await selectedAccount(userId);
  if (!account) return out;
  out.accountRowId = account.id;
  out.permissions = account.permissions ?? {};

  const { data } = await c().from("cc_positions").select("*")
    .eq("user_id", userId).eq("account_row_id", account.id).is("closed_at", null)
    .order("opened_at", { ascending: false });
  let rows = (data ?? []) as PositionRow[];

  const stale = !rows.length || rows.some((r) => !r.last_seen_at || Date.now() - Date.parse(r.last_seen_at) > BROKER_SYNC_MS);
  if (stale) {
    const synced = await syncFromBroker(userId, account.id, rows, snapshot?.price ?? null);
    const un = (synced as PositionRow[] & { unmanaged?: { id: string; side: Side; qty: number; avgPrice: number | null }[] }).unmanaged ?? [];
    out.unmanaged = un.map((p) => ({ brokerPositionId: p.id, side: p.side, qty: p.qty, entry: p.avgPrice }));
    rows = synced;
  }
  if (!rows.length) return out;

  const r = rows[0];
  const live = toLive(r);
  const price = snapshot?.price ?? live.entry;
  const m = metrics(live, price);

  // Excursions are RATCHETS — they only ever widen, and they are persisted so a page refresh cannot
  // quietly reset the record of how good or bad this trade actually got.
  const mfe = Math.max(live.mfePips, m.pips);
  const mae = Math.min(live.maePips, m.pips);
  if (mfe !== live.mfePips || mae !== live.maePips) {
    await c().from("cc_positions").update({ mfe_pips: mfe, mae_pips: mae }).eq("id", r.id);
    live.mfePips = mfe;
    live.maePips = mae;
  }
  const m2 = metrics(live, price);

  const ch = snapshot ? character(live, snapshot, m2, diffs) : null;
  const h = ch ? health(live, m2, ch) : null;
  const prot = ch && snapshot ? protection(live, m2, ch, snapshot) : null;

  // Record meaningful movements on the trade's own timeline, on a ladder so it does not chatter.
  if (h && r.health != null && Math.abs(h.score - r.health) >= 8) {
    await event(userId, r.id, "HEALTH_CHANGED", `Position health ${r.health} → ${h.score}.`, "stream", { from: r.health, to: h.score });
  }
  if (h && h.score !== r.health) {
    await c().from("cc_positions").update({
      health: h.score, health_verdict: h.verdict,
      trade_thesis_state: ch ? tradeThesisState(ch) : null,
      unrealized_pnl: m2.money,
    }).eq("id", r.id);
  }

  const { data: evs } = await c().from("cc_position_events")
    .select("at, code, detail, channel").eq("position_id", r.id).order("at", { ascending: false }).limit(40);

  return {
    ...out,
    active: true,
    positionId: r.id,
    side: live.side,
    style: live.style,
    entry: live.entry,
    qty: live.qty,
    initQty: live.initQty,
    stop: live.curStop,
    initStop: live.initStop,
    takeProfit: live.takeProfit,
    openedAt: live.openedAt,
    metrics: m2,
    character: ch,
    health: h,
    protection: prot,
    thesisState: ch ? tradeThesisState(ch) : null,
    thesis: live.thesis,
    focus: snapshot ? tradeFocus(live, m2, snapshot) : [],
    question: snapshot && ch ? tradeQuestion(live, m2, ch, snapshot) : null,
    read: ch && prot ? tradeRead(live, m2, ch, prot) : null,
    partials: live.partials,
    aiManagement: live.aiManagement,
    exiting: r.state === "exit_requested",
    permissions: { ...(account.permissions ?? {}), ...(r.permissions ?? {}) },
    events: ((evs ?? []) as { at: string; code: string; detail: string; channel: string }[])
      .map((e) => ({ at: Date.parse(e.at), code: e.code, detail: e.detail, channel: e.channel })),
  };
}

/**
 * Adopt a position that was opened directly in TradeLocker. The member chooses the style, because the
 * style is what tells THE BRAIN how to manage it — and guessing that would be guessing their intent.
 */
export async function adopt(userId: string, brokerPositionId: string, style: Style): Promise<{ ok: boolean; message: string; positionId?: string }> {
  const account = await selectedAccount(userId);
  if (!account) return { ok: false, message: "No account selected." };
  const s = await session(userId, account.id);
  if (!s.ok) return { ok: false, message: s.reason };
  const res = await listPositions(s.session.auth);
  if (!res.ok) return { ok: false, message: res.error };
  const p = parsePositions(res.data).find((x) => x.id === brokerPositionId);
  if (!p) return { ok: false, message: "That position is no longer open at the broker." };

  const inst = await goldInstrument(s.session);
  const pipSize = inst.ok ? inst.resolved.pipSize : 0.1;
  const stop = p.sl ?? (p.side === "buy" ? (p.avgPrice ?? 0) - STYLE[style].noiseFloorPips * pipSize * 2 : (p.avgPrice ?? 0) + STYLE[style].noiseFloorPips * pipSize * 2);

  const { data, error } = await c().from("cc_positions").upsert({
    user_id: userId, account_id: account.account_id, account_row_id: account.id,
    connection_id: account.connection_id, execution_id: crypto.randomUUID(),
    broker_position_id: p.id, side: p.side, style, mode: style === "quick" ? "scalp" : style,
    strategy: "adopted", entry: p.avgPrice ?? 0, qty: p.qty, init_qty: p.qty,
    init_stop: stop, cur_stop: p.sl ?? stop, take_profit: p.tp ?? null,
    instrument_id: p.instrumentId, route_id: account.route_id,
    pip_size: pipSize, pip_value_per_lot: inst.ok ? inst.resolved.instrument.pipValuePerLot : null,
    state: "open", thesis: { reason: "Opened directly in TradeLocker and handed to THE BRAIN to manage." },
    opened_at: p.openedAt ? new Date(p.openedAt).toISOString() : nowIso(),
    last_seen_at: nowIso(), source: "tradelocker",
  }, { onConflict: "account_id,broker_position_id" }).select("id").single();
  if (error || !data) return { ok: false, message: "Could not take over that position." };

  const id = (data as { id: string }).id;
  await event(userId, id, "POSITION_ADOPTED", `Took over a ${p.side === "buy" ? "BUY" : "SELL"} opened in TradeLocker at ${(p.avgPrice ?? 0).toFixed(2)}, managed as ${STYLE[style].label}.`, "voice");
  if (!p.sl) {
    await event(userId, id, "NO_STOP", "This position has no stop at the broker. I would set one before anything else.", "urgent");
  }
  return { ok: true, message: `Now watching that ${p.side} as a ${STYLE[style].label} trade.`, positionId: id };
}

/** Per-position AI management switch and its granular permissions. */
export async function setAiManagement(userId: string, positionId: string, on: boolean, permissions?: Record<string, boolean>): Promise<boolean> {
  const patch: Record<string, unknown> = { ai_management: on };
  if (permissions) patch.permissions = permissions;
  const { error } = await c().from("cc_positions").update(patch).eq("id", positionId).eq("user_id", userId).is("closed_at", null);
  if (!error) {
    await event(userId, positionId, on ? "AI_MANAGEMENT_ON" : "AI_MANAGEMENT_OFF",
      on ? "THE BRAIN is now managing this position within the permissions you set." : "THE BRAIN is watching this position but will not act on it.", "stream");
  }
  return !error;
}

export { toLive, type Character };


/* ── what the experience state machine needs to know ────────────────────── */

/**
 * An order that is out and unsettled.
 *
 * Only ever the member's own, only ever recent. An execution that has been sitting unsettled for longer
 * than this is not "pending" in any sense a member would recognise — it is a problem, and it belongs in
 * the reconciliation path rather than on the screen as a spinner that never stops.
 */
const PENDING_WINDOW_MS = 4 * 60_000;

export async function pendingExecution(userId: string): Promise<PendingExecution | null> {
  const since = new Date(Date.now() - PENDING_WINDOW_MS).toISOString();
  const { data } = await c().from("cc_trade_executions")
    .select("id, state, uncertain, created_at")
    .eq("user_id", userId)
    .in("state", ["submitting", "order_accepted", "reconciliation_required"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = (data ?? [])[0] as { id: string; state: string; uncertain: boolean | null; created_at: string } | undefined;
  if (!row) return null;
  return { executionId: row.id, state: row.state, at: Date.parse(row.created_at), uncertain: !!row.uncertain };
}

/**
 * The trade that just finished, if one did.
 *
 * Read from the report rather than the position, because the report is the settled record: it is written
 * once, at close, from the broker's own account of what happened.
 */
export async function lastCompleted(userId: string): Promise<CompletedTrade | null> {
  const since = new Date(Date.now() - COMPLETE_WINDOW_MS).toISOString();
  const { data } = await c().from("cc_trade_reports")
    .select("*").eq("user_id", userId).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(1);
  const r = (data ?? [])[0] as {
    created_at: string; side: Side; style: string; entry: number; exit_price: number;
    pips: number | null; pnl: number | null; r: number | null; mfe_pips: number | null;
    mae_pips: number | null; held_ms: number | null; exit_reason: string | null;
  } | undefined;
  if (!r) return null;

  const base = {
    at: Date.parse(r.created_at),
    side: r.side,
    style: r.style,
    pips: Number(r.pips ?? 0),
    r: r.r != null ? Number(r.r) : null,
    money: r.pnl != null ? Number(r.pnl) : null,
    mfePips: Number(r.mfe_pips ?? 0),
    maePips: Number(r.mae_pips ?? 0),
    heldMs: Number(r.held_ms ?? 0),
    entry: Number(r.entry),
    exit: Number(r.exit_price),
    exitReason: r.exit_reason ?? null,
  };
  return { ...base, say: completionRead(base) };
}
