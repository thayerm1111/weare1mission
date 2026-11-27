import type { BrokerPort, BrokerPosition } from "../rapid/exec/port";
import type { Side } from "../rapid/core/types";
import type { Store } from "../rapid/exec/submit";

export type ProtectedOrder = {
  intentId: string; side: Side; qty: number; stop: number; target: number;
  strategyId: string; tick: number; riskBudget: number; valuePerPricePerLot: number;
  /** Broker IDs observed before this order, persisted with its intent before dispatch. */
  preexistingPositionIds: readonly string[];
  onLivePosition?: (row: BrokerPosition, observedAt: number) => void;
  commissionPerLot: number; exitAllowance: number; protectionDeadlineMs: number;
  approved: () => Promise<boolean>; stillOwned: () => boolean;
  /** Persist a close claim before dispatch; shared with member-requested and risk closes. */
  requestClose: (positionId: string, reason: string) => Promise<void>;
  port: BrokerPort; store: Store;
  now?: () => number; wait?: (ms: number) => Promise<void>;
};
export type Submission = { state: "protected" | "rejected" | "cancelled" | "submission_unknown" | "protection_pending"; reason: string };

type ProtectionPlan = Pick<ProtectedOrder, "stop" | "target" | "tick" | "side" | "qty" | "riskBudget" | "valuePerPricePerLot" | "commissionPerLot" | "exitAllowance" | "strategyId">;

export function protectionIssue(row: BrokerPosition, inp: ProtectionPlan): string | null {
  if (row.strategyId !== inp.strategyId || row.side !== inp.side) return "Broker position ownership or side differs from the order.";
  if (![row.entry, row.qty, inp.stop, inp.target, inp.tick, inp.qty, inp.riskBudget, inp.valuePerPricePerLot]
    .every((v) => typeof v === "number" && Number.isFinite(v) && v > 0) ||
    ![inp.commissionPerLot, inp.exitAllowance].every((v) => Number.isFinite(v) && v >= 0)) {
    return "Fill or risk information is incomplete.";
  }
  if (Math.abs(Number(row.qty) - inp.qty) > Math.max(1e-9, inp.qty * 1e-8)) return "Filled quantity differs from the requested quantity.";
  if (row.stopLoss == null || !Number.isFinite(row.stopLoss) || row.stopLoss <= 0) return "TradeLocker did not confirm the stop price.";
  if (row.takeProfit == null || !Number.isFinite(row.takeProfit) || row.takeProfit <= 0) return "TradeLocker did not confirm the target price.";
  if (Math.abs(row.stopLoss - inp.stop) > inp.tick * 1.1) return "Broker stop price differs from the planned stop.";
  if (Math.abs(row.takeProfit - inp.target) > inp.tick * 1.1) return "Broker target price differs from the planned target.";
  const d = inp.side === "buy" ? 1 : -1;
  if (d * (Number(row.entry) - row.stopLoss) <= 0 || d * (row.takeProfit - Number(row.entry)) <= 0) return "Fill is outside the protected stop-to-target range.";
  const loss = (Math.abs(Number(row.entry) - row.stopLoss) + inp.exitAllowance) * Number(row.qty) * inp.valuePerPricePerLot + Number(row.qty) * inp.commissionPerLot;
  if (!Number.isFinite(loss)) return "Filled risk could not be calculated.";
  if (loss > inp.riskBudget + 1e-8) return `Filled risk ${loss.toFixed(2)} exceeds the reserved ${inp.riskBudget.toFixed(2)}.`;
  return null;
}

export function protectionMatches(row: BrokerPosition, inp: ProtectionPlan): boolean {
  return protectionIssue(row, inp) === null;
}

