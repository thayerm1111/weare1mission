/**
 * RAPID — what the account panel says while Automation is locked.
 *
 * THE MINUTE AFTER "ALLOW SHARED ACCOUNT" (owner 10-04: "I want to be able to turn on automation for
 * this"). Rapid's shared-account refusal is written to the account by the worker's readiness pass,
 * about once a minute (rapid/exec/ownership.ts). Switching "Allow shared account" on changes the
 * answer — but not until that pass has run again, and for that minute the panel went on printing the
 * refusal, telling the owner word for word to do the thing he had just done, with Automation still
 * locked. Nothing was wrong with the account; it read as "it didn't work".
 *
 * The lock itself is right and stays exactly as it was: Automation is armed on the worker's verdict,
 * never on a switch in a browser. Only the sentence changes while the panel waits for that verdict.
 *
 * "Within a minute" is a promise, so it is only made while the worker is actually looking: the refusal
 * on record carries the time it was written, and the worker rewrites it on every pass. If that time is
 * old — the broker session could not be renewed, or the worker is down — nothing is re-checking, and
 * the panel says that instead of promising a minute that will not come.
 *
 * Pure: safe in a client bundle.
 */

/** The two refusals "Allow shared account" answers. Both are worded in rapid/exec/ownership.ts. */
const SHARED_REFUSAL = /is also traded by|were not opened by Rapid/;

/** A verdict older than this was not written by a worker that is still looking at the account. */
export const RECHECK_FRESH_MS = 3 * 60_000;

export const RECHECKING =
  "Shared account allowed. Rapid is re-checking this account with the broker — Automation unlocks within a minute.";

/** Said when the verdict on record is old: nothing has looked at the account since `checkedAt`. */
export function recheckStalled(checkedAt: string | null | undefined): string {
  const t = checkedAt ? Date.parse(checkedAt) : NaN;
  const since = Number.isFinite(t) ? ` since ${new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
  return `Shared account allowed, but Rapid has not been able to re-check this account with the broker${since}. Automation stays locked until it has. If this does not clear, reconnect the broker account.`;
}

/** Everything that keeps Automation from being armed. "Automation is off" is the switch itself, not a reason. */
export function armBlockers(blockers: string[]): string[] {
  return blockers.filter((b) => !/automation is off/.test(b));
}

/**
 * The same list as the panel prints it. With a shared account allowed, a shared-account refusal that
 * is still on record is the previous verdict, not the current one, and is said as that: "re-checking"
 * while the worker is looking (`checkedAt` recent), "has not been able to re-check" when it is not.
 */
export function shownBlockers(blockers: string[], allowShared: boolean, checkedAt?: string | null, nowMs = Date.now()): string[] {
  const arm = armBlockers(blockers);
  if (!allowShared) return arm;
  const age = checkedAt ? nowMs - Date.parse(checkedAt) : NaN;
  const looking = Number.isFinite(age) && age <= RECHECK_FRESH_MS;
  return arm.map((b) => (SHARED_REFUSAL.test(b) ? (looking ? RECHECKING : recheckStalled(checkedAt)) : b));
}
