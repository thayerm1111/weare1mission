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
import { flowPassUserIds } from "@/lib/subscription";
import { goldMarketOpen } from "@/lib/genx3/v31/series";
import { swingAllowed } from "@/lib/genx/swingFloor";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
export const FLOW_ACCOUNT_COST = CREDIT_COST.flow_autorun ?? 1;
export const FLOW_ACCOUNT_WINDOW_MS = 30 * 60_000;
export type BillRow = { account_id: string; user_id: string; flow_last_credit_at: string | null; flow_credit_paused: boolean | null; equity?: number | null; balance?: number | null };

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

/**
 * FLOW OFF = NO CHARGES (owner 09-23: "if people don't have flow turned on it's gotta stop taking their
 * credits — some people are saying their credits are going down even though they aren't using flow").
 *
 * FLOW has two switches: the member's master auto-run toggle (flow_auto_settings.enabled, what the FLOW
 * panel shows) and the older per-account arm flags on flow_broker_accounts (autotrade_enabled /
 * genx_follower). Billing used to read ONLY the per-account flags, so a member who turned the master
 * toggle OFF kept paying — 56 members were billed 6,149 credits over 14 days for ZERO trades, almost all
 * of it the 1-credit "setup is forming" charge.
 *
 * This is the single gate every billing path runs through. A member is billable unless their settings row
 * says enabled === false:
 *   • row with enabled=false → NEVER billed, and never traded (their accounts are dropped from the fire).
 *   • row with enabled=true  → billed as before.
 *   • NO row at all          → billed as before. This is deliberate: the engine deliberately fans out to
 *     autotrade-enabled accounts that have no settings row (see autoExec "UNIFIED FAN-OUT"), so those
 *     members DO trade and must still pay. Only an explicit OFF stops the meter.
 * Unreadable settings table → everyone stays billable (fail open; never break billing over a DB blip).
 */
export async function flowOffUserIds(admin: Admin, userIds: string[]): Promise<Set<string>> {
  const off = new Set<string>();
  if (!userIds.length) return off;
  const { data, error } = await admin.from("flow_auto_settings").select("user_id, enabled").in("user_id", userIds);
  if (error) return off;                                                   // fail open
  for (const r of (data ?? []) as { user_id: string; enabled?: boolean | null }[]) {
    if (r.enabled === false) off.add(String(r.user_id));
  }
  return off;
}

/**
 * Split a user→accounts map three ways. Every billing path runs through this, so the three rules
 * live in exactly one place:
 *
 *   OFF   — master FLOW toggle explicitly off → no trade AND no charge. Dropped entirely.
 *   PASS  — active $99 FLOW Pass          → TRADES NORMALLY, never charged, never credit-paused.
 *                                            This is the whole product they bought; do not confuse
 *                                            "not billable" with "not allowed to trade".
 *   BILL  — everyone else                 → metered exactly as before.
 *
 * A member who is both off and a Pass holder is OFF: they asked for it not to run, and a paid plan
 * is not a reason to override that.
 */
export type Split = { bill: Map<string, BillRow[]>; pass: Map<string, BillRow[]> };

/** The decision itself, with no I/O, so it can be tested directly. */
export function splitBy(byUser: Map<string, BillRow[]>, off: Set<string>, pass: Set<string>): Split {
  if (!off.size && !pass.size) return { bill: byUser, pass: new Map() };
  const bill = new Map<string, BillRow[]>();
  const free = new Map<string, BillRow[]>();
  for (const [uid, list] of byUser) {
    if (off.has(uid)) continue;            // off beats everything, including a paid Pass
    if (pass.has(uid)) free.set(uid, list);
    else bill.set(uid, list);
  }
  return { bill, pass: free };
}

async function splitUsers(admin: Admin, byUser: Map<string, BillRow[]>): Promise<Split> {
  const ids = [...byUser.keys()];
  const [off, pass] = await Promise.all([flowOffUserIds(admin, ids), flowPassUserIds(admin, ids)]);
  return splitBy(byUser, off, pass);
}

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
  const split = await splitUsers(admin, byUser);
  for (const list of split.pass.values()) for (const r of list) out.add(String(r.account_id)); // Pass: trade, no charge
  for (const [uid, list] of split.bill) {
    const wasPaused = list.every((r) => !!r.flow_credit_paused);
    const c = await chargeMember(admin, uid, wasPaused);
    if (c.ok) for (const r of list) out.add(String(r.account_id));
  }
  return out;
}

/** EVENT BILLING (owner 09-18: "5 credits per trade and 1 when the trade is forming"). Watching is free —
 *  a member pays 1 credit when a setup they are armed for starts forming, and 5 when GENX actually puts an
 *  order on one of their accounts. Charges are idempotent per member per event key, so retries, a second
 *  account and two workers can never double-charge the same setup or the same fire. */
