/**
 * ONE FLOW SWITCH (owner 09-24: "Fix the toggles").
 *
 * FLOW has always had two arm flags and no rule tying them together:
 *
 *   • the MASTER toggle  — flow_auto_settings.enabled, what the FLOW panel shows
 *   • the ACCOUNT flags  — flow_broker_accounts.autotrade_enabled / genx_follower, what the broker
 *     panel shows, one per connected trading account
 *
 * Nothing kept them in agreement, so both halves of the contradiction were reachable and both lied
 * to the member:
 *
 *   master OFF + account ON → the broker panel says the account is trading. Billing's FLOW-off gate
 *     drops the member entirely, so nothing is placed and nothing is charged. 25 members were sitting
 *     in this state; earlier in September the same shape silenced 34 members who thought FLOW was on.
 *   master ON + no account ON → the FLOW panel says auto-run is armed and there is nothing to run it
 *     on. 8 members were here.
 *
 * The fix is not another check at the point of trading. It is to stop the two flags from ever
 * disagreeing, by making every write to either one go through this module:
 *
 *   arming any account   → arms the master
 *   disarming the last   → disarms the master (nothing left to run)
 *   master off           → disarms every account, GENX following included (owner: "off means off" —
 *                          and since billing bills on either flag, leaving GENX armed would mean
 *                          "FLOW off" still charged them, which is the complaint this started from)
 *   master on            → arms accounts if none are armed, so "on" is never on-with-nothing-to-do
 *
 * Every function here is best-effort and reports what it actually did. A caller that cannot reconcile
 * re-reads the truth and returns THAT to the UI, so a failed sync shows up as an honest toggle
 * position rather than quietly recreating the drift this module exists to remove.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export type AcctArmRow = {
  account_id: string;
  autotrade_enabled?: boolean | null;
  genx_follower?: boolean | null;
  is_selected?: boolean | null;
};

/** Is this account armed for anything FLOW bills or trades? */
export const acctArmed = (a: AcctArmRow) => a.autotrade_enabled === true || a.genx_follower === true;

/**
 * What the master SHOULD be, given the member's accounts. Pure, so the rule is testable without a
 * database: any account armed → master on; none → master off.
 */
export const masterShouldBe = (accts: AcctArmRow[]) => accts.some(acctArmed);

/**
 * Which accounts to arm when the master is switched on and nothing is armed yet. Preference order:
 * the accounts the member has selected, else the single account if they only have one. With several
 * unselected accounts we arm NOTHING and let the caller tell them to pick — guessing which of a
 * member's brokerage accounts should start trading real money is not a guess worth making.
 */
export function accountsToArmOnMasterOn(accts: AcctArmRow[]): string[] {
  if (accts.some(acctArmed)) return [];                       // already armed — leave their choice alone
  const selected = accts.filter((a) => a.is_selected === true);
  if (selected.length) return selected.map((a) => a.account_id);
  if (accts.length === 1) return [accts[0].account_id];
  return [];
}

async function readAccts(admin: Admin, userId: string): Promise<AcctArmRow[] | null> {
  const { data, error } = await admin
    .from("flow_broker_accounts")
    .select("account_id, autotrade_enabled, genx_follower, is_selected")
    .eq("user_id", userId);
  if (error) return null;
  return (data ?? []) as AcctArmRow[];
}

/** Read the master flag. null when it cannot be read (never guess — callers fail safe on null). */
export async function readMaster(admin: Admin, userId: string): Promise<boolean | null> {
  const { data, error } = await admin
    .from("flow_auto_settings").select("enabled").eq("user_id", userId).maybeSingle();
  if (error) return null;
  // No row is not "off": the engine fans out to armed accounts that have no settings row, and
  // billing treats a missing row as billable. Report it as on so we never "reconcile" a trading
  // member into silence.
  if (!data) return true;
  return (data as { enabled?: boolean | null }).enabled === true;
}

const DEFAULT_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "NAS100"];

