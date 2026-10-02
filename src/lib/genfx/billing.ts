import { createAdminClient } from "@/lib/supabase/admin";
import { DAILY_FREE } from "@/lib/creditConfig";
import { flowPassUserIds } from "@/lib/subscription";
import { billEvent, canAfford, TRADE_COST } from "@/lib/flow/flowBilling";

/**
 * GEN FX CREDITS — OFF UNTIL THE OWNER SAYS OTHERWISE.
 *
 * Nothing in this file runs unless genfx_control.billing_enabled is true. With it on, GEN FX is
 * priced exactly like GENX, through the same meter (flow_bill_event) and at the same prices:
 * 1 credit when a setup a member is armed for starts forming, 5 when an order is actually placed on
 * one of their accounts. A FLOW Pass covers it, as it covers GENX. The fee for a trade is taken only
 * after the order is on the account, once per member per call however many accounts they run.
 *
 * It does not reuse flowBilling.fireEligibleAccountIds, deliberately. That gate drops any member whose
 * master FLOW switch is off — right for gold, where FLOW off means "do not trade me". GEN FX has its
 * own switch per account and pair; a member who runs GEN FX and not FLOW has asked for these trades.
 *
 * Being the same meter has one consequence worth knowing before the switch is flipped: a member who
 * cannot pay a GEN FX fee is credit-paused, and that pause also stops their gold FLOW until they top
 * up — the same thing a gold fee they could not pay would do.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type FxFireGate = { eligible: Set<string>; billable: Set<string> };

/** Which of these MEMBERS may take a GEN FX trade right now, and who pays for it? Charges nobody. */
export async function fxFireGate(admin: Admin, userIds: string[], nowMs = Date.now()): Promise<FxFireGate> {
  const eligible = new Set<string>();
  const billable = new Set<string>();
  const ids = [...new Set(userIds)];
  if (!ids.length) return { eligible, billable };
  const pass = await flowPassUserIds(admin, ids);
  const rest = ids.filter((u) => !pass.has(u));
  for (const u of pass) eligible.add(u);                 // Pass: trade, no charge
  if (!rest.length) return { eligible, billable };
  const { data, error } = await admin.from("user_credits").select("user_id, balance, topped_up_on").in("user_id", rest);
  if (error) { for (const u of rest) eligible.add(u); return { eligible, billable }; }   // unreadable → trade, charge nobody
  const rows = new Map(((data ?? []) as { user_id: string; balance?: number | null; topped_up_on?: string | null }[]).map((r) => [String(r.user_id), r]));
  for (const u of rest) {
    if (!canAfford(rows.get(u) ?? null, TRADE_COST, DAILY_FREE, nowMs)) continue;       // cannot pay → sits out
    eligible.add(u); billable.add(u);
  }
  return { eligible, billable };
}

/** Charge the 5-credit fee for an order that WAS placed. Once per member per call. */
export async function chargeFxFire(admin: Admin, userId: string, fireKey: string, gate: FxFireGate): Promise<string> {
  if (!gate.billable.has(userId)) return "free";
  const c = await billEvent(admin, userId, `genfx:${fireKey}`, "trade", false);
  return c.result;
}

/** A setup is forming: 1 credit to each of these members (the ones armed for this pair and in scope). */
export async function billFxSetup(admin: Admin, setupKey: string, userIds: string[]): Promise<{ members: number; charged: number; paused: number; pass: number }> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return { members: 0, charged: 0, paused: 0, pass: 0 };
  const pass = await flowPassUserIds(admin, ids);
  let charged = 0, paused = 0;
  for (const u of ids) {
    if (pass.has(u)) continue;
    const c = await billEvent(admin, u, `genfx:${setupKey}`, "setup", false);
    if (c.result === "charged") charged++; else if (c.result === "paused") paused++;
  }
  return { members: ids.length - pass.size, charged, paused, pass: pass.size };
}
