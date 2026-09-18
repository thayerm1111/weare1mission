/**
 * COMMAND CENTER XAUUSD — ACCOUNT PERMISSIONS + KILL SWITCH
 *
 * Every automated action asks this module first. The rules it encodes are the ones in
 * docs/gold-command/GOLD_COMMAND_SECURITY.md:
 *
 *   • Entries are OPT-IN. A newly connected account never trades until the member turns it on.
 *   • Protection is OPT-OUT. Closing, stop moves and break-even default ON, because an account that is
 *     already in a trade must be defendable; a member who wants to manage by hand switches them off.
 *   • Scale-in and pending orders are OFF by default — they add exposure, so they need an explicit yes.
 *   • The kill switch blocks NEW ENTRIES ONLY. It never stops the desk from protecting an open position:
 *     "stop trading" must never mean "stop defending what is open".
 *
 * Resolution is pure and unit-tested. The stored object may be empty, partial, or carry keys this build has
 * never heard of — the answer is always defined.
 */
export type PermissionKey =
  | "allow_entries" | "allow_close" | "allow_partial" | "allow_stop_move" | "allow_break_even"
  | "allow_tp_move" | "allow_trailing" | "allow_choch_exit" | "allow_pending"
  | "allow_scale_in" | "allow_scale_out";

export const PERMISSION_KEYS: PermissionKey[] = [
  "allow_entries", "allow_close", "allow_partial", "allow_stop_move", "allow_break_even",
  "allow_tp_move", "allow_trailing", "allow_choch_exit", "allow_pending", "allow_scale_in", "allow_scale_out",
];

/** Defaults when a key has never been set on the account. */
export const PERMISSION_DEFAULTS: Record<PermissionKey, boolean> = {
  allow_entries: false,      // opt-in: nothing trades until the member says so
  allow_close: true,
  allow_partial: true,
  allow_stop_move: true,
  allow_break_even: true,
  allow_tp_move: true,
  allow_trailing: true,
  allow_choch_exit: true,
  allow_pending: false,      // adds resting exposure → explicit yes
  allow_scale_in: false,     // adds exposure to an open trade → explicit yes
  allow_scale_out: true,
};

export const PERMISSION_LABEL: Record<PermissionKey, string> = {
  allow_entries: "Open new trades",
  allow_close: "Close positions",
  allow_partial: "Take partial profit",
  allow_stop_move: "Move the stop",
  allow_break_even: "Move to break-even",
  allow_tp_move: "Move the take-profit",
  allow_trailing: "Trail the stop",
  allow_choch_exit: "Exit on a change of character",
  allow_pending: "Place pending orders",
  allow_scale_in: "Scale into a position",
  allow_scale_out: "Scale out of a position",
};

/** Actions that ADD or KEEP exposure. The kill switch stops exactly these. */
export const ENTRY_ACTIONS: PermissionKey[] = ["allow_entries", "allow_pending", "allow_scale_in"];

export type AccountRow = {
  account_id?: string | null;
  autotrade_enabled?: boolean | null;
  manage_trades?: boolean | null;
  permissions?: Record<string, unknown> | null;
  kill_switch_at?: string | null;
};

export type Verdict = { allowed: boolean; reason: string };

const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** What this account permits for one action, with the reason a member would be shown. Pure. */
export function can(acct: AccountRow | null | undefined, key: PermissionKey, nowMs = Date.now()): Verdict {
  if (!acct) return { allowed: false, reason: "Account not found" };
  const isEntry = ENTRY_ACTIONS.includes(key);

  // KILL SWITCH — new exposure only. Protection always survives it.
  if (isEntry && acct.kill_switch_at) {
    const at = Date.parse(acct.kill_switch_at);
    if (Number.isFinite(at) && at <= nowMs) {
      return { allowed: false, reason: "Kill switch is on for this account — no new trades. Open positions are still protected." };
    }
  }

  // The master automation switch gates ENTRIES only; an account switched off mid-trade must still be
  // defendable, which is the whole reason protection is evaluated separately.
  if (isEntry && acct.autotrade_enabled === false) {
    return { allowed: false, reason: "Auto-trading is off for this account" };
  }
  // The legacy master management switch still turns every management action off in one move.
  if (!isEntry && acct.manage_trades === false) {
    return { allowed: false, reason: "Auto-management is off for this account" };
  }

  const stored = asBool((acct.permissions ?? {})[key]);
  const allowed = stored ?? PERMISSION_DEFAULTS[key];
  return allowed
    ? { allowed: true, reason: "" }
    : { allowed: false, reason: `${PERMISSION_LABEL[key]} is switched off for this account` };
}

/** Every resolved permission for display. Pure. */
export function resolveAll(acct: AccountRow | null | undefined, nowMs = Date.now()): Record<PermissionKey, boolean> {
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, can(acct, k, nowMs).allowed])) as Record<PermissionKey, boolean>;
}

/** Only known keys, only booleans — a client can never write junk or unknown flags into the account. */
export function sanitisePermissions(input: unknown): Partial<Record<PermissionKey, boolean>> {
  const out: Partial<Record<PermissionKey, boolean>> = {};
  if (!input || typeof input !== "object") return out;
  for (const k of PERMISSION_KEYS) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export const isKilled = (acct: AccountRow | null | undefined, nowMs = Date.now()): boolean =>
  !!acct?.kill_switch_at && Date.parse(acct.kill_switch_at) <= nowMs;
