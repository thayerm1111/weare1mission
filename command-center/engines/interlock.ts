/**
 * WHICH ENGINE OWNS AN ACCOUNT. GENX/FLOW IS NEVER THE ONE THAT YIELDS.
 *
 * There are two autonomous systems in this product that could put gold on the same TradeLocker
 * account. GENX/FLOW has been trading real money for months and is not being changed: it keeps its
 * accounts, its behaviour and its guards exactly as they are. COMMAND CENTER is the new one, and the
 * whole burden of staying out of the way falls on it.
 *
 * The rule is ownership, not negotiation:
 *
 *   An account that FLOW trades belongs to FLOW. THE BRAIN will not trade it. Full stop.
 *
 * Ownership is decided per BROKER ACCOUNT NUMBER, not per row id. The same TradeLocker account can be
 * connected twice — once to FLOW, once to Command Center — and our two row ids say nothing about that.
 * To the broker it is one account with one margin pool, and that pool is what would be double-risked.
 *
 * A second, narrower check backs it up: even on an account FLOW does not own, refuse if gold is
 * already open there. That catches a position opened by hand, or by FLOW before ownership changed.
 *
 * BOTH FAIL CLOSED. If the tables cannot be read, this reports that the account is not available. A
 * missed duplicate costs real money on somebody's account; a skipped entry costs one setup, and gold
 * produces another one shortly.
 *
 * Nothing in this file writes anything, and nothing in GENX or FLOW imports it. It is a one-way
 * courtesy from the new engine to the established one.
 */

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
  | { available: false; reason: string; owner: "flow" | "command-center" | "manual" | "unknown" };

/** Is this broker account free for THE BRAIN to trade autonomously? */
export async function accountAvailableToBrain(accNum: string | null | undefined): Promise<Availability> {
  const n = String(accNum ?? "").trim();
  if (!n) {
    return { available: false, reason: "No broker account number to check — refusing rather than guessing.", owner: "unknown" };
  }
  const c = db();
  if (!c) {
    return { available: false, reason: "Cannot reach the account records to check ownership.", owner: "unknown" };
  }

  // 1 — Does FLOW trade this account? Either switch makes it FLOW's: `autotrade_enabled` is the copy
  //     path, `genx_follower` is the follower path, and both place gold without asking.
  try {
    const { data, error } = await c
      .from("flow_broker_accounts")
      .select("autotrade_enabled, genx_follower")
      .eq("acc_num", n)
      .limit(20);
    if (error) throw new Error(error.message);
    const ownedByFlow = (data ?? []).some((r: { autotrade_enabled?: boolean | null; genx_follower?: boolean | null }) =>
      r.autotrade_enabled === true || r.genx_follower === true);
    if (ownedByFlow) {
      return {
        available: false,
        owner: "flow",
        reason: `Account ${n} is traded by GENX/FLOW. THE BRAIN leaves FLOW's accounts alone.`,
      };
    }
  } catch (e) {
    return { available: false, reason: `Could not check FLOW's accounts (${String(e).slice(0, 80)}).`, owner: "unknown" };
  }

  // 2 — Backstop: is gold open on it right now, whoever opened it?
  try {
    const { data, error } = await c
      .from("flow_managed_positions")
      .select("position_id, symbol")
      .eq("acc_num", n)
      .eq("status", "open")
      .limit(8);
    if (error) throw new Error(error.message);
    const gold = (data ?? []).filter((r: { symbol?: string | null }) =>
      String(r.symbol ?? "").toUpperCase().replace("/", "").includes("XAU"));
    if (gold.length) {
      return { available: false, reason: `Gold is already open on account ${n}.`, owner: "manual" };
    }
  } catch (e) {
    return { available: false, reason: `Could not read open positions (${String(e).slice(0, 80)}).`, owner: "unknown" };
  }

  // 3 — And THE BRAIN's own side: one gold position per account, same as FLOW's rule for itself.
  try {
    const { data, error } = await c
      .from("cc_positions")
      .select("id")
      .eq("acc_num", n)
      .is("closed_at", null)
      .limit(8);
    if (error) throw new Error(error.message);
    if ((data ?? []).length) {
      return { available: false, reason: `THE BRAIN already holds a position on account ${n}.`, owner: "command-center" };
    }
  } catch (e) {
    return { available: false, reason: `Could not read THE BRAIN's positions (${String(e).slice(0, 80)}).`, owner: "unknown" };
  }

  return { available: true };
}
