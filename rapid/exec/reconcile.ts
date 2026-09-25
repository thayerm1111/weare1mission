import { admin, journal } from "../db";
import type { BrokerPort } from "./port";
import { isRapidTag } from "./ownership";

/**
 * Reconciliation.
 *
 * Run before a worker resumes automation, and whenever an outcome is unknown. The question it
 * answers is narrow and important: what does the BROKER think is true, and does our record agree?
 *
 * Rapid only ever acts on a position that the broker tags as ours AND that has a matching
 * `rapid_positions` row. One without the other is surfaced for review rather than adopted, because
 * adopting an untracked position means managing something whose plan we do not have.
 */

export type ReconcileReport = {
  accountId: string;
  brokerPositions: number;
  ours: number;
  foreign: number;
  resolvedUnknown: number;
  closedExternally: number;
  orphansForReview: number;
  protectionMissing: number;
  blockers: string[];
};

export async function reconcileAccount(accountId: string, port: BrokerPort): Promise<ReconcileReport> {
  const db = admin();
  const report: ReconcileReport = {
    accountId, brokerPositions: 0, ours: 0, foreign: 0, resolvedUnknown: 0,
    closedExternally: 0, orphansForReview: 0, protectionMissing: 0, blockers: [],
  };

  const live = await port.positions();
  if (!live.ok) {
    report.blockers.push(`broker positions unreadable: ${live.error}`);
    await journal({ accountId, stage: "reconcile", code: "positions_unreadable", decision: "pause_entries", reason: live.error });
    return report;
  }
  report.brokerPositions = live.rows.length;
  const byId = new Map(live.rows.map((r) => [r.positionId, r]));
  report.foreign = live.rows.filter((r) => !isRapidTag(r.strategyId)).length;

  // 1. Intents whose outcome we never learned. The broker's record is the answer.
  const { data: unknowns } = await db
    .from("rapid_intents")
    .select("id, broker_order_id, broker_position_id, intent_key")
    .eq("account_id", accountId)
    .eq("state", "submission_unknown");

  for (const u of (unknowns ?? []) as Array<{ id: string; broker_order_id: string | null; broker_position_id: string | null; intent_key: string }>) {
    let positionId = u.broker_position_id;
    if (!positionId && u.broker_order_id) {
      const resolved = await port.resolvePosition(u.broker_order_id);
      positionId = resolved?.positionId ?? null;
    }
    const row = positionId ? byId.get(positionId) : undefined;
    if (row) {
      // It IS live. Adopt it and make sure it is protected before anything else happens.
      await db.from("rapid_intents").update({
        state: row.stopLoss != null ? "protected" : "protection_pending",
        broker_position_id: row.positionId,
        fill_price: row.entry,
        filled_qty: row.qty,
        updated_at: new Date().toISOString(),
      }).eq("id", u.id);
      if (row.stopLoss == null) report.protectionMissing++;
      await journal({ accountId, intentId: u.id, stage: "reconcile", code: "unknown_resolved_open",
        decision: "adopt", reason: `the order did fill; position ${row.positionId} is live`, evidence: { positionId: row.positionId, protected: row.stopLoss != null } });
    } else {
      await db.from("rapid_intents").update({ state: "closed", error: "reconciled: no matching broker position", updated_at: new Date().toISOString() }).eq("id", u.id);
      await journal({ accountId, intentId: u.id, stage: "reconcile", code: "unknown_resolved_absent", decision: "close_intent", reason: "no matching position at the broker" });
    }
    await db.from("rapid_risk_reservations").update({ state: "converted", settled_at: new Date().toISOString() }).eq("intent_key", u.intent_key);
    report.resolvedUnknown++;
  }

  // 2. Positions we think are open. Are they?
  const { data: open } = await db
    .from("rapid_positions")
    .select("id, broker_position_id, current_qty, current_stop, target")
    .eq("account_id", accountId)
    .in("status", ["open", "closing"]);

  for (const p of (open ?? []) as Array<{ id: string; broker_position_id: string; current_qty: number; current_stop: number | null; target: number | null }>) {
    const row = byId.get(p.broker_position_id);
    if (!row) {
      // Gone at the broker: a stop, a target, or a manual close. Closed, not reopened.
      await db.from("rapid_positions").update({
        status: "closed", closed_at: new Date().toISOString(), close_reason: "closed at the broker (stop, target or manual)", updated_at: new Date().toISOString(),
      }).eq("id", p.id);
      report.closedExternally++;
      await journal({ accountId, stage: "reconcile", code: "closed_externally", decision: "mark_closed", reason: `position ${p.broker_position_id} is no longer at the broker` });
      continue;
    }
    report.ours++;
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    // An externally edited stop is adopted as the truth, not overwritten back to ours.
    if (row.stopLoss != null && p.current_stop != null && Math.abs(row.stopLoss - p.current_stop) > 1e-9) {
      patch.current_stop = row.stopLoss;
      await journal({ accountId, stage: "reconcile", code: "stop_changed_externally", decision: "adopt_broker_value",
        reason: `the broker holds ${row.stopLoss}, our record said ${p.current_stop}`, evidence: { positionId: p.broker_position_id } });
    }
    if (row.qty != null && Math.abs(row.qty - p.current_qty) > 1e-9) patch.current_qty = row.qty;
    if (row.stopLoss == null) {
      patch.protection_state = "unconfirmed";
      report.protectionMissing++;
    }
    if (Object.keys(patch).length > 1) await db.from("rapid_positions").update(patch).eq("id", p.id);
  }

  // 3. Positions the broker says are ours, that we have no plan for.
  const { data: known } = await db.from("rapid_positions").select("broker_position_id").eq("account_id", accountId);
  const knownIds = new Set((known ?? []).map((k) => (k as { broker_position_id: string }).broker_position_id));
  for (const row of live.rows) {
    if (!isRapidTag(row.strategyId)) continue;
    if (knownIds.has(row.positionId)) continue;
    report.orphansForReview++;
    report.blockers.push(`position ${row.positionId} carries a Rapid tag but has no local record`);
    await journal({ accountId, stage: "reconcile", code: "orphan_position", decision: "pause_entries",
      reason: "a Rapid-tagged position has no local plan; it is not managed and new entries are paused", evidence: { positionId: row.positionId } });
  }

  if (report.protectionMissing > 0) report.blockers.push(`${report.protectionMissing} position(s) have no confirmed broker stop`);
  return report;
}
