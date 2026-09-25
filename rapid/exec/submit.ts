import type { OrderState, Side } from "../core/types";
import type { BrokerPort } from "./port";

/**
 * The submission state machine.
 *
 * The whole point of this file is the failure paths. A happy submission is three lines; what takes
 * the space is:
 *
 *   - A timeout or 5xx means the order MAY be live. It becomes `submission_unknown`, and the only
 *     legal next step is to ask the broker what happened. It is never resubmitted, because a
 *     database unique constraint cannot un-send an order that already reached the exchange.
 *   - An acknowledgement is not a fill, and a fill is not protection. Protection is only "achieved"
 *     when the broker says so.
 *   - If protection cannot be confirmed within the deadline, the remaining entry quantity is
 *     cancelled and the filled portion is closed. An unprotected position is worse than no trade.
 *   - An emergency close that was merely REQUESTED is not an emergency close that happened.
 */

export type Store = {
  setState(intentId: string, state: OrderState, patch?: Record<string, unknown>): Promise<void>;
  recordBrokerEvent(intentId: string, e: { kind: string; ok: boolean; uncertain?: boolean; error?: string; orderId?: string | null; positionId?: string | null; qty?: number | null; price?: number | null; latencyMs?: number | null; payload?: unknown }): Promise<void>;
  /** Called once, when a fill is confirmed and protection is in place. */
  openPosition(intentId: string, p: { positionId: string; entry: number; qty: number; stop: number; target: number | null; protectionState: "protected" | "unconfirmed" }): Promise<void>;
};

export type SubmitInput = {
  intentId: string;
  intentKey: string;
  side: Side;
  qty: number;
  stop: number;
  target: number | null;
  strategyId: string;
  /** How long protection has to be confirmed before the position is unwound. */
  protectionDeadlineMs: number;
  /** Checked at the last possible instant before the order goes out. */
  stillApproved: () => boolean;
  port: BrokerPort;
  store: Store;
  now?: () => number;
};

export type SubmitOutcome =
  | { state: "protected"; positionId: string; entry: number; qty: number }
  | { state: "unprotected_closed"; positionId: string | null; reason: string }
  | { state: "cancelled"; reason: string }
  | { state: "rejected"; reason: string }
  | { state: "submission_unknown"; reason: string }
  | { state: "deferred"; reason: string };

