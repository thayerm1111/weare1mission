import { partialOnce, type PartialStore, type PartialIntent } from "@/lib/flow/partialOperation";
import type { ActiveTrade, ActiveTradeActionRequest, ActiveTradeActionResponse, ActiveTradePlan } from "./activeTradeTypes";

/** The service supplies an authenticated, account-scoped port. It never accepts client quantity or stop. */
export type PositionActionPort = {
  read(): Promise<{ trade: ActiveTrade | null; observedAt: number }>;
  close(qty: number | undefined, notAfterMs: number): Promise<{ ok: boolean; uncertain?: boolean }>;
  modify(stop: number, notAfterMs: number): Promise<{ ok: boolean; uncertain?: boolean }>;
  partialStore: PartialStore;
  releasePartial(): Promise<void>;
  partialSent?(intent: PartialIntent, confirmedRemaining?: number): Promise<void>;
  now(): number;
};
export type PositionActionOutcome = { status: number; body: ActiveTradeActionResponse };
const planFor = (trade: ActiveTrade, request: ActiveTradeActionRequest): ActiveTradePlan | undefined =>
  request.action === "partial" ? trade.actions.partial.find((p) => p.fraction === request.fraction) : trade.actions[request.action];

/** Read -> exact reviewed revision -> re-read at dispatch -> reconcile. No acknowledgement is called a fill. */
export async function executePositionAction(request: ActiveTradeActionRequest, port: PositionActionPort): Promise<PositionActionOutcome> {
  const result = (state: ActiveTradeActionResponse["state"], message: string, status = state === "refused" ? 409 : 200): PositionActionOutcome => ({
    status, body: { ok: state === "confirmed", state, message, accountId: request.accountId, environment: request.environment, positionId: request.positionId, action: request.action },
  });
  const pending = () => result("pending", "The broker has not confirmed this change yet. Refresh to check its status; it will not be sent again automatically.");
  const current = async () => {
    const reading = await port.read();
    if (port.now() - reading.observedAt > 5000 || reading.observedAt > port.now() + 1000) throw new Error("read_expired");
    return reading.trade;
  };
  let initial: ActiveTrade | null;
  try { initial = await current(); }
  catch { return result("refused", "The broker’s current position could not be verified. Refresh before trying again.", 503); }
  if (!initial || initial.id !== request.positionId) return result("refused", "The broker no longer lists this position as open.");
  if (initial.revision !== request.revision) return result("refused", "This position changed. Refresh and review its current details.");
  const plan = planFor(initial, request);
  if (!plan?.allowed) return result("refused", plan?.reason ?? "This action is unavailable.", 403);
  const checkAgain = async () => {
    const trade = await current();
    if (!trade || trade.id !== request.positionId || trade.revision !== request.revision) throw new Error("position_changed");
    const latest = planFor(trade, request);
    if (!latest?.allowed || request.action === "partial" && latest.qty !== plan.qty || request.action === "breakeven" && latest.stop !== plan.stop) throw new Error("position_changed");
    return trade;
  };

  if (request.action === "partial") {
    if (!(plan.qty != null && plan.qty > 0 && plan.qty < initial.qty)) return result("refused", "The broker’s partial quantity is unavailable.");
    const intent = { before_qty: initial.qty, requested_qty: plan.qty };
    let created = false, definitelyRefused = false, sent = false, existingDifferent = false;
    try {
      const settled = await partialOnce({ async reserve(wanted) {
        const reservation = await port.partialStore.reserve(wanted);
        created = reservation.created;
        existingDifferent = !created && (Math.abs(reservation.intent.before_qty - wanted.before_qty) > 1e-9 || Math.abs(reservation.intent.requested_qty - wanted.requested_qty) > 1e-9);
        return reservation;
      } }, intent, async () => {
        try { await checkAgain(); } catch { definitelyRefused = true; return { ok: false, error: "position_changed" }; }
        try {
          sent = true;
          const answer = await port.close(intent.requested_qty, port.now() + 3000);
          if (!answer.ok && answer.uncertain) throw new Error("outcome_unknown");
          if (!answer.ok) { definitelyRefused = true; return { ok: false, error: "broker_refused" }; }
          return { ok: true };
        } catch (error) {
          if (error instanceof Error && error.message === "send_deadline_passed") { definitelyRefused = true; return { ok: false, error: "send_deadline_passed" }; }
          throw error;
        }
      }, async () => (await current())?.qty ?? null);
      if (created && definitelyRefused) {
        try { await port.releasePartial(); } catch { /* kept reserved: never retry an unverified release */ }
        return result("refused", "No partial was sent or accepted. Refresh and review the latest position.");
      }
      if (created && sent && !definitelyRefused) {
        try { await port.partialSent?.(intent, settled.state === "confirmed" ? settled.remaining : undefined); } catch { /* broker state, not bookkeeping, determines the response */ }
      }
      if (existingDifferent) return result("pending", "A previous partial request is already recorded for this position. Refresh to check its broker result.");
      return settled.state === "confirmed" ? result("confirmed", "The broker confirmed the smaller position size.") : pending();
    } catch {
      return result(sent ? "pending" : "refused", sent ? "The partial outcome is unconfirmed. Its reservation is kept, so it will not be sent again." : "The partial reservation could not be verified. No partial was sent.", sent ? 200 : 503);
    }
  }

  try { await checkAgain(); }
  catch { return result("refused", "The position or its protection changed. Refresh and review it again."); }
  if (request.action === "breakeven" && !(plan.stop != null && plan.stop > 0)) return result("refused", "A verified break-even price is unavailable.");
  let accepted = false;
  try {
    const answer = request.action === "close" ? await port.close(undefined, port.now() + 3000) : await port.modify(plan.stop!, port.now() + 3000);
    if (!answer.ok && !answer.uncertain) return result("refused", "The broker did not accept this change. Refresh before reviewing it again.");
    accepted = answer.ok;
  } catch (error) {
    if (error instanceof Error && error.message === "send_deadline_passed") return result("refused", "The broker connection was busy, so this request was not sent. Refresh and review it again.");
    // A lost reply may follow an executed operation. The only next step is a read.
  }
  try {
    const after = await current();
    if (request.action === "close" && !after) return result("confirmed", "The broker confirmed this position is closed.");
    if (request.action === "breakeven" && after && after.stop != null && plan.stop != null
      && (after.side === "buy" ? after.stop >= plan.stop : after.stop <= plan.stop)) return result("confirmed", "The broker confirmed the stop at break-even or better.");
  } catch { /* acknowledgement remains unconfirmed */ }
  return accepted ? pending() : result("pending", "The request’s outcome is unknown. Refresh to check the broker before making another change.");
}
