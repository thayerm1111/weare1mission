import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { cancelOrder, listOrders, listOrdersHistory, listPositions, modifyPosition, type TLEnv } from "@/lib/flow/tradelocker";
import { brokerConfig, columnMap } from "@/lib/flow/brokerEvidence";
import { instrumentIdFor } from "@/lib/flow/executor";
import { PAIRS, type PairKey } from "@/lib/genfx/pairs";
import { GENFX_VERSION, OWNER_USER_ID } from "@/lib/genfx/control";
import { ensureLedgerRow, ledgerOwner } from "@/lib/genfx/ledger";
import { releaseFxIfHeldBy, fxResvKey } from "@/lib/genfx/reserve";
import {
  UNSETTLED, ORDER_VALIDITY_MS, LAST_ARRIVAL_MS, NO_TRACE_VOID_MS, CANCEL_SETTLE_MS, CLEAN_LOOKS, HISTORY_WAIT_MS, CLOSED_UNSEEN_MS, PROTECT_TRIES,
  fxTag, ourOrders, readPositions, positionPast, suspects, restingSuspects, recheckDelayMs, type FillStatus, type FxPos, type Rows,
} from "@/lib/genfx/fills";

/**
 * GEN FX — SETTLING THE BOOKS. Every call on every account ends in one of two places: a position the
 * trade manager is running under GEN FX's stamp, or nothing at all. This is what gets each unsettled
 * row (fills.ts) there — within seconds of an entry and about every twenty seconds after — run by
 * whoever holds the GEN FX lock:
 *
 *   • an order the broker accepted is followed until the position it opened has a ledger row — so the
 *     manager runs it (break-even, trail) and its result is booked as GEN FX's. THIS IS THE ONLY PLACE
 *     A GEN FX POSITION IS WRITTEN INTO THE LEDGER (ledger.ts): placement records the order and stops;
 *   • an entry order still resting after its validity is withdrawn — price moved away, and filling
 *     there later would be the chase the limit exists to refuse;
 *   • an order whose send threw, or whose process died mid-order, is looked for AT THE BROKER, BY ITS
 *     LABEL: resting → taken over and followed; filled → its position adopted; no trace, three minutes
 *     on and on two full looks → written off.
 *
 * ONLY A LABEL OR AN ORDER ID MAKES ANYTHING GEN FX'S (fills.ts). Nothing here adopts a position or
 * cancels an order because its pair, side and size fit: a member's own trade fits too.
 *
 * AND A POSITION IS ADOPTED ONLY IF IT IS THIS ORDER'S ALONE. On an account that nets — one position
 * per pair, whatever opened it — the broker would name a position that was already there. So before a
 * position is touched: the ledger is asked whose it is (a row that is not this call's ends it there),
 * and an open position has to be on the order's side, no bigger than the order, and no older than the
 * call. A position that is NOT IN THE OPEN LIST is not taken on trust either: it is booked once the
 * history shows it closed after this order went in, and never if the history shows somebody else's
 * order in it — nor on the history's silence, however long it lasts (half an hour on, that is said out
 * loud). What fails is left exactly as it is — its stop is not moved, nothing is written — and the row
 * stays held, which keeps GEN FX off that account, pair and side until somebody has looked.
 *
 * THE BROKER'S WORD DECIDES, AND SILENCE IS NOT A WORD.
 *   • A list that could not be read — or could not be PARSED, because the column names were missing —
 *     is "unreadable", never "empty". Nothing is concluded from it.
 *   • "The order is dead" is believed only of THIS CALL'S OWN ORDER, by the id the broker gave for it.
 *     A refused attempt carrying the label (the order function tries again without the target when a
 *     broker refuses the pair of them) says nothing about the attempt that came after it.
 *   • A cancel that answers "no such order" is what a broker says about an order it cancelled and
 *     about one that had just filled. A withdrawn order is written off only half a minute or more
 *     after the cancel, on the broker's own word or on two full looks that show no fill.
 *   • A look taken while the order could still have been on its way does not count as "no trace".
 *   • An account is freed only when nothing of the call's can exist: no labelled order resting, no
 *     labelled position, the history silent or saying "cancelled" — and nothing UNLABELLED that could
 *     be it: no position opened on that pair and side since the order, and, for a send whose id was
 *     never learned, no order resting there either. That is where the fill, or the order, would be on a
 *     broker that turned out not to give the label back.
 *
 * GEN FX STANDS ITSELF DOWN ON AN ACCOUNT IT CANNOT RUN SAFELY ON. If an order found by its id does
 * not carry its label, the broker is not giving labels back, and the next send whose answer is lost
 * could not be found. If the broker put an order into a position that was already there, the account
 * nets. Either way both pairs are switched off on that account, once, with the reason in its activity.
 *
 * EXECUTION, ONCE SEEN, IS REMEMBERED (executed_at, position_id). The broker is read afresh on every
 * look and what it shows can lag from one to the next; a look that finds "no trace" of an order an
 * earlier look saw execute has learned nothing. Such a row is settled as a fill or held — never voided.
 *
 * PART FILLS. A position goes into the ledger once nothing more of its order can fill, at the quantity
 * the broker shows then. "Nothing listed as resting" is not that: a part fill can be in the position
 * list before its remainder is in the resting list. So unless the whole order is in, or its own history
 * row is final, the order is withdrawn by its id first — and only a confirmed cancel lets the row close.
 *
 * A POSITION HAS ITS STOP PUT ON AGAIN before it is handed to the manager. Some routes accept an order
 * and drop its stop without a word. If the broker will not take the stop and the target together, the
 * stop goes on alone — the manager re-attaches a missing target itself.
 *
 * Driven from genfx_fills, not from the account locks. Rows are taken by when they are next due
 * (next_check_at), so a row that cannot be settled backs off without crowding out a fresh one; one
 * row failing — a dead login, a broker timeout — does not stop the rest; every write is conditional on
 * the row still being exactly as it was read, so two passes that overlap cannot undo each other or
 * count one look twice.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type FillRow = {
  signal_key: string; account_id: string; user_id: string; connection_id: string | null; acc_num: string | null; environment: string | null;
  pair: PairKey; side: "buy" | "sell"; mode: string | null; setup: string | null; qty: number | null;
  entry: number | null; stop: number | null; tp: number | null; order_id: string | null; position_id: string | null;
  status: FillStatus; created_at: string; updated_at: string; checks: number | null; note?: string | null;
  tag?: string | null; clean?: number | null; cancelled_at?: string | null; next_check_at?: string | null; protect_tries?: number | null;
  /** Set by the first look that saw this call's order execute. From then on the row is never written off. */
  executed_at?: string | null;
};
export type SettleOut = { checked: number; managed: number; voided: number; cancelled: number; held: number; waiting: number };

