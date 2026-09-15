/**
 * GENX 2.0 — cancel a resting GTC entry that will not fill (bounded validity), with explicit
 * fill-vs-cancel race handling. Flag-gated by GENX2_CANCEL_ON_INVALIDATION (default on).
 *
 * A GENX gold entry is a marketable limit at the 0.75 cap: it fills immediately when price is
 * at/through the cap, otherwise it RESTS. A resting order that has not filled within the bounded
 * validity means price has moved away from the cap — entering there would chase, so the order is
 * withdrawn instead ("missing an entry is acceptable; a bad fill is not").
 *
 * The account is freed ONLY on a broker-CONFIRMED cancel. A filled order cannot be canceled, so:
 *   - cancel ok            → the working order is gone, unfilled → release the account.
 *   - cancel fails + a position exists → it filled (the cancel lost the race) → hold as 'filled'.
 *   - cancel fails + no visible position → never release blind → hold; the open-position backstop
 *     and the SQL stale-reconcile resolve it on a later pass.
 * So the race can never free an account that actually holds a position.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { cancelOrder } from "@/lib/flow/tradelocker";
import { markReservation, releaseGold } from "@/lib/genx2/reservation";
import { genx2CancelOnInvalidation, genx2OrderValiditySec } from "@/lib/genx2/flags";

/** Pure post-cancel decision (unit-tested). */
export function afterCancel(o: { canceled: boolean; hasOpenPosition: boolean }): "release" | "filled" | "hold" {
  if (o.canceled) return "release";        // broker confirmed a working order gone → unfilled
  if (o.hasOpenPosition) return "filled";  // cancel failed because it filled → hold as a position
  return "hold";                            // cancel failed, no visible position → never release blind
}

export async function reconcileStaleGoldEntries(): Promise<{ scanned: number; released: number; filled: number; held: number }> {
  const out = { scanned: 0, released: 0, filled: 0, held: 0 };
  if (!genx2CancelOnInvalidation()) return out;
  const admin = createAdminClient();
  if (!admin) return out;
  const cutoff = new Date(Date.now() - genx2OrderValiditySec() * 1000).toISOString();
  try {
    // Resting entries only: state 'active' (order accepted, not yet marked filled), carrying an
    // order_id, gold, older than the bounded validity. A filled reservation is state 'filled' and
    // is not touched here.
    const { data: resv } = await admin.from("flow_account_reservations")
      .select("account_id, order_id, reserved_at")
      .eq("state", "active").eq("symbol", "XAUUSD").not("order_id", "is", null)
      .lt("reserved_at", cutoff).limit(200);
    const rows = (resv ?? []) as { account_id: string; order_id: string | null; reserved_at: string }[];
    for (const r of rows) {
      if (!r.order_id) continue;
      out.scanned++;
      const { data: acct } = await admin.from("flow_broker_accounts")
        .select("connection_id, acc_num").eq("account_id", r.account_id).limit(1).maybeSingle();
      const connId = (acct as { connection_id?: string } | null)?.connection_id;
      const accNum = (acct as { acc_num?: string | number } | null)?.acc_num;
      if (!connId || accNum == null) { out.held++; continue; }        // can't resolve → hold
      const tok = await connectionToken(connId);
      if (!tok.ok) { out.held++; continue; }                          // no token → hold (fail-safe)

      const c = await cancelOrder(tok.env, tok.token, String(accNum), r.order_id);
      let hasPos = false;
      if (!c.ok) {
        const { data: pos } = await admin.from("flow_managed_positions")
          .select("id").eq("account_id", r.account_id).eq("symbol", "XAUUSD").eq("status", "open").limit(1).maybeSingle();
        hasPos = !!pos;
      }
      const decision = afterCancel({ canceled: c.ok, hasOpenPosition: hasPos });
      if (decision === "release") { await releaseGold(admin, r.account_id, "XAUUSD"); out.released++; }
      else if (decision === "filled") { await markReservation(admin, r.account_id, "XAUUSD", "filled"); out.filled++; }
      else out.held++;
    }
  } catch { /* best-effort; the SQL stale-reconcile + open-position backstop remain the safety net */ }
  return out;
}
