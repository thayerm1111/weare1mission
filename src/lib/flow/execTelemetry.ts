/**
 * Real execution telemetry for GENX 3.x orders (owner 09-16: measure the real cost of GENX).
 * The GENX 3 runtime wraps delivery in `withExecContext`; the executor calls `recordExec` at the
 * order hot path. Best-effort and non-blocking: it can never change or delay an order decision.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createAdminClient } from "@/lib/supabase/admin";

export type ExecContext = { signalId: string; strategyVersion: string; setup: string; marketState: string | null; signalAt: string; signalPrice: number; requestedEntry: number; stop: number; target: number };
const store = new AsyncLocalStorage<ExecContext>();
export const withExecContext = <T>(ctx: ExecContext, fn: () => Promise<T>): Promise<T> => store.run(ctx, fn);
export const execContext = (): ExecContext | undefined => store.getStore();

export type ExecSample = {
  accountId: string; bid: number | null; ask: number | null; quoteAt: number; limitPrice: number | null; qty: number | null;
  riskPct: number | null; equity: number | null; stop: number | null; target: number | null;
  submitAt: number; ackAt: number; ok: boolean; orderId: string | null; positionId: string | null; error: string | null;
};
export function recordExec(x: ExecSample): void {
  const ctx = store.getStore(); if (!ctx) return;
  const admin = createAdminClient(); if (!admin) return;
  const spread = x.bid != null && x.ask != null ? +(x.ask - x.bid).toFixed(3) : null;
  void Promise.resolve(admin.from("genx3_executions").insert({
    signal_id: ctx.signalId, account_id: x.accountId, strategy_version: ctx.strategyVersion, setup: ctx.setup, market_state: ctx.marketState,
    signal_at: ctx.signalAt, signal_price: ctx.signalPrice, requested_entry: ctx.requestedEntry, signal_stop: ctx.stop, signal_target: ctx.target,
    bid: x.bid, ask: x.ask, spread, quote_at: new Date(x.quoteAt).toISOString(), limit_price: x.limitPrice, qty: x.qty, risk_pct: x.riskPct, equity: x.equity,
    order_stop: x.stop, order_target: x.target, submit_at: new Date(x.submitAt).toISOString(), ack_at: new Date(x.ackAt).toISOString(),
    ok: x.ok, order_id: x.orderId, position_id: x.positionId, error: x.error,
  })).catch(() => { /* telemetry is best-effort */ });
}
