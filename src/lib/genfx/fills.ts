import { createHash } from "node:crypto";
import { field } from "@/lib/flow/brokerEvidence";
import { type FxPair } from "@/lib/genfx/pairs";

/**
 * GEN FX — ONE CALL ON ONE ACCOUNT, FROM CLAIM TO SETTLED (public.genfx_fills).
 *
 * The row is the account's memory of a call. Its status says exactly how far the order got, so that a
 * crash, a redeploy or a broker that stopped answering mid-order leaves something a later pass can
 * finish — and so that the account is not offered a second trade the same way while the first is still
 * in doubt:
 *
 *   reserved    the claim. Nothing has been sent. (Gone again if the account sits the call out.)
 *   sending     the size and the levels are written; the order is on its way or was on its way.
 *               A row still here two minutes later is a process that died mid-order: the broker is
 *               asked what happened.
 *   placed      the broker accepted the order (its id is stored). No position named yet — it is
 *               resting, or the position has not shown up. Followed until it has a ledger row, or
 *               withdrawn once it has rested past its validity.
 *   uncertain   the send threw. It may have filled. The broker is asked.
 *   cancelled   a resting order was withdrawn. The broker answers "not found" for an order it
 *               cancelled AND for one that had just filled, so this is not final until the broker has
 *               been read in full, more than once, and shows no fill.
 *   managed     final: the position has a ledger row carrying GEN FX's stamp, and the trade manager
 *               runs it.
 *   void        final: nothing came of it. No position, no resting order.
 *
 * Everything that is not final is UNSETTLED, and an unsettled row blocks a new GEN FX entry on the
 * same account, pair and side (the database enforces it: genfx_fills_one_unsettled). Blocking costs a
 * missed trade; not blocking can cost a second position.
 *
 * HOW GEN FX KNOWS AN ORDER IS ITS OWN. Every order carries a label (`fxTag`, sent as the broker's
 * strategyId). The broker returns it on the order's own rows — resting and in its history — and on the
 * position the order opens. An order or a position is this call's when it carries this call's label,
 * or is the order whose id the broker gave back when it accepted this call's order. NOTHING ELSE COUNTS:
 * not the pair, not the side, not the size. A member's own trade of the same size on the same pair is
 * the member's; so is a position some other tool opened. The first version matched on size, and a
 * same-size manual position could be taken for GEN FX's fill, its stop then moved by the trade manager.
 */
export type FillStatus = "reserved" | "sending" | "placed" | "uncertain" | "cancelled" | "managed" | "void";
export const UNSETTLED: FillStatus[] = ["reserved", "sending", "placed", "uncertain", "cancelled"];

/** How long a GEN FX entry order may rest unfilled before it is withdrawn. */
export const ORDER_VALIDITY_MS = 180_000;
/** A claim this old with nothing sent, or a send this old with no answer recorded, is a process that died. */
export const CLAIM_DEAD_MS = 120_000;
/** No attempt to send a call's order starts later than this after its CLAIM — first try, queue, retry, smaller size: one clock for all of them. */
export const SEND_DEADLINE_MS = 45_000;
/**
 * The latest an order can still ARRIVE at the broker, counted from the claim: no attempt starts after
 * the send deadline, an attempt is abandoned after fifteen seconds, and a relay keeps its own call to
 * the broker open five seconds longer than that. A look at the broker before this moment cannot show
 * "nothing came of it" — the order may simply not be there yet.
 */
export const LAST_ARRIVAL_MS = SEND_DEADLINE_MS + 35_000;
/** A send with no trace at the broker — no order, no position — is called dead no sooner than this. */
export const NO_TRACE_VOID_MS = 180_000;
/** A withdrawn order is not written off until this long after its cancel was confirmed… */
export const CANCEL_SETTLE_MS = 30_000;
/** …and nothing is written off on fewer than this many looks at which the broker was read in full and showed no trace. */
export const CLEAN_LOOKS = 2;
/** With the order history unreadable and nothing live at the broker, a row waits this long for the history before it is written off. */
export const HISTORY_WAIT_MS = 15 * 60_000;
/** A position an order opened that is not in the open list, and that the history does not show closed, is waited on quietly for this long. After it the row still holds — nothing is booked on silence — and says so out loud. */
export const CLOSED_UNSEEN_MS = 30 * 60_000;
/** Looks at which the stop on a late-adopted position may fail to confirm before the position is handed to the manager anyway. */
export const PROTECT_TRIES = 5;

