import { createAdminClient } from "@/lib/supabase/admin";

/**
 * PER-TRADE FLIGHT RECORDER + EXECUTION TELEMETRY (diagnostic only).
 *
 * Appends timestamped, reason-coded lifecycle events for every FLOW trade to
 * `flow_trade_log`, so any trade can be inspected end to end (entry → fill/slippage →
 * break-even → partial → trail → close → reconcile) without guessing. Purely observational:
 * writing a log row NEVER changes trading behavior and is always best-effort (a failed insert
 * is swallowed). If the table doesn't exist yet the inserts simply no-op.
 */

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type TradePhase =
  | "entry_submitted"      // order sent to the broker
  | "entry_confirmed"      // broker filled + position id resolved (carries latencyMs)
  | "entry_uncertain"      // order request threw (timeout) — recovery will reconcile
  | "adopted"              // orphan position adopted into management
  | "fill_reconciled"      // re-anchored to the real broker fill (carries slippage)
  | "break_even"           // stop moved to entry, broker-confirmed
  | "be_unconfirmed"       // BE modify acked but broker read-back didn't confirm
  | "partial"              // partial profit banked, broker-confirmed
  | "partial_reconciled"   // a partial detected from broker qty (idempotency)
  | "trail"                // trailing stop advanced, broker-confirmed
  | "trail_unconfirmed"    // trail modify acked but broker read-back didn't confirm
  | "closed";              // position closed + outcome booked from broker history

export type TradeLogEntry = {
  position_id?: string | null;
  account_id: string;
  user_id?: string | null;
  symbol: string;
  phase: TradePhase;
  reason?: string | null;
  price?: number | null;
  qty?: number | null;
  detail?: Record<string, unknown> | null;
};

/** Append one flight-recorder event. Best-effort; never throws into the caller. */
export async function logTrade(admin: Admin, e: TradeLogEntry): Promise<void> {
  try {
    await admin.from("flow_trade_log").insert({
      at: new Date().toISOString(),
      position_id: e.position_id ?? null,
      account_id: e.account_id,
      user_id: e.user_id ?? null,
      symbol: e.symbol,
      phase: e.phase,
      reason: e.reason ?? null,
      price: e.price ?? null,
      qty: e.qty ?? null,
      detail: e.detail ?? null,
    });
  } catch { /* diagnostics are best-effort; the table may not exist yet */ }
}