const BUDGET_MS = 15_000;
/** A row waiting on the broker (resting, just withdrawn, not yet sure) is looked at again no sooner than this. */
const SOON_MS = 10_000;
/** …for this many looks. Past that it is not "waiting" any more, and it backs off like a row that is held. */
const FAST_LOOKS = 40;
/** Clocks differ: a position the broker says opened this long before the call was claimed is still "since the call". */
const CLOCK_SLACK_MS = 10_000;
/** How long the position list is given to catch up with an order history that counts more filled than it shows. */
const CATCH_UP_MS = 30_000;
const UNSEEN_NOTE = "not booked — the position this order opened is not in the broker's open list, and nothing in its history closed it";

export type Ctx = { env: TLEnv; token: string; accNum: string; accountId: string; connId: string };
/** What the broker took when asked to put a position's stop and target on: both, the stop alone, or neither. */
export type Protected = "full" | "stop" | "none";

/** Everything the books pass asks a broker. A null answer always means "could not be read" — never "nothing there". */
export type SettleIo = {
  login(connectionId: string): Promise<{ token: string; env: TLEnv } | null>;
  /** The order history, with its column names when rows are arrays. */
  history(c: Ctx): Promise<Rows | null>;
  /** Orders that have not executed. */
  working(c: Ctx): Promise<Rows | null>;
  /** Open positions, raw. */
  positions(c: Ctx): Promise<Rows | null>;
  instrument(c: Ctx, pair: PairKey): Promise<string | null>;
  /** True only when the broker confirmed the cancel (or said the order is already gone). */
  cancel(c: Ctx, orderId: string): Promise<boolean>;
  /** Put the stop and target on an open position (again). "Already there" counts as taken. */
  protect(c: Ctx, positionId: string, stop: number, tp: number | null): Promise<Protected>;
};