const dir = (s: unknown): "buy" | "sell" | null => {
  const d = String(s ?? "").trim().toLowerCase();
  return d === "buy" || d === "sell" ? d : null;
};
/** Do two sides stand in each other's way? The same side does; a side that cannot be read does too. */
export function sameSide(a: unknown, b: unknown): boolean {
  const x = dir(a), y = dir(b);
  return !x || !y || x === y;
}

/**
 * GEN FX's label for one call's order on one account. Worked out from the row's own key, so it never
 * has to be remembered to be known again; 28 characters, inside the broker's limit of 31.
 */
export function fxTag(signalKey: string, accountId: string): string {
  return "gfx-" + createHash("sha256").update(`${signalKey}|${accountId}`).digest("hex").slice(0, 24);
}

/**
 * THE WORST PRICE AN ENTRY MAY FILL AT. The order function prices its limit at the furthest price that
 * still pays 0.8 to 1 — on a 2-to-1 setup that is two-thirds of the stop distance past the price the
 * size was worked out from, so a jump between the quote and the order could fill an account with
 * nearly 1.7 times the risk it was sized for. This caps the chase at a quarter of the stop distance,
 * whatever the stop: the worst fill risks at most 1.25 times the sized amount, and past it the order
 * rests instead of chasing.
 */
export function maxEntryFor(pair: FxPair, side: "buy" | "sell", fillRef: number, stop: number): number {
  const chase = 0.25 * Math.abs(fillRef - stop);
  // Snapped to the pair's price grid toward the SAFE side — a buy's cap down, a sell's up — so rounding
  // can only tighten it. (The hair added before flooring is for 1.0841 arriving as 1.08409999….)
  const g = Math.pow(10, pair.dec);
  return side === "buy" ? Math.floor((fillRef + chase) * g + 1e-6) / g : Math.ceil((fillRef - chase) * g - 1e-6) / g;
}

/* ── reading what the broker sends ────────────────────────────────────────────────────────────── */

/** Broker rows as they arrive, with the column names that go with them (from /trade/config), if those could be read. */
export type Rows = { rows: unknown[]; cols: Record<string, number> | undefined };

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[ _-]/g, "");
const numOf = (v: unknown): number | null => { const n = typeof v === "string" ? parseFloat(v) : Number(v); return v != null && v !== "" && Number.isFinite(n) ? n : null; };
const idOf = (row: unknown, cols: Record<string, number> | undefined): string => {
  const v = field(row, cols, ["id", "orderId", "orderID"]);
  return v == null ? "" : String(v);
};
const tagOf = (row: unknown, cols: Record<string, number> | undefined): string => String(field(row, cols, ["strategyId", "strategyID"]) ?? "").trim().toLowerCase();
const sideOf = (row: unknown, cols: Record<string, number> | undefined): "buy" | "sell" | null => dir(norm(field(row, cols, ["side", "orderSide", "direction"])));
const linkOf = (row: unknown, cols: Record<string, number> | undefined): string | null => {
  const v = field(row, cols, ["positionId", "positionID", "posId"]);
  return v == null || String(v) === "0" || String(v) === "" ? null : String(v);
};
const epochMs = (raw: unknown): number | null => {
  let at: number | null = typeof raw === "number" ? raw : /^\d+(\.\d+)?$/.test(String(raw ?? "").trim()) ? Number(raw) : null;
  if (at == null) { const d = Date.parse(String(raw ?? "")); at = Number.isFinite(d) ? d : null; }
  if (at == null || !(at > 0)) return null;
  return at < 1e12 ? at * 1000 : at;                                      // seconds → milliseconds
};

/**
 * CAN EVERY ROW OF THIS LIST BE READ? The broker sends its rows as bare arrays and the names of the
 * columns separately. Without the names — the config read failed — an array row is a list of numbers
 * that says nothing, and a reader that finds "no status" in it will call a resting order absent and an
 * account free. So a list of array rows needs its column map, with every column the caller is about
 * to rely on. An empty list is an answer ("none"); `null` is not.
 */