export const SETUP_COST = 1;
export const TRADE_COST = 5;

export async function billEvent(admin: Admin, userId: string, key: string, kind: "setup" | "trade", wasPaused = false): Promise<{ result: "charged" | "already" | "paused" | "error"; ok: boolean }> {
  const cost = kind === "trade" ? TRADE_COST : SETUP_COST;
  try {
    const { data, error } = await admin.rpc("flow_bill_event", { p_user: userId, p_key: `${kind}:${key}`, p_kind: kind, p_cost: cost, p_allowance: DAILY_FREE });
    if (error || !data) return { result: "error", ok: !wasPaused };          // system fault → fail open for a paid member
    const d = data as { result: "charged" | "already" | "paused" | "error"; ok: boolean };
    return { result: d.result, ok: !!d.ok };
  } catch { return { result: "error", ok: !wasPaused }; }
}

/*
 * PAY FOR THE TRADE, NOT THE ATTEMPT (owner 09-29: "when it's on and never takes a trade it looks like
 * it's pulling more than it should").
 *
 * The 5-credit fire fee used to be taken at the top of the fan-out, before a single per-account check
 * had run — so an account the broker did not return, one whose orders could not be read, one under
 * the swing floor, one already in a trade, all paid the full fee for a fire that placed nothing. Over
 * one week that was 509 of 1,577 fires (32%), 2,545 credits, 48 members; one member paid 355 credits
 * for zero trades.
 *
 * Now the fee has two halves. BEFORE placing, `fireEligibleAccountIds` decides who may trade this
 * fire — the OFF / Pass / billable split as before, plus "can this member actually pay the fee?" —
 * and charges nobody. AFTER an order is confirmed on the account, `chargePlacedFire` bills the member
 * once for the fire (idempotent per member per fire key, so a second account or a retry never
 * double-charges). A member whose fire ends in a skip pays nothing for it. If the fee cannot be
 * collected after the fill (the balance moved in between), the trade stands and the member is
 * credit-paused for the NEXT fire, exactly as an up-front failure used to pause them.
 */

/** The Monday 00:00 UTC that starts the current billing week — the same boundary the DB top-up uses. */
export function weekStartUtc(nowMs: number): number {
  const d = new Date(nowMs);
  const dow = d.getUTCDay();               // 0 = Sunday
  const back = (dow + 6) % 7;              // days since Monday
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}

/**
 * Could this member pay `cost` right now? Mirrors spend_credits_for without touching anything: the
 * balance covers it, or the weekly top-up to the free floor is still owed this week and the floor
 * covers it. No row at all is a brand-new member, whose first touch mints the welcome grant. Pure.
 */
export function canAfford(row: { balance?: number | null; topped_up_on?: string | null } | null, cost: number, allowance: number, nowMs: number): boolean {
  if (!row) return Math.max(5, allowance) >= cost;      // welcome grant on first touch
  const bal = Number(row.balance) || 0;
  if (bal >= cost) return true;
  const topped = row.topped_up_on ? Date.parse(row.topped_up_on) : NaN;
  const owedThisWeek = !Number.isFinite(topped) || topped < weekStartUtc(nowMs);
  return owedThisWeek && Math.max(bal, allowance) >= cost;
}

async function canAffordFire(admin: Admin, userId: string, nowMs = Date.now()): Promise<boolean> {
  try {
    const { data, error } = await admin.from("user_credits").select("balance, topped_up_on").eq("user_id", userId).maybeSingle();
    if (error) return true;                              // unreadable → fail open, never bench a paid member on a blip
    return canAfford((data as { balance?: number | null; topped_up_on?: string | null } | null) ?? null, TRADE_COST, DAILY_FREE, nowMs);
  } catch { return true; }
}

export type FireGate = {
  /** Accounts that may trade this fire. */
  eligible: Set<string>;
  /** Members to bill once an order is actually placed. Pass holders and OFF members are never in here. */
  billable: Set<string>;
};

