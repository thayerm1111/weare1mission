/**
 * THE THREE HORIZONS, PER ACCOUNT.
 *
 * A signal already carries the horizon it was found on — quick, intraday or swing — and until now
 * every account took all three whether the member wanted them or not. These are not variations in
 * aggression; they are different trades with different holding periods, different stop distances and
 * different overnight exposure, and a member running a small funded account has a legitimate reason
 * to want the fast ones and not the ones that sit through a session.
 *
 * SWING IS OFF BY DEFAULT, deliberately. It holds risk through sessions, through the daily break and
 * over the weekend gap that gold is known for. That is a decision somebody should make, not one they
 * discover they inherited.
 *
 * THE NAMES ARE THE MEMBER'S, THE VALUES ARE THE ENGINE'S. The interface says RAPID, NORMAL and
 * SWING because that is how the owner describes them; the signal says quick, intraday and swing. One
 * map, here, so the two vocabularies can never drift apart in a way that silently mis-filters a trade.
 */
import type { Mode } from "@/lib/genxCompute";

export type StyleKey = "quick" | "hold" | "swing";

/** What a member sees, and what it means. */
export const STYLE_LABELS: Record<StyleKey, { name: string; blurb: string }> = {
  quick: { name: "Rapid",  blurb: "In and out fast — the shortest holds, tightest stops, most trades." },
  hold:  { name: "Normal", blurb: "The everyday horizon — held through a session, wider stop, fewer trades." },
  swing: { name: "Swing",  blurb: "Held for days. Widest stops, overnight and weekend exposure, the fewest trades." },
};

/** The engine's word for a horizon → ours. `intraday` is the engine's name for the middle one. */
export function styleOfMode(mode: Mode | string | null | undefined): StyleKey {
  const m = String(mode ?? "").toLowerCase();
  if (m === "swing") return "swing";
  if (m === "intraday" || m === "hold") return "hold";
  return "quick";
}

export type StylePrefs = { quick: boolean; hold: boolean; swing: boolean };

/**
 * Read the flags off an account row, tolerating a row written before the columns existed.
 *
 * The fallback matters: an account that predates this feature must keep behaving exactly as it did,
 * which means the two shorter horizons on. Defaulting a missing column to `false` would silently stop
 * trading accounts that never asked to be stopped.
 */
export function stylePrefsOf(a: { styleQuick?: boolean | null; styleHold?: boolean | null; styleSwing?: boolean | null }): StylePrefs {
  return {
    quick: a.styleQuick !== false,
    hold: a.styleHold !== false,
    swing: a.styleSwing === true,
  };
}

/** Does this account want a trade found on this horizon? */
export function accountTakesStyle(a: { styleQuick?: boolean | null; styleHold?: boolean | null; styleSwing?: boolean | null }, mode: Mode | string | null | undefined): boolean {
  return stylePrefsOf(a)[styleOfMode(mode)];
}

/**
 * Drop the accounts that have this horizon switched off.
 *
 * Generic over the account shape so it can sit in the execution path without that path needing to
 * know anything about how the preference is stored.
 */
export function filterAccountsByStyle<T extends { styleQuick?: boolean | null; styleHold?: boolean | null; styleSwing?: boolean | null }>(
  accounts: T[], mode: Mode | string | null | undefined,
): T[] {
  return accounts.filter((a) => accountTakesStyle(a, mode));
}

/**
 * At least one horizon must stay on.
 *
 * An account with all three off is an account that is switched on and will never trade — which looks
 * like a broken system rather than a choice, and is the kind of state somebody reaches by accident
 * and then spends an evening debugging.
 */
export function normalisePrefs(p: Partial<StylePrefs>, current: StylePrefs): StylePrefs {
  const next = { quick: p.quick ?? current.quick, hold: p.hold ?? current.hold, swing: p.swing ?? current.swing };
  if (!next.quick && !next.hold && !next.swing) return current;
  return next;
}