export function readable(list: Rows | null | undefined, needs: string[][]): list is Rows {
  if (!list || !Array.isArray(list.rows)) return false;
  if (!list.rows.some((r) => Array.isArray(r))) return list.rows.every((r) => !!r && typeof r === "object");
  const cols = list.cols;
  return !!cols && needs.every((alts) => alts.some((k) => cols[k] != null));
}
export const ORDER_COLUMNS: string[][] = [["id", "orderId"], ["side"], ["status"], ["strategyId"], ["positionId"]];
export const POSITION_COLUMNS: string[][] = [["id", "positionId"], ["tradableInstrumentId", "instrumentId"], ["side"], ["qty", "quantity"]];
const RESTING_COLUMNS: string[][] = [["side"], ["status"], ["positionId"], ["tradableInstrumentId", "instrumentId"]];

/**
 * An order that is finished and can no longer fill — by the status's WHOLE word, and only the words whose
 * meaning is not in doubt. Matched exactly, not by a part of the word: "PendingCancel" and "Cancelling"
 * contain "cancel" and are orders that can still fill. TradeLocker's history also knows "Unplaced" and
 * "Removed"; what those mean on a live account has not been seen, so they are NOT taken as the broker
 * saying "dead" — an order showing one of them is withdrawn by its id like any other (settle.ts), and is
 * written off on that cancel's word and on what the broker shows afterwards.
 */
const FINAL_UNFILLED = new Set(["cancelled", "canceled", "refused", "rejected", "expired"]);
/** "Filled", "PartiallyFilled", "Part Filled", "Partial Fill" — and not "Unfilled". */
const EXECUTED = /^(partially|partial|part)?fill(ed)?$/;

/** Does this broker give GEN FX's label back — on resting orders and in the order history? */
export function carriesLabels(orderCols: Record<string, number> | undefined, historyCols: Record<string, number> | undefined): boolean {
  return orderCols?.strategyId != null && historyCols?.strategyId != null;
}

/**
 * Sides on which this account has a RESTING ENTRY order on `instrumentId` — anybody's, the member's own
 * included: a resting entry is exposure. Null when the list cannot be read; callers fail closed.
 * A row that is finished is not resting; a row LINKED TO A POSITION is that position's protection (its
 * stop or its target) and not an entry. Anything else counts, whatever its type or status says: a stop
 * order with no position behind it is a stop ENTRY, the list is of orders that have not executed, and a
 * status this code has never seen is not proof of "not live". A side that cannot be read blocks both
 * ways. Pure.
 */
export function restingEntrySides(list: Rows | null, instrumentId: string | number): Set<string> | null {
  if (!readable(list, RESTING_COLUMNS)) return null;
  const out = new Set<string>();
  for (const row of list.rows) {
    const inst = field(row, list.cols, ["tradableInstrumentId", "instrumentId", "tradableInstrumentID"]);
    if (inst != null && String(inst) !== String(instrumentId)) continue;     // confirmed another instrument
    const status = norm(field(row, list.cols, ["status", "orderStatus"]));
    if (FINAL_UNFILLED.has(status) || status === "filled") continue;
    if (linkOf(row, list.cols)) continue;
    const side = sideOf(row, list.cols);
    if (!side) { out.add("buy"); out.add("sell"); continue; }
    out.add(side);
  }
  return out;
}

export type Ours = {
  /** This call's entry order(s), by distinct order id. More than one only after a margin retry. */
  seen: number;
  orderIds: string[];
  /** Order ids that can still fill. */
  working: string[];
  filled: boolean;
  filledQty: number;
  avgPrice: number | null;
  /** Positions named by rows that executed. */
  positionIds: string[];
  /** Seen, and every one of them finished with nothing filled. */
  dead: boolean;
  /**
   * Positions that rows which did NOT execute are tied to all the same. Not a fill (a position id is not
   * execution) — but a broker that calls an order cancelled and ties it to a position has said two
   * things, and while such a position is open the call is not written off on the first of them.
   */
  links: string[];
  /** Seen in the history but neither finished nor listed as resting: the broker has not said yet. */
  pending: boolean;
  /** The ids of those: orders of this call's that nothing executed on, that are not resting, and that the history does not call finished. */
  unfinished: string[];
  /**
   * The ids of this call's orders that are FINAL by the history's own word — filled in full, or cancelled
   * / refused (with or without a part fill) — and not listed as resting: nothing more of THAT order can
   * fill. Asked per order, because a call can have more than one row: the attempt the broker refused
   * before the one it took. A refused sibling being final says nothing about the order that was taken —
   * and a sibling whose status this code does not read as final does not keep the taken order open.
   */
  finalIds: string[];
  /** Those of them on which nothing executed: the broker's own word that the order is dead. */
  deadIds: string[];
  /** Was the order history part of this answer? */
  history: boolean;
  /**
   * An order of this call's that the broker TOOK: one still resting, else one that executed. Never a
   * refused attempt — this is the id worth remembering for a call whose own id was never learned.
   */
  liveId: string | null;
  /**
   * The order found by its ID does not carry this call's label. The broker did not give the label back
   * as it was sent — so on this account a send whose id was never learned could not be found again.
   */
  labelLost: boolean;
};

