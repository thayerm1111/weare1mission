/**
 * SWING TRADES NEED A REAL ACCOUNT BEHIND THEM (owner 09-24: "On smaller accounts don't let them take
 * swing trades the stops are too high. It's too big of a % of their accounts").
 *
 * A swing stop is structural and wide — the median GENX swing stop over the last two weeks was 695
 * pips, against 167 for intraday and 83 for quick. Gold's minimum lot is 0.01, which is one ounce, so
 * the SMALLEST swing position anyone can take still risks about $69.50. There is no sizing-down past
 * that: risk % cannot help an account whose whole risk budget is smaller than one minimum lot's loss.
 *
 * That lands hardest on exactly the members least able to take it. At the median armed balance of
 * $1,000 a single swing trade was ~7% of the account, and 98 of 233 armed accounts were carrying more
 * than 10% of their balance on one trade.
 *
 * So swing entries are floored on ACCOUNT SIZE rather than on risk arithmetic: below the floor the
 * account sits the trade out. Quick and intraday are untouched — their stops are small enough that
 * ordinary risk sizing still works.
 *
 * The floor is a judgement call, not a formula (owner set $1,500), so it is env-tunable without a
 * deploy. At $1,500 a median swing stop is ~4.6% of the account at minimum lot.
 */

/** Below this account size, no swing entries. Owner 09-24. */
export const SWING_MIN_BALANCE = Number(process.env.GENX_SWING_MIN_BALANCE ?? 1500);

/** Is this signal a swing? Only swing is floored; quick and intraday size down fine. */
export function isSwingMode(mode: unknown): boolean {
  return String(mode ?? "").trim().toLowerCase() === "swing";
}

/**
 * The account size to judge against the floor. Live equity when the broker returned it (that is the
 * money actually behind the trade right now), otherwise the stored balance. Null when neither is known.
 */
export function accountSize(a: { equity?: number | null; balance?: number | null }): number | null {
  const e = Number(a.equity);
  if (Number.isFinite(e) && e > 0) return e;
  const b = Number(a.balance);
  if (Number.isFinite(b) && b > 0) return b;
  return null;
}

/**
 * May this account take a swing entry?
 *
 * An account whose size cannot be read is REFUSED for swing. This is the one place the desk fails
 * closed on a missing read rather than open: the downside of a wrong "yes" is a member risking a
 * double-digit percentage of their account on a single trade, and the downside of a wrong "no" is one
 * missed swing entry. Quick and intraday are never blocked by this, so an unreadable balance can
 * never stand the account down entirely.
 */
export function swingAllowed(
  a: { equity?: number | null; balance?: number | null },
  mode: unknown,
  floor = SWING_MIN_BALANCE,
): boolean {
  if (!isSwingMode(mode)) return true;
  const size = accountSize(a);
  if (size == null) return false;
  return size >= floor;
}

/** Split accounts into those that may take this swing and those too small. Pure. */
export function partitionBySwingFloor<T extends { equity?: number | null; balance?: number | null }>(
  accounts: T[],
  mode: unknown,
  floor = SWING_MIN_BALANCE,
): { allowed: T[]; tooSmall: T[] } {
  if (!isSwingMode(mode)) return { allowed: accounts, tooSmall: [] };
  const allowed: T[] = [], tooSmall: T[] = [];
  for (const a of accounts) (swingAllowed(a, mode, floor) ? allowed : tooSmall).push(a);
  return { allowed, tooSmall };
}
