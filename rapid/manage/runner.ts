import type { Bar, Pivot, Side } from "../core/types";
import { dirOf } from "../core/types";
import { admin, journal } from "../db";
import type { BrokerPort } from "./../exec/port";
import { nextAction, type ManagedTrade } from "../engine/manage";
import type { RapidConfig } from "../config/defaults";

/**
 * Per-position management.
 *
 * Management OFF still means the broker holds the original stop and target. What it disables is
 * everything DISCRETIONARY: breakeven, partials, trailing and the change-of-character exit. Risk
 * checks and reconciliation keep running either way, and native protection is never removed.
 *
 * Actions against one position are serialised, because a partial racing a stop amendment racing a
 * manual close is how a position ends up half-closed with no protection on the remainder.
 */

const inflight = new Set<string>();

export type PositionRow = {
  id: string;
  account_id: string;
  broker_position_id: string;
  side: Side;
  entry: number;
  original_qty: number;
  current_qty: number;
  initial_stop: number;
  current_stop: number | null;
  target: number | null;
  atr_at_fill: number | null;
  cost_price: number;
  protected_swing: number | null;
  breakeven_done: boolean;
  partial_done: boolean;
  management_enabled: boolean;
  management_version: string;
  best_price: number | null;
  worst_price: number | null;
};

export type ManageContext = {
  port: BrokerPort;
  bars: Bar[];
  pivots: Pivot[];
  asOf: number;
  tick: number;
  minStopDistance: number;
  bid: number;
  ask: number;
  cfg: RapidConfig;
  /** False when the worker has lost the account lease mid-pass. */
  stillOwned: () => boolean;
};