/**
 * WHAT BECAME OF THIS CALL'S ORDER, from the broker's own rows: the resting list (required) and the
 * order history (when it could be read). A row is this call's entry order when its id is the id the
 * broker returned for it, or it carries this call's label ON THIS CALL'S SIDE — a labelled row the
 * other way is the position's protection or its closing order.
 *
 * A fill is EXECUTION: a filled quantity, or a status that says filled. A position id on a row that
 * did not execute is not a fill. An order that part-filled and was then cancelled is filled.
 *
 * Null when the resting list cannot be read, or a labelled row's side cannot be: nothing may be
 * concluded. Pure.
 */
export function ourOrders(working: Rows | null, history: Rows | null, who: { tag: string; orderId?: string | null; side: "buy" | "sell" }): Ours | null {
  if (!readable(working, ORDER_COLUMNS)) return null;
  const histOk = readable(history, ORDER_COLUMNS);
  type One = { executed: boolean; filledQty: number; finishedUnfilled: boolean; fullyFilled: boolean; resting: boolean; final: boolean; link: string | null; pid: string | null; avg: number | null };
  const byId = new Map<string, One>();
  const tag = String(who.tag).trim().toLowerCase();
  const wantId = who.orderId ? String(who.orderId) : "";
  let unreadable = false, labelLost = false;

  const take = (list: Rows, resting: boolean) => {
    for (const row of list.rows) {
      const id = idOf(row, list.cols);
      const byIdMatch = !!wantId && id === wantId;
      if (byIdMatch && tag && tagOf(row, list.cols) !== tag) labelLost = true;
      if (!byIdMatch) {
        if (!tag || tagOf(row, list.cols) !== tag) continue;
        const side = sideOf(row, list.cols);
        if (!side) { unreadable = true; continue; }         // ours by label, but entry or protection cannot be told
        if (side !== who.side) continue;
      }
      if (!id) { unreadable = true; continue; }
      const status = norm(field(row, list.cols, ["status", "orderStatus"]));
      const qty = numOf(field(row, list.cols, ["qty", "quantity", "volume"]));
      const filledQty = numOf(field(row, list.cols, ["filledQty", "filledQuantity", "execQty", "executedQty"])) ?? 0;
      const executed = filledQty > 0 || EXECUTED.test(status);
      // "Finished" is the HISTORY's word. A row still in the resting list is resting, whatever its status
      // reads — the list is of orders that have not finished.
      const finishedUnfilled = !resting && FINAL_UNFILLED.has(status);
      const fullyFilled = status === "filled" || (qty != null && qty > 0 && filledQty >= qty - 1e-9);
      const avg = numOf(field(row, list.cols, ["avgPrice", "averagePrice", "fillPrice"]));
      const cur = byId.get(id) ?? { executed: false, filledQty: 0, finishedUnfilled: false, fullyFilled: false, resting: false, final: false, link: null, pid: null, avg: null };
      cur.executed ||= executed;
      cur.link ??= linkOf(row, list.cols);
      cur.filledQty = Math.max(cur.filledQty, filledQty);
      cur.finishedUnfilled ||= finishedUnfilled;
      cur.fullyFilled ||= fullyFilled;
      if (!resting && (finishedUnfilled || fullyFilled)) cur.final = true;
      // In the resting list, anything not filled in full can still fill — a part-filled order's remainder too.
      if (resting && !fullyFilled) cur.resting = true;
      if (executed) { cur.pid ??= linkOf(row, list.cols); if (avg != null && avg > 0) cur.avg ??= avg; }
      byId.set(id, cur);
    }
  };
  take(working, true);
  if (histOk) take(history, false);
  if (unreadable) return null;

  const all = [...byId.entries()];
  const filled = all.some(([, o]) => o.executed);
  const workingIds = all.filter(([, o]) => o.resting).map(([id]) => id);
  const dead = all.length > 0 && all.every(([, o]) => !o.executed && o.finishedUnfilled && !o.resting);
  return {
    seen: all.length,
    orderIds: all.map(([id]) => id),
    working: workingIds,
    filled,
    filledQty: all.reduce((n, [, o]) => n + o.filledQty, 0),
    avgPrice: all.find(([, o]) => o.avg != null)?.[1].avg ?? null,
    positionIds: [...new Set(all.map(([, o]) => (o.executed ? o.pid : null)).filter((p): p is string => !!p))],
    dead,
    links: [...new Set(all.map(([, o]) => (o.executed ? null : o.link)).filter((p): p is string => !!p))],
    pending: all.length > 0 && !filled && !dead && workingIds.length === 0,
    unfinished: all.filter(([, o]) => !o.executed && !o.resting && !o.final).map(([id]) => id),
    finalIds: all.filter(([, o]) => o.final && !o.resting).map(([id]) => id),
    deadIds: all.filter(([, o]) => o.final && !o.resting && !o.executed && o.finishedUnfilled).map(([id]) => id),
    history: histOk,
    liveId: workingIds[0] ?? all.find(([, o]) => o.executed)?.[0] ?? null,
    labelLost,
  };
}

