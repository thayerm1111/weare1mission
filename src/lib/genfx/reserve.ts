import { createAdminClient } from "@/lib/supabase/admin";
import { type PairKey } from "@/lib/genfx/pairs";

/**
 * GEN FX — THE ACCOUNT LOCK. One row per account, pair and side in flow_account_reservations
 * ("EURUSD:BUY"), taken through the same Postgres function gold uses (genx_reserve_gold_side): the
 * row is locked, an open ledger position on that pair and side refuses it, and a lock somebody
 * already holds refuses it.
 *
 * Gold reaches that function through a wrapper (genx2/reservation.ts) that FAILS OPEN — flag off,
 * database error, exception: "reserved, go ahead" — because gold has older guards underneath it.
 * GEN FX calls it directly and FAILS CLOSED: "I could not take the lock" is a no. It does not read
 * gold's GENX2_RESERVATION or GENX_HEDGE switches either, so nothing changed for gold can quietly
 * remove this guard from GEN FX. The key is always pair-and-side.
 *
 * The lock is a short thing: it covers the seconds an order is in flight, and it is reclaimed sixty
 * seconds after it was last touched. What remembers an order for as long as it takes to settle is the
 * call's own row in genfx_fills (fills.ts); placement asks both.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export const fxResvKey = (pair: PairKey | string, side: string): string => `${String(pair).toUpperCase()}:${String(side).toUpperCase()}`;

/** Take the account's lock for this pair and side. `ok: false` → do not send an order. */
export async function reserveFx(admin: Admin, accountId: string, pair: PairKey, side: "buy" | "sell", signalKey: string, ttlSecs = 60): Promise<{ ok: boolean; reason: string }> {
  try {
    const { data, error } = await admin.rpc("genx_reserve_gold_side", { p_account_id: accountId, p_symbol: pair, p_side: side.toUpperCase(), p_signal_key: signalKey, p_ttl_secs: ttlSecs });
    if (error) return { ok: false, reason: "reservation_unavailable" };
    const d = (data ?? {}) as { reserved?: boolean; reason?: string };
    return { ok: d.reserved === true, reason: String(d.reason ?? "unknown") };
  } catch { return { ok: false, reason: "reservation_unavailable" }; }
}

/** Record what became of the order the lock was taken for. Best-effort. */
export async function markFx(admin: Admin, accountId: string, key: string, state: "active" | "filled" | "unknown", orderId?: string | null, positionId?: string | null): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("genx_reservation_mark", { p_account_id: accountId, p_symbol: key, p_state: state, p_order_id: orderId ?? null, p_position_id: positionId ?? null });
    return !error && data === true;
  } catch { return false; }
}

/**
 * Free the account — but only if the lock is still THIS call's. The database's own release deletes
 * whatever row is there; by the time a call is handing its lock back, or an old call is being written
 * off, another call may hold it, and that one must not lose it. Best-effort.
 */
export async function releaseFxIfHeldBy(admin: Admin, accountId: string, key: string, signalKey: string): Promise<boolean> {
  try {
    const { error } = await admin.from("flow_account_reservations").delete().eq("account_id", accountId).eq("symbol", key).eq("signal_key", signalKey);
    return !error;
  } catch { return false; }
}