/** Placement PRE-GATE under event billing: which of these accounts may trade this fire? Charges nobody. */
export async function fireEligibleAccountIds(admin: Admin, accountIds: string[]): Promise<FireGate> {
  const eligible = new Set<string>();
  const billable = new Set<string>();
  if (!accountIds.length) return { eligible, billable };
  const { data, error } = await admin.from("flow_broker_accounts").select("account_id, user_id, flow_last_credit_at, flow_credit_paused").in("account_id", accountIds);
  if (error) { for (const id of accountIds) eligible.add(id); return { eligible, billable }; } // unreadable → trade, and (as before) nobody is charged
  const rows = (data ?? []) as BillRow[];
  const byUser = new Map<string, BillRow[]>();
  for (const r of rows) { const l = byUser.get(r.user_id) ?? []; l.push(r); byUser.set(r.user_id, l); }
  const split = await splitUsers(admin, byUser);
  for (const list of split.pass.values()) for (const r of list) eligible.add(String(r.account_id)); // Pass: trade, no charge
  for (const [uid, list] of split.bill) {
    if (!(await canAffordFire(admin, uid))) continue;    // out of credits → skipped before any order, as before
    billable.add(uid);
    for (const r of list) eligible.add(String(r.account_id));
  }
  return { eligible, billable };
}

/**
 * Charge the fire fee for an order that WAS placed. Once per member per fire — a second account on the
 * same fire, or a retry, gets "already". Members outside `billable` (Pass, OFF) pay nothing.
 */
export async function chargePlacedFire(admin: Admin, userId: string, fireKey: string, gate: FireGate): Promise<"charged" | "already" | "paused" | "error" | "free"> {
  if (!gate.billable.has(userId)) return "free";
  const c = await billEvent(admin, userId, fireKey, "trade", false);
  return c.result;
}

/*
 * THE SETUP FEE GOES TO MEMBERS WHO COULD TAKE THE SETUP (owner 09-29). "1 when the trade is forming"
 * was billed to every armed member, including the ones the fire could never reach: a member whose
 * broker no longer returns their account, and a member under the $1,500 swing floor when the setup
 * forming is a swing. In one week 61 members with zero trades paid 775 credits in setup fees.
 *
 * Two rules, both from evidence the desk already has:
 *   • BROKER NOT USABLE — the member's latest broker-level failure (account not returned, login
 *     failed, no token, orders unreadable) is more recent than their latest placed order, within the
 *     last 24h. They are not billed until a fire actually reaches their account again.
 *   • SWING FLOOR — for a swing setup, a member whose every armed account is under the floor (or of
 *     unknown size, which swing refuses) is not billed for it. Quick and intraday setups are untouched.
 */
const BROKER_FAILURE_PATTERNS = ["no_equity", "connection_unreachable", "no_broker_token", "no_active_accounts", "broker_unreadable"];
export const UNREACHABLE_WINDOW_MS = 24 * 60 * 60_000;

/** Pure: which members' latest broker failure is newer than their latest placed order. */
export function unreachableFrom(
  fails: { user_id: string; created_at: string }[],
  placed: { user_id: string; created_at: string }[],
): Set<string> {
  const lastFail = new Map<string, number>();
  for (const f of fails) { const t = Date.parse(f.created_at); if (Number.isFinite(t) && t > (lastFail.get(f.user_id) ?? -Infinity)) lastFail.set(f.user_id, t); }
  const lastPlaced = new Map<string, number>();
  for (const p of placed) { const t = Date.parse(p.created_at); if (Number.isFinite(t) && t > (lastPlaced.get(p.user_id) ?? -Infinity)) lastPlaced.set(p.user_id, t); }
  const out = new Set<string>();
  for (const [uid, t] of lastFail) if ((lastPlaced.get(uid) ?? -Infinity) < t) out.add(uid);
  return out;
}

/** Members whose broker has not been usable in the window. Empty (everyone billable) on a read error. */
export async function unreachableUserIds(admin: Admin, nowMs = Date.now()): Promise<Set<string>> {
  const since = new Date(nowMs - UNREACHABLE_WINDOW_MS).toISOString();
  try {
    // GEN FX's rows are left out of both reads (10-02). GEN FX trades its own accounts on its own
    // switch — often a member's demo account — and writes to this same table. Without this, a GEN FX
    // order placed on a demo account would make a member whose GOLD account is unreachable billable
    // again, and a GEN FX skip on a broken demo login would exempt a member whose gold account is
    // fine. This rule is about gold fires, so it reads gold-era evidence only: exactly what it read
    // before GEN FX existed.
    const [fails, placed] = await Promise.all([
      admin.from("flow_auto_events").select("user_id, created_at").eq("status", "skipped").gte("created_at", since)
        .or(BROKER_FAILURE_PATTERNS.map((p) => `reason.ilike.*${p}*`).join(",")).not("reason", "like", "genfx%").limit(20000),
      admin.from("flow_auto_events").select("user_id, created_at").in("status", ["placed", "uncertain"]).gte("created_at", since)
        .or("reason.is.null,reason.not.like.genfx*").limit(20000),
    ]);
    if (fails.error || placed.error) return new Set();
    return unreachableFrom(
      (fails.data ?? []) as { user_id: string; created_at: string }[],
      (placed.data ?? []) as { user_id: string; created_at: string }[],
    );
  } catch { return new Set(); }
}