export async function managePosition(row: PositionRow, ctx: ManageContext): Promise<{ action: string; ok: boolean; detail: string }> {
  if (inflight.has(row.id)) return { action: "none", ok: true, detail: "another action on this position is still in flight" };
  inflight.add(row.id);
  try {
    const db = admin();

    // Excursion tracking. Written on every pass would be a no-op UPDATE storm, so it is only written
    // when the extreme actually moves — the cost of a pointless write is a slower pass, and a slow
    // pass is what loses the lease.
    const price = row.side === "buy" ? ctx.bid : ctx.ask;
    const best = row.best_price == null ? price : row.side === "buy" ? Math.max(row.best_price, price) : Math.min(row.best_price, price);
    const worst = row.worst_price == null ? price : row.side === "buy" ? Math.min(row.worst_price, price) : Math.max(row.worst_price, price);
    const excursionPatch: Record<string, unknown> = {};
    if (best !== row.best_price) excursionPatch.best_price = best;
    if (worst !== row.worst_price) excursionPatch.worst_price = worst;
    if (Object.keys(excursionPatch).length) await db.from("rapid_positions").update(excursionPatch).eq("id", row.id);

    if (!row.management_enabled) {
      return { action: "none", ok: true, detail: "management off: the broker's original stop and target stand" };
    }
    if (!ctx.stillOwned()) {
      return { action: "none", ok: false, detail: "lease lost mid-pass; this worker stopped commanding the account" };
    }

    const trade: ManagedTrade = {
      side: row.side,
      entry: row.entry,
      initialStop: row.initial_stop,
      currentStop: row.current_stop ?? row.initial_stop,
      target: row.target ?? row.entry + dirOf(row.side) * ctx.cfg.target.maxUsd,
      originalQty: row.original_qty,
      currentQty: row.current_qty,
      atrAtFill: row.atr_at_fill ?? 0,
      costPrice: row.cost_price,
      breakevenDone: row.breakeven_done,
      partialDone: row.partial_done,
      managementVersion: row.management_version,
      protectedSwing: row.protected_swing,
    };

    const decision = nextAction(trade, price, ctx.bars, ctx.pivots, ctx.asOf, ctx.tick, ctx.minStopDistance, ctx.bid, ctx.ask, ctx.cfg);
    if (decision.kind === "none") return { action: "none", ok: true, detail: decision.reason };

    const logAction = async (action: string, requested: unknown, acknowledged: boolean, error?: string) => {
      await db.from("rapid_position_actions").insert({
        position_id: row.id, action, requested, acknowledged, ack_at: acknowledged ? new Date().toISOString() : null,
        reason: decision.reason, error: error ?? null,
      });
    };

    if (decision.kind === "breakeven" || decision.kind === "trail") {
      // Only the stop leg is sent. Omitting takeProfit leaves it alone; sending null would REMOVE it.
      const r = await ctx.port.amend(row.broker_position_id, { stopLoss: decision.stop });
      await logAction(decision.kind, { stopLoss: decision.stop }, r.ok, r.ok ? undefined : r.error);
      if (!r.ok) {
        // The existing tighter protection is retained. Nothing is removed first, ever.
        await journal({ accountId: row.account_id, stage: "manage", code: `${decision.kind}_rejected`, decision: "keep_existing_protection", reason: r.error });
        return { action: decision.kind, ok: false, detail: r.error };
      }
      // A request is not an outcome: the amendment is only recorded once the broker confirms it.
      const patch: Record<string, unknown> = { current_stop: decision.stop, updated_at: new Date().toISOString() };
      if (decision.kind === "breakeven") { patch.breakeven_done = true; patch.breakeven_at = new Date().toISOString(); }
      await db.from("rapid_positions").update(patch).eq("id", row.id);
      return { action: decision.kind, ok: true, detail: `stop moved to ${decision.stop}` };
    }

    if (decision.kind === "partial") {
      // Reserve BEFORE dispatching, so an unknown outcome cannot become a second partial.
      const envKey = { environment: "live", account_id: row.account_id, position_id: row.broker_position_id };
      const { error: reserveErr } = await db.from("rapid_partial_operations").insert({
        ...envKey, before_qty: row.current_qty, requested_qty: decision.qty, state: "pending",
      });
      if (reserveErr) return { action: "partial", ok: false, detail: "a partial on this position is already reserved" };

      const r = await ctx.port.close(row.broker_position_id, decision.qty);
      await logAction("partial", { qty: decision.qty }, r.ok, r.ok ? undefined : r.error);
      if (!r.ok) {
        await db.from("rapid_partial_operations").update({ state: "pending" }).match(envKey);
        return { action: "partial", ok: false, detail: r.error };
      }
      // Confirm the resulting quantity before releasing the guard. A close creates execution work
      // and may finish later; marking it done on the request would allow a second partial.
      const after = await ctx.port.positions();
      const nowQty = after.ok ? after.rows.find((p) => p.positionId === row.broker_position_id)?.qty ?? null : null;
      if (nowQty == null || Math.abs(nowQty - (row.current_qty - decision.qty)) > 1e-6) {
        return { action: "partial", ok: false, detail: "the partial is pending until the resulting quantity is confirmed" };
      }
      await db.from("rapid_partial_operations").update({ state: "confirmed", settled_at: new Date().toISOString() }).match(envKey);
      await db.from("rapid_positions").update({ partial_done: true, partial_at: new Date().toISOString(), current_qty: nowQty, updated_at: new Date().toISOString() }).eq("id", row.id);
      return { action: "partial", ok: true, detail: `closed ${decision.qty}, ${nowQty} remaining` };
    }

    // Change of character: exit at the next available quote, never retroactively at the close.
    const r = await ctx.port.close(row.broker_position_id);
    await logAction("exit", { full: true }, r.ok, r.ok ? undefined : r.error);
    if (!r.ok) return { action: "exit", ok: false, detail: r.error };
    await db.from("rapid_positions").update({
      status: "closing", close_reason: decision.reason, updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    return { action: "exit", ok: true, detail: decision.reason };
  } finally {
    inflight.delete(row.id);
  }
}
