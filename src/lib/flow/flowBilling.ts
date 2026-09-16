/**
 * FLOW CREDITS — PER CONNECTED ACCOUNT (owner 09-16: "make sure everyone has to use a credit to use flow
 * and when it's watching it pulls credits"; answers: charge per account, Trading Suite subscribers pay too).
 *
 * Every account FLOW is running on (autotrade_enabled OR genx_follower) costs its owner CREDIT_COST.flow_autorun
 * (1) credit per 30-minute watching window while gold is open. The always-on worker bills every armed account
 * each minute whether or not a trade fires; the placement paths also bill a due account before its order leaves,
 * so no account ever trades without a paid window.
 *
 *  • Out of credits → the ACCOUNT is paused (flow_credit_paused) and takes no FLOW/GENX entries. It resumes
 *    automatically on the first charge that succeeds after the member tops up.
 *  • Market closed / weekend-close window → nothing is billed.
 *  • A billing SYSTEM error fails open (never pauses a member over a DB blip).
 *  • The window is CLAIMED atomically before the charge, so the worker and a placement can never both bill
 *    the same window.
 *  • Manual member plays/tests are never billed or blocked here.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { CREDIT_COST, DAILY_FREE } from "@/lib/creditConfig";
import { goldMarketOpen } from "@/lib/genx3/v31/series";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
export const FLOW_ACCOUNT_COST = CREDIT_COST.flow_autorun ?? 1;
export const FLOW_ACCOUNT_WINDOW_MS = 30 * 60_000;
export type BillRow = { account_id: string; user_id: string; flow_last_credit_at: string | null; flow_credit_paused: boolean | null };

/** Is this account due for a charge? (pure) */
export function billingDue(r: Pick<BillRow, "flow_last_credit_at" | "flow_credit_paused">, nowMs: number): boolean {
  if (r.flow_credit_paused) return true;
  const last = r.flow_last_credit_at ? Date.parse(r.flow_last_credit_at) : 0;
  return !last || nowMs - last >= FLOW_ACCOUNT_WINDOW_MS;
}
/** Billing runs only while gold is open, and not in the final 30 minutes before Friday's close. */
export function billingOpen(nowMs: number): boolean {
  if (!goldMarketOpen(nowMs)) return false;
  const nyFriLate = !goldMarketOpen(nowMs + 30 * 60_000) && !goldMarketOpen(nowMs + 90 * 60_000); // closes within 30m and stays closed (weekend)
  return !nyFriLate;
}
/** Manual member plays/tests are not FLOW automation. */
export const isManualSource = (source: string) => /^(play|test)/i.test(source);

export type ChargeResult = "charged" | "inside_window" | "paused" | "closed" | "error";
/** Bill one account if its window is due. Returns whether the account may trade now. */
export async function chargeAccount(admin: Admin, r: BillRow, nowMs = Date.now()): Promise<{ result: ChargeResult; ok: boolean }> {
  if (!billingOpen(nowMs)) return { result: "closed", ok: false };
  if (!billingDue(r, nowMs)) return { result: "inside_window", ok: true };
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - FLOW_ACCOUNT_WINDOW_MS).toISOString();
  // CLAIM the window first (atomic): only one caller can move flow_last_credit_at for this window.
  const { data: claimed, error: ce } = await admin.from("flow_broker_accounts")
    .update({ flow_last_credit_at: nowIso })
    .eq("account_id", r.account_id)
    .or(`flow_credit_paused.eq.true,flow_last_credit_at.is.null,flow_last_credit_at.lt.${cutoff}`)
    .select("account_id");
  if (ce) return { result: "error", ok: !r.flow_credit_paused };            // system fault → fail open for a paid account
  if (!claimed || !claimed.length) return { result: "inside_window", ok: true }; // someone else just billed this window
  let ok = true, systemFault = false;
  try {
    const { data, error } = await admin.rpc("spend_credits_for", { p_user_id: r.user_id, p_cost: FLOW_ACCOUNT_COST, p_daily_allowance: DAILY_FREE, p_feature: "flow_autorun" });
    if (error) systemFault = true; else ok = !!(data && (data as { ok?: boolean }).ok);
  } catch { systemFault = true; }
  if (systemFault) return { result: "error", ok: !r.flow_credit_paused };
  await admin.from("flow_broker_accounts").update({ flow_credit_paused: !ok }).eq("account_id", r.account_id);
  return ok ? { result: "charged", ok: true } : { result: "paused", ok: false };
}

/** Placement gate: of these account ids, which may trade right now (billing each due one first)? */
export async function billedAccountIds(admin: Admin, accountIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!accountIds.length) return out;
  const { data, error } = await admin.from("flow_broker_accounts").select("account_id, user_id, flow_last_credit_at, flow_credit_paused").in("account_id", accountIds);
  if (error) { for (const id of accountIds) out.add(id); return out; }     // unreadable → fail open (never block over a DB blip)
  for (const r of (data ?? []) as BillRow[]) {
    const c = await chargeAccount(admin, r).catch(() => ({ result: "error" as const, ok: !r.flow_credit_paused }));
    if (c.ok) out.add(String(r.account_id));
  }
  return out;
}

/** Worker pass: bill every account FLOW is watching; mirror a per-member paused flag for the UI. */
export async function billFlowAccounts(admin: Admin, nowMs = Date.now()): Promise<{ open: boolean; accounts: number; charged: number; paused: number; errors: number }> {
  if (!billingOpen(nowMs)) return { open: false, accounts: 0, charged: 0, paused: 0, errors: 0 };
  const { data, error } = await admin.from("flow_broker_accounts").select("account_id, user_id, flow_last_credit_at, flow_credit_paused").or("autotrade_enabled.eq.true,genx_follower.eq.true");
  if (error) return { open: true, accounts: 0, charged: 0, paused: 0, errors: 1 };
  const rows = (data ?? []) as BillRow[];
  let charged = 0, paused = 0, errors = 0;
  const pausedUsers = new Map<string, boolean>();
  for (const r of rows) {
    const c = await chargeAccount(admin, r, nowMs).catch(() => ({ result: "error" as const, ok: true }));
    if (c.result === "charged") charged++; else if (c.result === "paused") paused++; else if (c.result === "error") errors++;
    const isPaused = c.result === "paused" || (c.result === "error" && !!r.flow_credit_paused);
    pausedUsers.set(r.user_id, (pausedUsers.get(r.user_id) ?? false) || isPaused);
  }
  for (const [uid, p] of pausedUsers) { try { await admin.from("flow_auto_settings").update({ credit_paused: p }).eq("user_id", uid).neq("credit_paused", p); } catch { /* UI mirror best-effort */ } }
  return { open: true, accounts: rows.length, charged, paused, errors };
}