/** Pure: which billable members should pay for this setup. */
export function setupBillableUsers(billable: Map<string, BillRow[]>, unreachable: Set<string>, mode: string | null | undefined): { bill: Map<string, BillRow[]>; unreachable: number; underFloor: number } {
  const out = new Map<string, BillRow[]>();
  let nUnreachable = 0, nFloor = 0;
  for (const [uid, list] of billable) {
    if (unreachable.has(uid)) { nUnreachable++; continue; }
    if (!list.some((a) => swingAllowed(a, mode))) { nFloor++; continue; }   // only bites for swing setups
    out.set(uid, list);
  }
  return { bill: out, unreachable: nUnreachable, underFloor: nFloor };
}

/** A setup is forming: bill 1 credit to every member armed for it who could take it (once per member per setup). */
export async function billSetupForming(admin: Admin, setupKey: string, mode?: string | null): Promise<{ members: number; charged: number; paused: number; pass: number; unreachable: number; underFloor: number }> {
  const none = { members: 0, charged: 0, paused: 0, pass: 0, unreachable: 0, underFloor: 0 };
  const { data, error } = await admin.from("flow_broker_accounts").select("account_id, user_id, flow_last_credit_at, flow_credit_paused, equity, balance").or("autotrade_enabled.eq.true,genx_follower.eq.true");
  if (error) return none;
  const byUser = new Map<string, BillRow[]>();
  for (const r of (data ?? []) as BillRow[]) { const l = byUser.get(r.user_id) ?? []; l.push(r); byUser.set(r.user_id, l); }
  let charged = 0, paused = 0;
  const split = await splitUsers(admin, byUser);
  // The mode is the first segment of the dedupe key ("swing:sell:4130:4135") when the caller did not say.
  const setupMode = mode ?? setupKey.split(":")[0] ?? null;
  const gated = setupBillableUsers(split.bill, await unreachableUserIds(admin), setupMode);
  const billable = gated.bill;
  for (const [uid, list] of billable) {
    const wasPaused = list.every((r) => !!r.flow_credit_paused);
    const c = await billEvent(admin, uid, setupKey, "setup", wasPaused);
    if (c.result === "charged") charged++; else if (c.result === "paused") paused++;
    const isPaused = c.result === "paused" || (c.result === "error" && wasPaused);
    if (c.result === "charged" || c.result === "paused") { try { await admin.from("flow_auto_settings").update({ credit_paused: isPaused }).eq("user_id", uid).neq("credit_paused", isPaused); } catch { /* UI mirror best-effort */ } }
  }
  return { members: billable.size, charged, paused, pass: split.pass.size, unreachable: gated.unreachable, underFloor: gated.underFloor };
}

/** LEGACY time-window pass — no longer called by the worker (kept for the Vercel cron fallback until it is
 *  migrated). Bills one credit per member per 30-minute watching window. */
export async function billFlowAccounts(admin: Admin, nowMs = Date.now()): Promise<{ open: boolean; members: number; charged: number; paused: number; errors: number }> {
  if (!billingOpen(nowMs)) return { open: false, members: 0, charged: 0, paused: 0, errors: 0 };
  const { data, error } = await admin.from("flow_broker_accounts").select("account_id, user_id, flow_last_credit_at, flow_credit_paused").or("autotrade_enabled.eq.true,genx_follower.eq.true");
  if (error) return { open: true, members: 0, charged: 0, paused: 0, errors: 1 };
  const byUser = new Map<string, BillRow[]>();
  for (const r of (data ?? []) as BillRow[]) { const l = byUser.get(r.user_id) ?? []; l.push(r); byUser.set(r.user_id, l); }
  let charged = 0, paused = 0, errors = 0;
  const split5 = await splitUsers(admin, byUser);
  const billable = split5.bill;
  for (const [uid, list] of billable) {
    const wasPaused = list.every((r) => !!r.flow_credit_paused);
    // skip the RPC when every account is clearly inside a paid window
    if (!list.some((r) => billingDue(r, nowMs))) continue;
    const c = await chargeMember(admin, uid, wasPaused, nowMs);
    if (c.result === "charged") charged++; else if (c.result === "paused") paused++; else if (c.result === "error") errors++;
    const isPaused = c.result === "paused" || (c.result === "error" && wasPaused);
    if (c.result !== "inside_window") { try { await admin.from("flow_auto_settings").update({ credit_paused: isPaused }).eq("user_id", uid).neq("credit_paused", isPaused); } catch { /* UI mirror best-effort */ } }
  }
  return { open: true, members: billable.size, charged, paused, errors };
}