export async function submitProtected(inp: SubmitInput): Promise<SubmitOutcome> {
  const now = inp.now ?? Date.now;
  const { port, store } = inp;

  // The cancellation token is checked HERE, as late as it can be. Anything earlier leaves a window
  // in which the member turns automation off and an order still goes out.
  if (!inp.stillApproved()) {
    await store.setState(inp.intentId, "cancelled", { error: "cancelled before submission" });
    return { state: "cancelled", reason: "the approval was withdrawn before the order was sent" };
  }

  await store.setState(inp.intentId, "submitting", { submitted_at: new Date(now()).toISOString() });

  const res = await port.submit({ side: inp.side, qty: inp.qty, stopLoss: inp.stop, takeProfit: inp.target, strategyId: inp.strategyId });
  await store.recordBrokerEvent(inp.intentId, {
    kind: "submit", ok: res.ok, uncertain: res.ok ? false : res.uncertain,
    error: res.ok ? undefined : res.error,
    orderId: res.ok ? res.orderId : null, positionId: res.ok ? res.positionId : null,
  });

  if (!res.ok) {
    if (res.sessionClosed) {
      await store.setState(inp.intentId, "cancelled", { error: res.error });
      return { state: "deferred", reason: res.error };
    }
    if (res.uncertain) {
      await store.setState(inp.intentId, "submission_unknown", { error: res.error });
      return { state: "submission_unknown", reason: res.error };
    }
    await store.setState(inp.intentId, "rejected", { error: res.error });
    return { state: "rejected", reason: res.error };
  }

  await store.setState(inp.intentId, "acknowledged", {
    broker_order_id: res.orderId, broker_position_id: res.positionId, ack_at: new Date(now()).toISOString(),
  });

  // Resolve the position. An order id is never substituted for a position id.
  let positionId = res.positionId;
  let fillPrice: number | null = null;
  let filledQty: number | null = null;
  if (!positionId && res.orderId) {
    const resolved = await port.resolvePosition(res.orderId);
    if (resolved) { positionId = resolved.positionId; fillPrice = resolved.fillPrice; filledQty = resolved.filledQty; }
  }
  if (!positionId) {
    await store.setState(inp.intentId, "submission_unknown", { error: "acknowledged but no position could be resolved" });
    return { state: "submission_unknown", reason: "the order was acknowledged but no position could be resolved; reconcile before doing anything else" };
  }

  await store.setState(inp.intentId, "protection_pending", { broker_position_id: positionId });

  // Verify protection against what the broker actually holds, not against what we asked for.
  const deadline = now() + inp.protectionDeadlineMs;
  let protectedOk = false;
  let attempts = 0;
  let lastError = "";
  while (now() < deadline) {
    attempts++;
    const pos = await port.positions();
    if (pos.ok) {
      const row = pos.rows.find((r) => r.positionId === positionId);
      if (row) {
        if (fillPrice == null && row.entry != null) fillPrice = row.entry;
        if (filledQty == null && row.qty != null) filledQty = row.qty;
        if (row.stopLoss != null) { protectedOk = true; break; }
        // No stop on the position: try to attach one.
        const amend = await port.amend(positionId, { stopLoss: inp.stop, ...(inp.target != null ? { takeProfit: inp.target } : {}) });
        await store.recordBrokerEvent(inp.intentId, { kind: "attach_protection", ok: amend.ok, uncertain: amend.ok ? false : amend.uncertain, error: amend.ok ? undefined : amend.error, positionId });
        if (!amend.ok) lastError = amend.error;
      } else {
        // The position is not there. Either it never opened or it has already closed.
        await store.setState(inp.intentId, "closed", { error: "position not present at the broker after acknowledgement" });
        return { state: "submission_unknown", reason: "the position was acknowledged but is not present at the broker; reconcile" };
      }
    } else {
      lastError = pos.error;
    }
  }

  if (!protectedOk) {
    // An unprotected position is unacceptable. Cancel whatever entry quantity is still working and
    // close what filled. Then — and only then — say what actually happened.
    if (res.orderId) {
      const c = await port.cancelOrder(res.orderId);
      await store.recordBrokerEvent(inp.intentId, { kind: "cancel_entry", ok: c.ok, error: c.ok ? undefined : c.error, orderId: res.orderId });
    }
    const closed = await port.close(positionId);
    await store.recordBrokerEvent(inp.intentId, { kind: "emergency_close", ok: closed.ok, uncertain: closed.ok ? false : closed.uncertain, error: closed.ok ? undefined : closed.error, positionId });
    if (!closed.ok) {
      await store.setState(inp.intentId, "protection_pending", { error: `unprotected and the emergency close did not confirm: ${closed.error}` });
      return { state: "unprotected_closed", positionId, reason: `PROTECTION FAILED and the emergency close did not confirm (${closed.error}). Exposure is unresolved and new entries are paused.` };
    }
    await store.setState(inp.intentId, "closed", { error: `protection could not be confirmed (${lastError || "no stop present"}); position closed after ${attempts} attempts` });
    return { state: "unprotected_closed", positionId, reason: `protection could not be confirmed after ${attempts} attempts; the position was closed` };
  }

  const entry = fillPrice ?? 0;
  const qty = filledQty ?? inp.qty;
  await store.setState(inp.intentId, "protected", { fill_price: fillPrice, filled_qty: qty });
  await store.openPosition(inp.intentId, { positionId, entry, qty, stop: inp.stop, target: inp.target, protectionState: "protected" });
  return { state: "protected", positionId, entry, qty };
}