/**
 * Resting ENTRY orders that COULD be this call's although nothing says so: this instrument and side,
 * no label at all, not a position's protection, and created since the claim (or at a time that cannot
 * be read). Like `suspects` for positions, they are never touched — they are the reason a call whose
 * order id was never learned is not written off yet, on a broker that turned out not to give the label
 * back. An order carrying somebody else's label is somebody else's. Pure.
 */
export function restingSuspects(working: Rows, want: { instrId: string; side: "buy" | "sell"; sinceMs: number }): string[] {
  const out: string[] = [];
  for (const row of working.rows) {
    if (tagOf(row, working.cols)) continue;
    const inst = field(row, working.cols, ["tradableInstrumentId", "instrumentId", "tradableInstrumentID"]);
    if (inst != null && String(inst) !== String(want.instrId)) continue;
    const side = sideOf(row, working.cols);
    if (side != null && side !== want.side) continue;
    const status = norm(field(row, working.cols, ["status", "orderStatus"]));
    if (FINAL_UNFILLED.has(status) || status === "filled") continue;
    if (linkOf(row, working.cols)) continue;
    const at = epochMs(field(row, working.cols, ["createdDate", "createdDateTime", "created"]));
    if (at != null && at < want.sinceMs) continue;
    out.push(idOf(row, working.cols) || "?");
  }
  return out;
}

/**
 * WHAT ELSE THE HISTORY SAYS ABOUT A POSITION, apart from this call's own entry into it. Read from the
 * orders that EXECUTED:
 *   `shared`  it was never this order's alone. An order the SAME way that is not this call's went into
 *             it (on an account that keeps one position per order, the only same-way order a position
 *             has is the one that opened it); or an order tied to it is OLDER than this call's entry —
 *             the position was there before this order was.
 *   `closed`  an order the other way executed against it since the entry: its stop, its target, a close
 *             by hand. Tied to the position — or tied to NO position at all, on this instrument: not
 *             every broker ties a closing order to what it closed.
 * "Older" and "since" are measured on the BROKER'S clock, against this call's own entry row — never the
 * broker's clock against this desk's. (A broker running ten seconds behind would otherwise make a stop
 * hit seconds after the fill look like a trade from before the call.) Until that entry row is in the
 * history neither is said of an order the other way. A row whose side cannot be read is evidence of
 * nothing. Null when the history cannot be read. Pure.
 */