/** The real broker. */
export function brokerIo(): SettleIo {
  const cfgOf = (c: Ctx) => brokerConfig(c.env, c.token, c.accNum, c.accountId).catch(() => null);
  /** Rows with the column names they need. Array rows without names are a list nobody can read: null. */
  const withCols = async (c: Ctx, rows: unknown[], section: string): Promise<Rows | null> => {
    if (!rows.some((r) => Array.isArray(r))) return { rows, cols: undefined };
    const cfg = await cfgOf(c);
    const cols = cfg ? columnMap(cfg, section) : undefined;
    return cols ? { rows, cols } : null;
  };
  return {
    login: (connectionId) => connectionToken(connectionId).then((t) => (t.ok ? { token: t.token, env: t.env } : null)).catch(() => null),
    history: async (c) => { try { const r = await listOrdersHistory(c.env, c.token, c.accNum, c.accountId); return r.ok ? await withCols(c, r.data, "ordersHistoryConfig") : null; } catch { return null; } },
    working: async (c) => { try { const r = await listOrders(c.env, c.token, c.accNum, c.accountId); return r.ok ? await withCols(c, r.data, "ordersConfig") : null; } catch { return null; } },
    positions: async (c) => { try { const r = await listPositions(c.env, c.token, c.accNum, c.accountId); return r.ok ? await withCols(c, r.data, "positionsConfig") : null; } catch { return null; } },
    instrument: async (c, pair) => { try { const id = await instrumentIdFor(c, pair); return id == null ? null : String(id); } catch { return null; } },
    cancel: async (c, orderId) => { try { return (await cancelOrder(c.env, c.token, c.accNum, orderId)).ok; } catch { return false; } },
    protect: async (c, positionId, stop, tp) => {
      // "Nothing to change" is the broker confirming the levels are already there.
      const put = async (levels: { stopLoss: number; takeProfit?: number }): Promise<boolean> => {
        try { const r = await modifyPosition(c.env, c.token, c.accNum, positionId, levels); return r.ok || /nothing to change/i.test(String(r.error)); } catch { return false; }
      };
      if (tp != null && (await put({ stopLoss: stop, takeProfit: tp }))) return "full";
      // The target is the leg brokers most often refuse. The stop is never given up with it.
      return (await put({ stopLoss: stop })) ? (tp == null ? "full" : "stop") : "none";
    },
  };
}

/**
 * Why an open position is NOT this order's alone, or null when nothing says so. `hard` is evidence the
 * account nets (the position is on the other side, or bigger than anything this order could have
 * opened); the rest is something not understood, and is left for a person. Pure.
 */
export function notThisOrders(pos: FxPos, want: { side: "buy" | "sell"; orderQty: number | null; claimMs: number; instrId: string | null }): { why: string; hard: boolean } | null {
  if (pos.side != null && pos.side !== want.side) return { why: "it is on the other side", hard: true };
  if (want.orderQty != null && pos.qty > want.orderQty * (1 + 1e-6)) return { why: `it is ${pos.qty} lots and the order was ${want.orderQty}`, hard: true };
  if (want.instrId && pos.instrId && pos.instrId !== want.instrId) return { why: "it is on another instrument", hard: false };
  if (pos.openedMs != null && pos.openedMs < want.claimMs - CLOCK_SLACK_MS) return { why: "it was opened before the order was sent", hard: false };
  return null;
}

/**
 * Take GEN FX off an account it cannot run safely on: both pairs, on every row of the account. Only
 * the call that actually switches something off says anything, so asking again is free. Never throws.
 */
async function standDown(admin: Admin, f: FillRow, why: string): Promise<void> {
  try {
    const cols = Object.values(PAIRS).map((p) => p.column);
    const { data, error } = await admin.from("flow_broker_accounts").update(Object.fromEntries(cols.map((c) => [c, false])))
      .eq("account_id", f.account_id).or(cols.map((c) => `${c}.eq.true`).join(",")).select("user_id");
    if (error || !Array.isArray(data) || !data.length) return;
    const reason = `genfx: SWITCHED OFF on this account — ${why}`.slice(0, 200);
    const users = [...new Set([f.user_id, ...data.map((r) => String((r as { user_id?: unknown }).user_id ?? "")), OWNER_USER_ID].filter(Boolean))];
    await admin.from("flow_auto_events").insert(users.map((user_id) => ({ user_id, account_id: f.account_id, symbol: f.pair, side: f.side, status: "error", reason })));
  } catch { /* the hold on the row is what keeps the account safe; this is the explanation */ }
}