/** One dispatch only. Ambiguous results remain unresolved and cannot generate a retry. */
export async function submitProtected(inp: ProtectedOrder): Promise<Submission> {
  const now = inp.now ?? Date.now;
  const wait = inp.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cancelledBeforeDispatch = "Final account or market checks no longer passed. No order was sent.";
  if (!inp.stillOwned() || !await inp.approved()) {
    await inp.store.setState(inp.intentId, "cancelled", { error: cancelledBeforeDispatch });
    return { state: "cancelled", reason: cancelledBeforeDispatch };
  }
  await inp.store.setState(inp.intentId, "submitting", { submitted_at: new Date(now()).toISOString() });
  if (!inp.stillOwned() || !await inp.approved()) {
    await inp.store.setState(inp.intentId, "cancelled", { error: cancelledBeforeDispatch });
    return { state: "cancelled", reason: cancelledBeforeDispatch };
  }
  let sent;
  try { sent = await inp.port.submit({ side: inp.side, qty: inp.qty, stopLoss: inp.stop, takeProfit: inp.target, strategyId: inp.strategyId }); }
  catch { await inp.store.setState(inp.intentId, "submission_unknown", { error: "Broker dispatch outcome unknown." }); return { state: "submission_unknown", reason: "Broker dispatch outcome unknown; reconcile before another order." }; }
  await inp.store.recordBrokerEvent(inp.intentId, { kind: "submit", ok: sent.ok, uncertain: !sent.ok && sent.uncertain, orderId: sent.ok ? sent.orderId : null, error: sent.ok ? undefined : sent.error });
  if (!sent.ok) {
    const state = sent.uncertain ? "submission_unknown" : "rejected";
    await inp.store.setState(inp.intentId, state, { error: sent.error });
    return { state, reason: sent.error };
  }
  await inp.store.setState(inp.intentId, "acknowledged", { broker_order_id: sent.orderId, broker_position_id: sent.positionId, ack_at: new Date(now()).toISOString() });
  let positionId = sent.positionId;
  if (!positionId && sent.orderId) positionId = (await inp.port.resolvePosition(sent.orderId))?.positionId ?? null;
  if (!positionId) {
    await inp.store.setState(inp.intentId, "submission_unknown", { error: "No confirmed broker position ID." });
    return { state: "submission_unknown", reason: "Order acknowledged; its position is not yet confirmed." };
  }
  // A shared-account order may be merged by a broker into existing exposure. Never claim,
  // amend or close that older position, even if the broker replaces its strategy label.
  if (inp.preexistingPositionIds.includes(positionId)) {
    await inp.store.setState(inp.intentId, "protection_pending", { broker_position_id: positionId,
      error: "The order points to a position that existed before Nitrous submitted it. Shared exposure requires reconciliation." });
    return { state: "protection_pending", reason: "Broker returned pre-existing shared exposure. Nitrous has not adopted or modified it." };
  }
  await inp.store.setState(inp.intentId, "protection_pending", { broker_position_id: positionId });
  const deadline = now() + inp.protectionDeadlineMs;
  let lastRow: BrokerPosition | undefined;
  let amended = false;
  let observed = false;
  let issue = "Broker position could not be verified.";
  for (let attempt = 0; attempt < 12 && now() < deadline && inp.stillOwned(); attempt++) {
    const observedAt = now();
    const positions = await inp.port.positions();
    lastRow = positions.ok ? positions.rows.find((p) => p.positionId === positionId) : lastRow;
    if (!observed && positions.ok && lastRow?.strategyId === inp.strategyId && lastRow.side === inp.side &&
        Number.isFinite(lastRow.entry) && Number(lastRow.entry) > 0 && Number.isFinite(lastRow.qty) && Number(lastRow.qty) > 0) {
      observed = true;
      try { inp.onLivePosition?.(lastRow, observedAt); } catch { /* Notifications cannot interrupt protection. */ }
    }
    if (positions.ok && lastRow) {
      const mismatch = protectionIssue(lastRow, inp);
      if (mismatch === null) {
        await inp.store.openPosition(inp.intentId, { positionId, entry: lastRow.entry!, qty: lastRow.qty!, stop: lastRow.stopLoss!, target: lastRow.takeProfit, protectionState: "protected" });
        await inp.store.setState(inp.intentId, "protected", { fill_price: lastRow.entry, filled_qty: lastRow.qty });
        return { state: "protected", reason: "Fill, quantity and native stop/target confirmed at the broker." };
      }
      issue = mismatch;
    }
    // Never modify a position merely because its ID appeared in an acknowledgement.
    if (positions.ok && inp.stillOwned() && lastRow?.strategyId === inp.strategyId && lastRow.side === inp.side && !lastRow.stopReadUnknown && !lastRow.targetReadUnknown && !amended &&
      (lastRow.stopLoss == null || lastRow.stopLoss <= 0 || lastRow.takeProfit == null || lastRow.takeProfit <= 0)) {
      amended = true;
      const result = await inp.port.amend(positionId, { stopLoss: inp.stop, takeProfit: inp.target });
      await inp.store.recordBrokerEvent(inp.intentId, { kind: "attach_protection", ok: result.ok, positionId, error: result.ok ? undefined : result.error, uncertain: !result.ok && result.uncertain });
    }
    await wait(250);
  }
  // Persist known exposure before the emergency request. A close acknowledgement is not a fill.
  if (lastRow?.strategyId === inp.strategyId && lastRow.side === inp.side && Number(lastRow.entry) > 0 && Number(lastRow.qty) > 0) {
    await inp.store.openPosition(inp.intentId, { positionId, entry: lastRow.entry!, qty: lastRow.qty!, stop: inp.stop, target: inp.target, protectionState: "unconfirmed" });
    if (inp.stillOwned()) await inp.requestClose(positionId, issue);
  }
  await inp.store.setState(inp.intentId, "protection_pending", { error: issue });
  return { state: "protection_pending", reason: issue };
}