export function positionPast(history: Rows | null, positionId: string, who: { tag: string; orderIds: string[]; side: "buy" | "sell"; instrId?: string | null }): { closed: boolean; shared: boolean } | null {
  if (!readable(history, ORDER_COLUMNS)) return null;
  const tag = String(who.tag).trim().toLowerCase();
  const pid = String(positionId);
  type Seen = { link: string | null; side: "buy" | "sell"; own: boolean; inst: string; first: number | null; last: number | null };
  const rows: Seen[] = [];
  for (const row of history.rows) {
    const status = norm(field(row, history.cols, ["status", "orderStatus"]));
    const done = numOf(field(row, history.cols, ["filledQty", "filledQuantity", "execQty", "executedQty"])) ?? 0;
    if (!(done > 0) && !EXECUTED.test(status)) continue;                 // an order that did not execute changed nothing
    const side = sideOf(row, history.cols);
    if (!side) continue;
    const id = idOf(row, history.cols);
    const made = epochMs(field(row, history.cols, ["createdDate", "createdDateTime", "created"]));
    const moved = epochMs(field(row, history.cols, ["lastModified", "lastModifiedDate", "updated"]));
    const times = [made, moved].filter((t): t is number => t != null);
    rows.push({
      link: linkOf(row, history.cols), side, inst: String(field(row, history.cols, ["tradableInstrumentId", "instrumentId", "tradableInstrumentID"]) ?? ""),
      own: side === who.side && ((!!id && who.orderIds.includes(id)) || (!!tag && tagOf(row, history.cols) === tag)),
      first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null,
    });
  }
  // When this call's own order came into being, by the broker's clock.
  const entry = rows.filter((r) => r.own && r.link === pid).map((r) => r.first).filter((t): t is number => t != null);
  const entryAt = entry.length ? Math.min(...entry) : null;
  let closed = false, shared = false;
  for (const r of rows) {
    if (r.link === pid) {
      if (r.side === who.side) { if (!r.own) shared = true; continue; }
      if (entryAt == null || r.first == null) continue;                   // nothing to measure it against yet
      if (r.first < entryAt) shared = true; else closed = true;
    } else if (!r.link && r.side !== who.side && !!who.instrId && r.inst === String(who.instrId)) {
      if (entryAt != null && r.last != null && r.last >= entryAt) closed = true;
    }
  }
  return { closed, shared };
}

export type FxPos = { id: string; instrId: string; side: "buy" | "sell" | null; /** 0 when the size could not be read. */ qty: number; avg: number | null; tag: string; openedMs: number | null };

/** The account's open positions, read with their label and opening time. Null when the list cannot be read. Pure. */
export function readPositions(list: Rows | null): FxPos[] | null {
  if (!readable(list, POSITION_COLUMNS)) return null;
  const out: FxPos[] = [];
  for (const row of list.rows) {
    const v = field(row, list.cols, ["id", "positionId", "positionID"]);
    const id = v == null ? "" : String(v);
    if (!id) return null;                                   // a position without an id is a row that was not read
    out.push({
      id,
      instrId: String(field(row, list.cols, ["tradableInstrumentId", "instrumentId", "tradableInstrumentID"]) ?? ""),
      side: sideOf(row, list.cols),
      qty: numOf(field(row, list.cols, ["qty", "quantity", "volume", "size"])) ?? 0,
      avg: numOf(field(row, list.cols, ["avgPrice", "openPrice", "price"])),
      tag: tagOf(row, list.cols),
      openedMs: epochMs(field(row, list.cols, ["openDate", "openDateTime", "created", "createdDate"])),
    });
  }
  return out;
}

/**
 * Open positions that COULD be this call's fill although nothing says so: this instrument and side, not
 * in the ledger, carrying no label at all, and opened since the claim (or at a time that cannot be
 * read). They are never adopted — only a label or the order's own id makes a position GEN FX's. They
 * are the reason a call is not written off yet: on a broker that turned out not to put the label on the
 * position, this is where the fill would be, and the order history will say so. A position carrying
 * somebody else's label is somebody else's. Pure.
 */
export function suspects(positions: FxPos[], want: { instrId: string; side: "buy" | "sell"; sinceMs: number }, tracked: Set<string>): FxPos[] {
  // What cannot be read counts: an instrument, a side, a size or a time that is missing is not a "no".
  return positions.filter((p) =>
    !tracked.has(p.id) && !p.tag && (!p.instrId || String(p.instrId) === String(want.instrId)) &&
    (p.side == null || p.side === want.side) &&
    (p.openedMs == null || p.openedMs >= want.sinceMs));
}

/**
 * How long until an unsettled row is looked at again. Every pass for the first ten looks (a fill is
 * usually named within seconds), then every two minutes, then every ten: a row that cannot be settled
 * keeps blocking its account, pair and side, but it does not keep spending the broker's rate limit —
 * and because the pass picks rows by this time, it never crowds out a fresh one.
 */
export function recheckDelayMs(checks: number): number {
  return checks < 10 ? 0 : checks < 40 ? 120_000 : 600_000;
}
