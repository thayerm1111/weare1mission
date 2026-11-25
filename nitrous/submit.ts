import type { BrokerPort, BrokerPosition } from "../rapid/exec/port";
import type { Side } from "../rapid/core/types";
import type { Store } from "../rapid/exec/submit";

export type ProtectedOrder = {
  intentId: string; side: Side; qty: number; stop: number; target: number;
  strategyId: string; tick: number; riskBudget: number; valuePerPricePerLot: number;
  commissionPerLot: number; exitAllowance: number; protectionDeadlineMs: number;
  approved: () => Promise<boolean>; stillOwned: () => boolean;
  /** Persist a close claim before dispatch; shared with member-requested and risk closes. */
  requestClose: (positionId: string, reason: string) => Promise<void>;
  port: BrokerPort; store: Store;
  now?: () => number; wait?: (ms: number) => Promise<void>;
};
export type Submission = { state: "protected" | "rejected" | "cancelled" | "submission_unknown" | "protection_pending"; reason: string };

export function protectionMatches(row: BrokerPosition, inp: Pick<ProtectedOrder, "stop" | "target" | "tick" | "side" | "qty" | "riskBudget" | "valuePerPricePerLot" | "commissionPerLot" | "exitAllowance" | "strategyId">): boolean {
  if (![row.entry, row.qty, row.stopLoss, row.takeProfit, inp.stop, inp.target, inp.tick, inp.qty, inp.riskBudget, inp.valuePerPricePerLot]
    .every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) return false;
  if (![inp.commissionPerLot, inp.exitAllowance].every((v) => Number.isFinite(v) && v >= 0)) return false;
  if (row.strategyId !== inp.strategyId || row.side !== inp.side || !(Number(row.entry) > 0) || !(Number(row.qty) > 0)) return false;
  if (Math.abs(Number(row.qty) - inp.qty) > Math.max(1e-9, inp.qty * 1e-8) || row.stopLoss == null || row.takeProfit == null) return false;
  if (Math.abs(row.stopLoss - inp.stop) > inp.tick * 1.1 || Math.abs(row.takeProfit - inp.target) > inp.tick * 1.1) return false;
  const d = inp.side === "buy" ? 1 : -1;
  if (d * (Number(row.entry) - row.stopLoss) <= 0 || d * (row.takeProfit - Number(row.entry)) <= 0) return false;
  const loss = (Math.abs(Number(row.entry) - row.stopLoss) + inp.exitAllowance) * Number(row.qty) * inp.valuePerPricePerLot + Number(row.qty) * inp.commissionPerLot;
  return Number.isFinite(loss) && loss <= inp.riskBudget + 1e-8;
}

/** One dispatch only. Ambiguous results remain unresolved and cannot generate a retry. */
export async function submitProtected(inp: ProtectedOrder): Promise<Submission> {
  const now = inp.now ?? Date.now;
  const wait = inp.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!inp.stillOwned() || !await inp.approved()) {
    await inp.store.setState(inp.intentId, "cancelled", { error: "Account approval changed before dispatch." });
    return { state: "cancelled", reason: "Account approval changed before dispatch." };
  }
  await inp.store.setState(inp.intentId, "submitting", { submitted_at: new Date(now()).toISOString() });
  if (!inp.stillOwned() || !await inp.approved()) {
    await inp.store.setState(inp.intentId, "cancelled", { error: "Account approval withdrawn before dispatch." });
    return { state: "cancelled", reason: "Account approval withdrawn before dispatch." };
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
  await inp.store.setState(inp.intentId, "protection_pending", { broker_position_id: positionId });
  const deadline = now() + inp.protectionDeadlineMs;
  let lastRow: BrokerPosition | undefined;
  let amended = false;
  for (let attempt = 0; attempt < 12 && now() < deadline && inp.stillOwned(); attempt++) {
    const positions = await inp.port.positions();
    lastRow = positions.ok ? positions.rows.find((p) => p.positionId === positionId) : lastRow;
    if (lastRow && protectionMatches(lastRow, inp)) {
      await inp.store.openPosition(inp.intentId, { positionId, entry: lastRow.entry!, qty: lastRow.qty!, stop: lastRow.stopLoss!, target: lastRow.takeProfit, protectionState: "protected" });
      await inp.store.setState(inp.intentId, "protected", { fill_price: lastRow.entry, filled_qty: lastRow.qty });
      return { state: "protected", reason: "Fill, quantity and native stop/target confirmed at the broker." };
    }
    // Never modify a position merely because its ID appeared in an acknowledgement.
    if (inp.stillOwned() && lastRow?.strategyId === inp.strategyId && lastRow.side === inp.side && !amended &&
      (lastRow.stopLoss == null || lastRow.stopLoss <= 0 || lastRow.takeProfit == null || lastRow.takeProfit <= 0)) {
      amended = true;
      const result = await inp.port.amend(positionId, { stopLoss: inp.stop, takeProfit: inp.target });
      await inp.store.recordBrokerEvent(inp.intentId, { kind: "attach_protection", ok: result.ok, positionId, uncertain: !result.ok && result.uncertain });
    }
    await wait(250);
  }
  // Persist known exposure before the emergency request. A close acknowledgement is not a fill.
  if (lastRow?.strategyId === inp.strategyId && lastRow.side === inp.side && Number(lastRow.entry) > 0 && Number(lastRow.qty) > 0) {
    await inp.store.openPosition(inp.intentId, { positionId, entry: lastRow.entry!, qty: lastRow.qty!, stop: inp.stop, target: inp.target, protectionState: "unconfirmed" });
    if (inp.stillOwned()) await inp.requestClose(positionId, "Protection or filled risk could not be verified");
  }
  await inp.store.setState(inp.intentId, "protection_pending", { error: "Protection or filled risk could not be confirmed; exposure requires reconciliation." });
  return { state: "protection_pending", reason: "Protection or filled risk requires reconciliation. New entries are blocked." };
}