/** Set the master flag, creating a fully-formed row if the member has never had one. */
export async function setMaster(admin: Admin, userId: string, enabled: boolean): Promise<boolean> {
  const nowIso = new Date().toISOString();
  try {
    const { data: existing } = await admin
      .from("flow_auto_settings").select("user_id").eq("user_id", userId).maybeSingle();
    if (existing) {
      const patch: Record<string, unknown> = { enabled, updated_at: nowIso };
      // Arming clears the credit pause and the billing window so the next market tick charges and
      // trades immediately, exactly as the FLOW panel's own enable path has always done.
      if (enabled) { patch.credit_paused = false; patch.last_credit_at = null; }
      else { patch.credit_paused = false; }
      const { error } = await admin.from("flow_auto_settings").update(patch).eq("user_id", userId);
      return !error;
    }
    const { error } = await admin.from("flow_auto_settings").insert({
      user_id: userId, enabled, mode: "auto", symbols: DEFAULT_SYMBOLS,
      max_lot: 1.0, max_open: 1, max_orders_per_hour: 6, daily_loss_limit: 0,
      credit_paused: false, last_credit_at: null, updated_at: nowIso,
    });
    return !error;
  } catch { return false; }
}

/** Arm or disarm every one of the member's accounts. Used by the master's own on/off. */
export async function setAllAccounts(admin: Admin, userId: string, enabled: boolean, accountIds?: string[]): Promise<number> {
  const nowIso = new Date().toISOString();
  // Turning FLOW off clears GENX following too (owner 09-24) — see the header. Turning it ON only
  // arms auto-trading: GENX following is a separate opt-in and is never switched on for someone.
  const patch = enabled
    ? { autotrade_enabled: true, updated_at: nowIso }
    : { autotrade_enabled: false, genx_follower: false, updated_at: nowIso };
  let q = admin.from("flow_broker_accounts").update(patch).eq("user_id", userId);
  if (accountIds && accountIds.length) q = q.in("account_id", accountIds);
  const { data, error } = await q.select("account_id");
  if (error) return 0;
  return (data ?? []).length;
}

export type SyncResult = { master: boolean | null; changed: boolean; armedAccounts: number };

/**
 * Call after ANY per-account arm write. Brings the master into line with what the accounts now say.
 * Returns the master's real value afterwards so the caller can hand the UI the truth rather than
 * what it hoped happened.
 */
export async function syncMasterFromAccounts(admin: Admin, userId: string): Promise<SyncResult> {
  const accts = await readAccts(admin, userId);
  if (accts === null) return { master: await readMaster(admin, userId), changed: false, armedAccounts: 0 };
  const armed = accts.filter(acctArmed).length;
  const want = masterShouldBe(accts);
  const have = await readMaster(admin, userId);
  if (have === want) return { master: have, changed: false, armedAccounts: armed };
  const ok = await setMaster(admin, userId, want);
  return { master: ok ? want : have, changed: ok, armedAccounts: armed };
}

export type MasterApply = { accountsChanged: number; needsAccountPick: boolean; armedAccounts: number };

/**
 * Call after the master is switched. Brings the accounts into line with what the master now says.
 * `needsAccountPick` is true when the member switched FLOW on, has several accounts and has selected
 * none — the honest answer there is to ask them which one, not to start trading one at random.
 */
export async function syncAccountsFromMaster(admin: Admin, userId: string, enabled: boolean): Promise<MasterApply> {
  const accts = await readAccts(admin, userId);
  if (accts === null) return { accountsChanged: 0, needsAccountPick: false, armedAccounts: 0 };
  if (!enabled) {
    const armed = accts.filter(acctArmed);
    if (!armed.length) return { accountsChanged: 0, needsAccountPick: false, armedAccounts: 0 };
    const n = await setAllAccounts(admin, userId, false, armed.map((a) => a.account_id));
    return { accountsChanged: n, needsAccountPick: false, armedAccounts: 0 };
  }
  const already = accts.filter(acctArmed).length;
  if (already) return { accountsChanged: 0, needsAccountPick: false, armedAccounts: already };
  const toArm = accountsToArmOnMasterOn(accts);
  if (!toArm.length) return { accountsChanged: 0, needsAccountPick: accts.length > 0, armedAccounts: 0 };
  const n = await setAllAccounts(admin, userId, true, toArm);
  return { accountsChanged: n, needsAccountPick: false, armedAccounts: n };
}
