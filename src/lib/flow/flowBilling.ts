/**
 * FLOW CREDITS — PER MEMBER (owner 09-16: "make sure everyone has to use a credit to use flow and when it's
 * watching it pulls credits", Trading Suite subscribers pay too; owner 09-17: "only charging one credit, no
 * matter how many accounts").
 *
 * A member with FLOW running on any account (autotrade_enabled OR genx_follower) pays CREDIT_COST.flow_autorun
 * (1) credit per 30-minute watching window while gold is open — once, however many accounts they connect. The always-on worker bills every armed account
 * each minute whether or not a trade fires; the placement paths also bill a due account before its order leaves,
 * so no account ever trades without a paid window.
 *
 *  • Out of credits → the member's accounts are paused (flow_credit_paused) and takes no FLOW/GENX entries. It resumes
 *    automatically on the first charge that succeeds after the member tops up.
 *  • Market closed / weekend-close window → nothing is billed.
 *  • A billing SYSTEM error fails open (never pauses a member over a DB blip).
 *  • Billing runs in one Postgres function under a per-member lock (flow_bill_member), so the worker and a
 *    placement can never both bill the same window.
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
/** Bill one MEMBER for the current 30-min window (one credit however many accounts). Atomic in Postgres. */
export async function chargeMember(admin: Admin, userId: string, wasPaused: boolean, nowMs = Date.now()): Promise<{ result: ChargeResult; ok: boolean }> {
  if (!billingOpen(nowMs)) return { result: "closed", ok: false };
  try {
    const { data, error } = await admin.rpc("flow_bill_member", { p_user: userId, p_cost: FLOW_ACCOUNT_COST, p_allowance: DAILY_FREE, p_window_secs: FLOW_ACCOUNT_WINDOW_MS / 1000 });
    if (error || !data) return { result: "error", ok: !wasPaused };          // system fault → fail open for a paid member
    const d = data as { result: ChargeResult; ok: boolean };
    return { result: d.result, ok: !!d.ok };
  } catch { return { result: "error", ok: !wasPaused }; }
}

/** Placement gate: of these account ids, which may trade right now? Each owning member is billed at most once. */
export async function billedAccountIds(admin: Admin, accountIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!accountIds.length) return out;
  const { data, error } = await admin.from("flow_broker_accounts").select("account_id, user_id, flow_last_credit_at, flow_credit_paused").in("account_id", accountIds);
  if (error) { for (const id of accountIds) out.add(id); return out; }     // unreadable → fail open (never block over a DB blip)
  const rows = (data ?? []) as BillRow[];
  const byUser = new Map<string, BillRow[]>();
  for (const r of rows) { const l = byUser.get(r.user_id) ?? []; l.push(r); byUser.set(r.user_id, l); }
  for (const [uid, list] of byUser) {
    const wasPaused = list.every((r) => !!r.flow_credit_paused);
    const c = await chargeMember(admin, uid, wasPaused);
    if (c.ok) for (const r of list) out.add(String(r.account_id));
  }
  return out;
}

/** Worker pass: bill every member FLOW is watching for (one credit per member per window); mirror the paused flag for the UI. */
export async function billFlowAccounts(admin: Admin, nowMs = Date.now()): Promise<{ open: boolean; members: number; charged: number; paused: number; errors: number }> {
  if (!billingOpen(nowMs)) return { open: false, members: 0, charged: 0, paused: 0, errors: 0 };
  const { data, error } = await admin.from("flow_broker_accounts").select("account_id, user_id, flow_last_credit_at, flow_credit_paused").or("autotrade_enabled.eq.true,genx_follower.eq.true");
  if (error) return { open: true, members: 0, charged: 0, paused: 0, errors: 1 };
  const byUser = new Map<string, BillRow[]>();
  for (const r of (data ?? []) as BillRow[]) { const l = byUser.get(r.user_id) ?? []; l.push(r); byUser.set(r.user_id, l); }
  let charged = 0, paused = 0, errors = 0;
  for (const [uid, list] of byUser) {
    const wasPaused = list.every((r) => !!r.flow_credit_paused);
    // skip the RPC when every account is clearly inside a paid window
    if (!list.some((r) => billingDue(r, nowMs))) continue;
    const c = await chargeMember(admin, uid, wasPaused, nowMs);
    if (c.result === "charged") charged++; else if (c.result === "paused") paused++; else if (c.result === "error") errors++;
    const isPaused = c.result === "paused" || (c.result === "error" && wasPaused);
    if (c.result !== "inside_window") { try { await admin.from("flow_auto_settings").update({ credit_paused: isPaused }).eq("user_id", uid).neq("credit_paused", isPaused); } catch { /* UI mirror best-effort */ } }
  }
  return { open: true, members: byUser.size, charged, paused, errors };
}