export async function settleFills(admin: Admin, nowMs = Date.now(), io: SettleIo = brokerIo()): Promise<SettleOut> {
  const out: SettleOut = { checked: 0, managed: 0, voided: 0, cancelled: 0, held: 0, waiting: 0 };
  const started = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  /** This pass's clock: the moment it was given, plus however long it has been running. */
  const clock = () => nowMs + (Date.now() - started);
  let rows: FillRow[] = [];
  try {
    // Only rows that are due, the longest-overdue first.
    const { data, error } = await admin.from("genfx_fills").select("*").in("status", UNSETTLED).lte("next_check_at", iso(nowMs)).order("next_check_at", { ascending: true }).limit(100);
    if (error) return out;
    rows = (data ?? []) as FillRow[];
  } catch { return out; }
  if (!rows.length) return out;

  // One login and one read of each list per account per pass.
  const memo = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    let p = memo.get(key) as Promise<T> | undefined;
    if (!p) { p = run().catch(() => null as T); memo.set(key, p); }
    return p;
  };
  const loginOf = (connId: string) => once(`tok:${connId}`, () => io.login(connId));
  /** The account's broker session: through the connection the order went out on, or — if that one no longer logs in — any other connection the account is on. */
  const ctxOf = (f: FillRow) => once<Ctx | null>(`ctx:${f.account_id}:${f.connection_id ?? ""}`, async () => {
    if (f.connection_id && f.acc_num) {
      const tok = await loginOf(String(f.connection_id));
      if (tok) return { env: tok.env, token: tok.token, accNum: String(f.acc_num), accountId: f.account_id, connId: String(f.connection_id) };
    }
    try {
      const { data, error } = await admin.from("flow_broker_accounts").select("connection_id, acc_num").eq("account_id", f.account_id).limit(10);
      if (error) return null;
      for (const a of (data ?? []) as { connection_id: string | null; acc_num: string | null }[]) {
        if (!a.connection_id || !a.acc_num || String(a.connection_id) === String(f.connection_id ?? "")) continue;
        const tok = await loginOf(String(a.connection_id));
        // The same broker environment only: an account id means nothing on the other one.
        if (tok && (!f.environment || tok.env === f.environment)) return { env: tok.env, token: tok.token, accNum: String(a.acc_num), accountId: f.account_id, connId: String(a.connection_id) };
      }
    } catch { /* fall through */ }
    return null;
  });
  const historyOf = (c: Ctx) => once<Rows | null>(`hist:${c.accountId}`, () => io.history(c));
  const workingOf = (c: Ctx) => once<Rows | null>(`ord:${c.accountId}`, () => io.working(c));
  const positionsOf = (c: Ctx) => once<Rows | null>(`pos:${c.accountId}`, () => io.positions(c));
  const instrOf = (c: Ctx, pair: PairKey) => once<string | null>(`inst:${c.accountId}:${pair}`, () => io.instrument(c, pair));
  /** Position ids on this account the ledger already tracks. Null when unreadable. */
  const trackedOf = (accountId: string) => once<Set<string> | null>(`trk:${accountId}`, async () => {
    try {
      const { data, error } = await admin.from("flow_managed_positions").select("position_id").eq("account_id", accountId)
        .gte("created_at", iso(nowMs - 14 * 86_400_000)).limit(2000);
      if (error) return null;
      return new Set(((data ?? []) as { position_id: string | null }[]).map((r) => String(r.position_id ?? "")).filter(Boolean));
    } catch { return null; }
  });

  for (const f of rows) {
    if (Date.now() - started > BUDGET_MS) break;
    const key = fxResvKey(f.pair, f.side);
    const tag = f.tag || fxTag(f.signal_key, f.account_id);
    const claimMs = Date.parse(f.created_at);
    const age = nowMs - claimMs;
    const looks = (f.checks ?? 0) + 1;
    /**
     * Write to the row only if it is exactly as it was read: the same status, and nobody else's look
     * counted since. False: someone else moved it, or the write failed. Every write counts this look.
     */
    const patch = async (p: Record<string, unknown>): Promise<boolean> => {
      try {
        const { data, error } = await admin.from("genfx_fills").update({ checks: looks, ...p, updated_at: iso(Date.now()) })
          .eq("signal_key", f.signal_key).eq("account_id", f.account_id).eq("status", f.status).eq("checks", f.checks ?? 0).select("account_id");
        return !error && Array.isArray(data) && data.length === 1;
      } catch { return false; }
    };
    const later = (ms: number) => iso(clock() + ms);
    const soon = () => later(looks < FAST_LOOKS ? SOON_MS : recheckDelayMs(looks));
    /** Nothing could be concluded on this look. */
    const hold = async (note?: string, extra: Record<string, unknown> = {}) => { out.held++; await patch({ next_check_at: later(recheckDelayMs(looks)), ...(note ? { note: note.slice(0, 200) } : {}), ...extra }); };
    /** The broker is expected to say more soon. */
    const wait = async (extra: Record<string, unknown> = {}) => { out.waiting++; await patch({ next_check_at: soon(), ...extra }); };
    /** Something this pass asked of the broker did not happen. It is asked again soon, however many looks the row has had. */
    const retry = async (note: string, extra: Record<string, unknown> = {}) => { out.held++; await patch({ next_check_at: soon(), note: note.slice(0, 200), ...extra }); };
    const say = async (status: string, reason: string) => {
      try { await admin.from("flow_auto_events").insert({ user_id: f.user_id ?? OWNER_USER_ID, account_id: f.account_id, symbol: f.pair, side: f.side, status, qty: f.qty, entry: f.entry, stop: f.stop, tp: f.tp, order_id: f.order_id, reason: `genfx: ${reason}`.slice(0, 200) }); } catch { /* a breadcrumb never blocks */ }
    };

    /** The fill is in the ledger under GEN FX's stamp: now, and only now, it is managed. The open ledger row is what blocks the next entry from here on, so the lock goes back. */
    const done = async (positionId: string | null, note?: string, extra: Record<string, unknown> = {}): Promise<void> => {
      if (await patch({ ...extra, status: "managed", position_id: positionId, ...(note ? { note: note.slice(0, 200) } : {}) })) { out.managed++; await releaseFxIfHeldBy(admin, f.account_id, key, f.signal_key); }
      else out.held++;                                           // the stamped ledger row finishes it on the next pass
    };
    /** Nothing came of it: write the row off, free the account if the lock is still this call's, and mark its placement breadcrumbs as an order that is dead. */
    const voidIt = async (note: string): Promise<void> => {
      if (!(await patch({ status: "void", note: note.slice(0, 200) }))) { out.held++; return; }
      await releaseFxIfHeldBy(admin, f.account_id, key, f.signal_key);
      try {
        await admin.from("flow_auto_events").update({ status: "cancelled" })
          .eq("account_id", f.account_id).eq("symbol", f.pair).eq("side", f.side).in("status", ["placed", "uncertain"]).like("reason", "genfx%")
          .gte("created_at", iso(claimMs - 2_000));
      } catch { /* cosmetic */ }
      out.voided++;
    };

    try {
      out.checked++;
      if (!Number.isFinite(claimMs)) { await hold("this row's own time could not be read"); continue; }

      // What the ledger already holds under this call's stamp. (A write here that was lost after the
      // ledger row was made leaves exactly this: a position that is in, and a row that does not say so.)
      const mine = await admin.from("flow_managed_positions").select("position_id").eq("account_id", f.account_id).eq("signal_id", f.signal_key).eq("strategy_version", GENFX_VERSION).limit(20);
      if (mine.error) { await hold("the ledger could not be read"); continue; }
      const stamped = [...new Set(((mine.data ?? []) as { position_id: string | null }[]).map((r) => r.position_id).filter((x): x is string => !!x).map(String))];

      // 1. Claimed, never sent: the "sending" write comes before the order, so nothing left this desk.
      //    (A claim is first due two minutes after it was made; the write is refused if it has moved on.)
      if (f.status === "reserved" && !stamped.length) { await voidIt("claimed but never sent"); continue; }

      const ctx = await ctxOf(f);
      if (!ctx) { await hold("no broker login for this account"); continue; }
      const [work, hist, posRows, instrId, tracked] = await Promise.all([workingOf(ctx), historyOf(ctx), positionsOf(ctx), instrOf(ctx, f.pair), trackedOf(f.account_id)]);

      // 2. What the broker says became of this call's order — by its id, or by its label. Nothing is
      //    concluded, about a fill or about its absence, unless the resting list could be read.
      const ours = ourOrders(work, hist, { tag, orderId: f.order_id, side: f.side });
      if (!ours) { await hold("the broker's orders could not be read"); continue; }
      if (ours.labelLost) await standDown(admin, f, "this broker did not give the order's label back as it was sent, so an order whose answer was lost could not be found again");
      const positions = readPositions(posRows);
      const labelled = (positions ?? []).filter((p) => p.tag === tag);
      // EXECUTION, ONCE SEEN, IS REMEMBERED. The position id on this row was put there by a look that saw
      // the order execute — placement's own (it is read off the order's executed history row) or an
      // earlier pass's — and `executed_at` by a pass that saw it execute, whether or not a position was
      // named. What the broker shows NOW can lag, or be unreadable; it cannot un-fill an order.
      const named = f.position_id ? [String(f.position_id)] : [];
      const pids = [...new Set([...stamped, ...ours.positionIds, ...labelled.map((p) => p.id), ...named])];
      const filled = stamped.length > 0 || ours.filled || labelled.length > 0 || named.length > 0 || !!f.executed_at;
      // The id worth keeping for a call that never learned its own: an order the broker TOOK, never a refused attempt.
      const orderId = f.order_id ?? ours.liveId;
      /** What every write from here on carries: the order's id once it is learned and — from the first look that sees it execute — that it did, and into which position. */
      const keep: Record<string, unknown> = {
        ...(orderId && !f.order_id ? { order_id: orderId } : {}),
        ...(filled && !f.executed_at ? { executed_at: iso(clock()) } : {}),
        ...(filled && !f.position_id && pids[0] ? { position_id: pids[0] } : {}),
      };

      // 3. Something of this call's is listed as resting: it can still fill.
      if (ours.working.length) {
        // Left to rest only while nothing has filled, inside its validity, and not already withdrawn once.
        if (!filled && f.status !== "cancelled" && age < ORDER_VALIDITY_MS) {
          // An unanswered send that turns out to be resting is taken over: it has an id now, and a clock.
          await wait(f.status === "placed" && f.order_id ? {} : { status: "placed", order_id: orderId, clean: 0 });
          continue;
        }
        let gone = true;
        for (const id of ours.working) if (!(await io.cancel(ctx, id))) gone = false;
        if (!gone) { await retry(filled ? "part filled; the broker did not confirm the cancel of the rest" : "the broker did not confirm the cancel", keep); continue; }
        if (!filled && f.status !== "cancelled") {
          // Withdrawn — or already gone. Which, is for the next looks to find out.
          if (await patch({ status: "cancelled", ...keep, cancelled_at: iso(clock()), clean: 0, next_check_at: later(SOON_MS) })) out.cancelled++; else out.held++;
        } else {
          // Part filled and the rest withdrawn, or still listed after an earlier cancel: look again. The
          // confirmed cancel is remembered — it is what lets the position be booked at the size it has then.
          await wait({ ...keep, ...(f.cancelled_at ? {} : { cancelled_at: iso(clock()) }) });
        }
        continue;
      }

      // 4. It executed — by what this look shows, or by what an earlier one did. Every position it opened
      //    goes into the ledger ONCE NOTHING MORE OF THE ORDER CAN FILL, and not before.
      if (filled) {
        const orderQty = f.qty != null && Number(f.qty) > 0 ? Number(f.qty) : null;
        // "Not listed as resting" does not answer that: a part fill can be in the position list before
        // its remainder is in the resting list. One of these does:
        //   • all of it is in — the position holds the order's whole size, or the broker counts it filled;
        //   • the order's OWN history row is final (filled in full, or cancelled / refused after a part) —
        //     the row of the order the broker took: by its id, or, for a send whose id was never learned,
        //     the labelled order that executed. (One attempt of a call is ever taken; see fills.Ours.finalIds.)
        //   • this desk withdrew the order and the broker confirmed it;
        //   • a ledger row already carries this call's stamp (an earlier look settled the question);
        //   • for a send whose id was never learned: nothing of it has been listed as resting, its whole validity long.
        const inQty = pids.reduce((n, id) => n + ((positions ?? []).find((p) => p.id === id)?.qty ?? 0), 0);
        const whole = orderQty != null && Math.max(inQty, ours.filledQty) >= orderQty * (1 - 1e-6);
        const taken = f.order_id ? String(f.order_id) : ours.liveId;
        const closedOut = ours.history && taken != null && ours.finalIds.includes(taken);
        const final = stamped.length > 0 || whole || closedOut || !!f.cancelled_at || (!orderId && age >= ORDER_VALIDITY_MS);
        // Otherwise the rest of the order has not been heard of, and it is withdrawn BY ITS ID — first,
        // whatever else this look finds: cancelling this call's own order is always safe. (For an order
        // that had filled in full the broker answers "already gone", which is the same confirmation.)
        let restUnconfirmed = false;
        if (!final && orderId) {
          if (await io.cancel(ctx, String(orderId))) keep.cancelled_at = iso(clock());
          else restUnconfirmed = true;
        }

        if (!pids.length) { await hold("the order executed, but the broker names no position for it", keep); continue; }
        if (!positions) { await hold("filled; the broker's positions could not be read", keep); continue; }
        if (f.stop == null || (f.entry == null && !ours.avgPrice)) { await hold("filled, but this row carries no levels to write a ledger row from", keep); continue; }
        const ownIds = [...new Set([...ours.orderIds, ...(f.order_id ? [String(f.order_id)] : [])])];
        let stuck: { note: string; soon?: boolean; tried?: boolean; alarm?: boolean } | null = null;
        let foreign: { why: string; hard: boolean } | null = null;
        let unprotected = false, tpOff = false;
        for (const pid of pids) {
          // WHOSE IS IT? Asked of the ledger before the position is touched.
          const owner = await ledgerOwner(admin, f.account_id, pid, f.signal_key);
          if (owner === null) { stuck = { note: "the ledger could not be read" }; break; }
          if (owner === "mine") continue;                       // already in, under this call's stamp
          const pos = positions.find((p) => p.id === pid) ?? null;
          const odd = pos ? notThisOrders(pos, { side: f.side, orderQty, claimMs, instrId }) : null;
          if (owner === "other") { foreign = { why: `another trade's ledger row already holds it${odd ? ` (and ${odd.why})` : ""}`, hard: !!odd?.hard }; break; }
          if (pos) {
            foreign = odd;
            if (foreign) break;
            // Its stop and target are put on (again) BEFORE the manager is given it.
            const prot = await io.protect(ctx, pid, Number(f.stop), f.tp == null ? null : Number(f.tp));
            if (prot === "none") {
              if ((f.protect_tries ?? 0) + 1 < PROTECT_TRIES) { stuck = { note: "the stop could not be confirmed on the position — trying again", soon: true, tried: true }; break; }
              unprotected = true;
            } else if (prot === "stop") tpOff = true;
            // The history counts more filled than the position list shows: the list is a moment behind.
            // Booked at the size it shows once it has caught up — a look or two — not at the part.
            const fresh = !f.executed_at || nowMs - Date.parse(f.executed_at) < CATCH_UP_MS;
            if (final && fresh && pos.qty > 0 && ours.filledQty > pos.qty * (1 + 1e-6)) { stuck = { note: "filled; the broker's position list has not caught up with its order history yet", soon: true }; break; }
          } else {
            // NOT IN THE OPEN LIST. It closed already — or it is not listed yet — or, on an account that
            // nets, it was never this order's: the broker named a position that was there before and has
            // since gone. The history says which, and until it does nothing is booked: closed is believed
            // when an order executed against the position after this order went in; an order that is not
            // this call's having gone into the same position is the account netting. A history that says
            // neither is not taken for "closed", however long it goes on saying nothing — half an hour on
            // it is said out loud, and the row goes on holding the account, pair and side.
            const past = positionPast(hist, pid, { tag, orderIds: ownIds, side: f.side, instrId });
            if (past?.shared) { foreign = { why: "the broker's history shows another order in the same position", hard: true }; break; }
            if (!past?.closed) {
              stuck = age < CLOSED_UNSEEN_MS
                ? { note: "the position this order opened is not in the broker's open list, and its history does not show it closed yet", soon: true }
                : { note: UNSEEN_NOTE, alarm: true };
              break;
            }
          }
          if (!final) continue;                                 // booked only once nothing can add to it
          // The broker's own numbers are the real ones, when they are in sight of what the order was sized at.
          const avg = pos?.avg ?? ours.avgPrice;
          const sane = avg != null && avg > 0 && f.entry != null && Math.abs(avg - Number(f.entry)) <= 2 * Math.abs(Number(f.entry) - Number(f.stop));
          const entry = sane ? avg : f.entry != null ? Number(f.entry) : avg;
          const qty = pos && pos.qty > 0 ? pos.qty : ours.filledQty > 0 ? ours.filledQty : orderQty;
          if (entry == null || qty == null) { stuck = { note: "filled, but neither the broker nor this row gives a size and a price" }; break; }
          const led = await ensureLedgerRow(admin, {
            userId: f.user_id, connectionId: f.connection_id, accountId: f.account_id, accNum: f.acc_num, environment: f.environment,
            positionId: pid, pair: f.pair, side: f.side, entry: Number(entry), stop: Number(f.stop), tp: f.tp == null ? null : Number(f.tp), qty: Number(qty),
            mode: f.mode, signalKey: f.signal_key, setup: f.setup,
          });
          if (!led.ok) {
            if (led.how === "other_owner") foreign = { why: "another trade's ledger row already holds it", hard: false };
            else stuck = { note: `the ledger row could not be written (${led.how})` };
            break;
          }
        }
        if (foreign) {
          // NOT THIS ORDER'S ALONE. Nothing is touched and nothing is written; the row stays, and blocks.
          const note = `not adopted — the broker tied this order to a position that is not this order's alone: ${foreign.why}`;
          if (foreign.hard) await standDown(admin, f, "the broker put a GEN FX order into a position that was already open (the account nets its positions)");
          if (!String(f.note ?? "").startsWith("not adopted")) await say("error", `${note} — CHECK THIS ACCOUNT`);
          await hold(note, keep);
          continue;
        }
        if (stuck) {
          if (stuck.alarm && !String(f.note ?? "").startsWith(UNSEEN_NOTE)) await say("error", `${UNSEEN_NOTE} — CHECK THIS ACCOUNT`);
          if (stuck.soon) await retry(stuck.note, { ...keep, ...(stuck.tried ? { protect_tries: (f.protect_tries ?? 0) + 1 } : {}) });
          else await hold(stuck.note, keep);
          continue;
        }
        if (!final) {
          // In, protected, and not booked yet: the next look books it at the size the position has then.
          if (restUnconfirmed) await retry("part of the order is in; the broker did not confirm the cancel of the rest", keep);
          else await wait(keep);
          continue;
        }
        if (unprotected) await say("error", "the stop could not be confirmed on a position — CHECK SL/TP ON THE POSITION");
        else if (tpOff) await say("placed", "filled; the broker would not take the target with the stop, so the stop went on alone — the trade manager re-attaches the target");
        await done(pids[0], unprotected ? "managed; its stop could not be confirmed with the broker" : undefined, keep);
        continue;
      }

      // 5. No fill in sight, on this look or any before it. Is anything of it left that could still become one?
      // The broker's word on THIS CALL'S OWN ORDER — the one whose id it gave when it took it: finished,
      // nothing executed, no position behind it. (A refused earlier attempt alone proves nothing about
      // the attempt that followed it; and by here nothing of the call is resting or has executed.)
      if (ours.history && f.order_id && ours.deadIds.includes(String(f.order_id))) {
        // …unless the same rows tie the order to a position that is open and nobody's: then the broker
        // has said two things, and the call is neither adopted nor written off on one of them.
        if (ours.links.length) {
          if (!positions || !tracked) { await hold("the broker's positions could not be read", keep); continue; }
          if (ours.links.some((id) => !tracked.has(id) && positions.some((p) => p.id === id))) { await hold("the broker's history calls the order cancelled, yet ties it to a position that is open — not adopted, not written off", keep); continue; }
        }
        const settled = f.status !== "cancelled" || nowMs - Date.parse(f.cancelled_at ?? f.updated_at) >= CANCEL_SETTLE_MS;
        if (settled) await voidIt("the broker cancelled or refused the order before it filled"); else await wait();
        continue;
      }
      // AN ORDER THE BROKER TOOK, of which it now shows nothing resting and nothing final — no trace of it
      // yet, or a row whose status says neither (fills.ts) — is given its validity and then withdrawn BY
      // ITS ID. Before anything else is weighed: cancelling this call's own order is always safe, and an
      // order nobody withdrew is one that can fill when nobody is looking.
      const cancelIds = [...new Set([...(f.order_id ? [String(f.order_id)] : []), ...ours.unfinished])];
      if (cancelIds.length && f.status !== "cancelled") {
        if (age < ORDER_VALIDITY_MS) { await wait(keep); continue; }
        let gone = true;
        for (const id of cancelIds) if (!(await io.cancel(ctx, id))) gone = false;
        if (!gone) { await retry("the broker did not confirm the cancel", keep); continue; }
        if (await patch({ status: "cancelled", order_id: f.order_id ?? cancelIds[0], cancelled_at: iso(clock()), clean: 0, next_check_at: later(SOON_MS) })) out.cancelled++; else out.held++;
        continue;
      }
      if (!positions || !tracked || !instrId) { await hold("the broker's positions could not be read", keep); continue; }
      const since = { instrId, side: f.side, sinceMs: claimMs - CLOCK_SLACK_MS };
      if (suspects(positions, since, tracked).length) { await hold("an unlabelled position opened on this pair and side since the order — waiting for the broker's history to say whose it is", keep); continue; }
      // A send whose id was never learned is known by its label alone. An unlabelled order resting
      // where it would be is not touched — and is reason enough not to call the account free.
      if (!f.order_id && restingSuspects(work as Rows, since).length) { await hold("an unlabelled order is resting on this pair and side since the send — waiting for the broker to say whose it is", keep); continue; }

      // 6. Nothing of it is live anywhere the broker could show it: no labelled order resting, none filled;
      //    no labelled position; nothing unlabelled that could be it. Written off only once it has had time
      //    to show up, on more than one full look — and, where the history could not be read, only after
      //    waiting for it, because a fill that had already closed is in the history and nowhere else.
      if (!ours.history && age < HISTORY_WAIT_MS) { await hold("the broker's order history could not be read", keep); continue; }
      const cancelled = f.status === "cancelled";
      const quiet = cancelled ? nowMs - Date.parse(f.cancelled_at ?? f.updated_at) : age;
      // A look counts only if the order could no longer have been on its way when it was taken.
      const clean = (f.clean ?? 0) + (cancelled || age >= LAST_ARRIVAL_MS ? 1 : 0);
      // A withdrawn order the history calls cancelled — or shows nothing of — is given half a minute. One
      // the history still shows, unexecuted and not final, is given as long as an order with no trace.
      const enough = cancelled && !ours.pending ? CANCEL_SETTLE_MS : NO_TRACE_VOID_MS;
      if (clean >= CLEAN_LOOKS && quiet >= enough) {
        const tail = ours.history ? "" : " (order history unreadable — a fill that had already closed would not be booked)";
        await voidIt((cancelled ? "withdrawn; the broker shows no fill" : "no order or position at the broker") + tail);
        continue;
      }
      // A send that died mid-order is promoted, so the row says what it is.
      await wait({ ...keep, clean, ...(f.status === "sending" ? { status: "uncertain" } : {}) });
    } catch {
      await hold();
    }
  }
  return out;
}
