/**
 * TWO ENGINES, ONE ACCOUNT, SEPARATE HANDS.
 *
 * GENX/FLOW and COMMAND CENTER are allowed to trade the same broker account. They are NOT allowed to
 * touch each other's trades. That is the whole of the rule, and it is a deliberate choice by the
 * owner rather than an accident of the schema: two different strategies may both have an opinion
 * about gold on the same account, and each is responsible for its own position from entry to exit.
 *
 * An earlier version of this file gave the account to FLOW outright and made ATLAS stand down.
 * That was the wrong reading of "no overlap". The overlap that matters is strategy and execution —
 * one engine second-guessing, re-managing or closing a trade the other opened — not the account.
 *
 * WHAT IS ENFORCED HERE:
 *
 *   One BRAIN position per account. ATLAS will not stack its own trades. FLOW's positions are
 *   counted separately and do not stop it, because FLOW's trade is FLOW's business.
 *
 *   ATLAS manages only what ATLAS opened. This is already structural — the two engines keep
 *   their positions in different tables and address them by different ids, so neither can reach the
 *   other's by accident — and `brainOwnsPosition` makes it checkable rather than merely true.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *
 *   It does not net the two engines' exposure. An account traded by both can hold a FLOW gold
 *   position and a BRAIN gold position at the same time, each sized to the member's risk percentage
 *   by its own engine — so the account's total risk can be the sum of the two. That is the
 *   consequence of running two strategies on one account, it is intended, and it is written down
 *   here so nobody later mistakes it for an oversight.
 *
 * EVERY CHECK FAILS CLOSED. If a table cannot be read, the answer is "not available". A missed
 * duplicate costs real money; a skipped entry costs one setup, and gold produces another shortly.
 */

import { blockingPositions } from "../core/hedge";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let admin: SupabaseClient | null = null;
function db(): SupabaseClient | null {
  if (admin) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  admin = createClient(url, key, { auth: { persistSession: false } });
  return admin;
}

export type Availability =
  | { available: true }
  | { available: false; reason: string };

/**
 * May ATLAS open a gold position on this broker account right now?
 *
 * Only ATLAS's own open positions can say no. FLOW may be in gold on the same account and that
 * is fine — it is running its own strategy and managing its own trade.
 */
export async function accountAvailableToBrain(
  accountRowId: string | null | undefined,
  accNumForMessage?: string | null,
  /**
   * 09-22: the side this entry would take. With it (and hedging on) only a SAME-SIDE open trade
   * refuses the entry, so ATLAS can hold one buy and one sell. Without it, any open trade refuses —
   * the original rule, which is what a caller that does not know its side should get.
   */
  side?: string | null,
): Promise<Availability> {
  /*
   * KEYED ON THE ACCOUNT ROW, NOT THE BROKER'S NUMBER.
   *
   * The first version of this queried cc_positions.acc_num, which does not exist — the table keys
   * positions by account_row_id. Every call threw, every throw was caught into "not available", and
   * the autopilot would have blocked every entry forever while looking like it was working. Found by
   * running the query against the real schema before switching anything on.
   */
  const id = String(accountRowId ?? "").trim();
  if (!id) {
    return { available: false, reason: "No account to check — refusing rather than guessing." };
  }
  const c = db();
  if (!c) {
    return { available: false, reason: "Cannot reach the position records to check for an open trade." };
  }

  const label = accNumForMessage ? `account ${accNumForMessage}` : "this account";
  try {
    const { data, error } = await c
      .from("cc_positions")
      .select("id, side")
      .eq("account_row_id", id)
      .is("closed_at", null)
      .limit(8);
    if (error) throw new Error(error.message);
    const open = (data ?? []) as { id: string; side: string | null }[];
    const blocking = blockingPositions(open, side);
    if (blocking.length) {
      const dir = String(side ?? "").toLowerCase() === "buy" ? "BUY" : String(side ?? "").toLowerCase() === "sell" ? "SELL" : null;
      return { available: false, reason: dir ? `ATLAS already has a ${dir} open on ${label}.` : `ATLAS already has a position open on ${label}.` };
    }
  } catch (e) {
    return { available: false, reason: `Could not read ATLAS's positions (${String(e).slice(0, 80)}).` };
  }

  return { available: true };
}

/**
 * Is this position one ATLAS opened, and therefore one it may act on?
 *
 * The autonomous manager asks before every action. It should always be true — the manager only ever
 * reads `cc_positions` — and the day it is not, something has gone wrong in a way that must stop
 * rather than proceed.
 */
export async function brainOwnsPosition(userId: string, positionRowId: string): Promise<boolean> {
  const c = db();
  if (!c) return false;
  try {
    const { data, error } = await c
      .from("cc_positions")
      .select("id")
      .eq("id", positionRowId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  } catch {
    return false;
  }
}
