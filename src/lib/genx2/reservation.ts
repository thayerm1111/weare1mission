/**
 * GENX 2.0 — Rule #1 account reservation wrapper.
 *
 * Thin, fail-OPEN wrapper over the reservation RPCs. Philosophy matches the rest of the
 * desk ("never block trading on a read error"): if the flag is off or the DB errors, the
 * reserve call returns reserved=true so the entry proceeds on the pre-existing v1 guards
 * (per-signal 90s claim, open-position/maxOpen). The reservation can therefore only ADD
 * protection against a *second concurrent* entry — it can never freeze the desk.
 *
 * The exposure count enforced by genx_reserve_gold covers: (a) a live reservation
 * (in-flight order) and (b) an OPEN managed position. WORKING (unfilled) broker orders
 * are counted by the caller (executor) via a broker listOrders check before submit, so
 * together they satisfy "count both working entry orders and open positions as exposure."
 */
import { genx2ReservationEnabled } from "@/lib/genx2/flags";
import { hedgeEnabled } from "@/lib/genx/hedge";

// Structural, minimal shape of the Supabase admin client we use here. `rpc` is typed as a
// PromiseLike (the client returns a thenable PostgrestFilterBuilder, not a native Promise),
// so the real createAdminClient() value is assignable without a cast.
type RpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
} | null;

export type ReserveResult = { reserved: boolean; reason: string; state: string | null };

/**
 * Attempt to reserve the account for a gold entry. reserved=false → DO NOT submit.
 *
 * 09-22: with a `side` and hedging on, the reservation is taken through genx_reserve_gold_side, which
 * keys the lock as SYMBOL:SIDE and counts only SAME-SIDE open positions as exposure. A BUY may then be
 * reserved while a SELL is open; a second BUY still cannot. Without a side (or with GENX_HEDGE=off) it
 * is the original one-gold-per-account function, unchanged. Callers must pass the matching
 * goldResvKey() to markReservation/releaseGold, or they will mark the wrong row.
 */
export async function reserveGold(
  admin: RpcClient,
  accountId: string,
  symbol: string,
  signalKey: string,
  ttlSecs = 60,
  side?: string | null,
): Promise<ReserveResult> {
  if (!genx2ReservationEnabled()) return { reserved: true, reason: "disabled", state: null };
  if (!admin) return { reserved: true, reason: "no_admin_fail_open", state: null };
  const sided = hedgeEnabled() && (String(side ?? "").toLowerCase() === "buy" || String(side ?? "").toLowerCase() === "sell");
  try {
    const { data, error } = sided
      ? await admin.rpc("genx_reserve_gold_side", {
          p_account_id: accountId, p_symbol: symbol, p_side: String(side).toUpperCase(), p_signal_key: signalKey, p_ttl_secs: ttlSecs,
        })
      : await admin.rpc("genx_reserve_gold", {
          p_account_id: accountId, p_symbol: symbol, p_signal_key: signalKey, p_ttl_secs: ttlSecs,
        });
    if (error) return { reserved: true, reason: "rpc_error_fail_open", state: null };
    const d = (data ?? {}) as { reserved?: boolean; reason?: string; state?: string | null };
    return { reserved: d.reserved === true, reason: String(d.reason ?? "unknown"), state: d.state ?? null };
  } catch {
    return { reserved: true, reason: "throw_fail_open", state: null };
  }
}

/** Transition a held reservation after the broker responds. Best-effort. */
export async function markReservation(
  admin: RpcClient,
  accountId: string,
  symbol: string,
  state: "active" | "filled" | "unknown" | "released",
  orderId?: string | null,
  positionId?: string | null,
): Promise<boolean> {
  if (!genx2ReservationEnabled() || !admin) return false;
  try {
    const { data, error } = await admin.rpc("genx_reservation_mark", {
      p_account_id: accountId, p_symbol: symbol, p_state: state,
      p_order_id: orderId ?? null, p_position_id: positionId ?? null,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

/** Release the account. Caller must have reconciled (order dead OR position closed).
 *  NEVER call on a partial close. Best-effort. */
export async function releaseGold(admin: RpcClient, accountId: string, symbol: string): Promise<boolean> {
  if (!genx2ReservationEnabled() || !admin) return false;
  try {
    const { error } = await admin.rpc("genx_release_gold", { p_account_id: accountId, p_symbol: symbol });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Classify a broker order-submit outcome into the reservation state to record.
 * Pure — unit-testable without a broker. Distinguishes accepted/pending/filled/canceled/
 * rejected/unknown so an accepted order is NEVER treated as a confirmed fill.
 */
export type SubmitOutcome = "filled" | "accepted" | "canceled" | "rejected" | "unknown";
export function reservationStateForOutcome(o: SubmitOutcome): "active" | "filled" | "unknown" | "release" {
  switch (o) {
    case "filled": return "filled";          // hold until the position closes
    case "accepted": return "active";         // resting/pending — keep the reservation
    case "unknown": return "unknown";         // timeout/threw — hold until reconciled, never release blind
    case "canceled":
    case "rejected": return "release";        // terminal, no fill → free the account
  }
}
