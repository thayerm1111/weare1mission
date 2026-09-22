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
/** What styleOfMode returns when the caller stated no horizon at all. */
export type StyleMatch = StyleKey | "unknown";

/** What a member sees, and what it means. */
export const STYLE_LABELS: Record<StyleKey, { name: string; blurb: string }> = {
  quick: { name: "Rapid",  blurb: "In and out fast — the shortest holds, tightest stops, most trades." },
  hold:  { name: "Normal", blurb: "The everyday horizon — held through a session, wider stop, fewer trades." },
  swing: { name: "Swing",  blurb: "Held for days. Widest stops, overnight and weekend exposure, the fewest trades." },
};

/** The engine's word for a horizon → ours. `intraday` is the engine's name for the middle one. */
export function styleOfMode(mode: Mode | string | null | undefined): StyleMatch {
  const m = String(mode ?? "").toLowerCase();
  if (m === "swing") return "swing";
  if (m === "intraday" || m === "hold") return "hold";
  if (m === "quick" || m === "scalp" || m === "rapid") return "quick";
  return "unknown";
}

export type StylePrefs = { quick: boolean; hold: boolean; swing: boolean };

/**
 * A horizon the caller did not state.
 *
 * This used to collapse to "quick", which meant a signal carrying no horizon was silently treated as
 * a scalp — so every account with Rapid switched off was dropped from every gold trade, and Normal
 * and Swing decided nothing. Filtering people out of a trade on a guess is worse than not filtering:
 * an unknown horizon now matches any account that still takes something.
 */

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
  const prefs = stylePrefsOf(a);
  const key = styleOfMode(mode);
  // An unstated horizon cannot be used to exclude anybody — it is missing information about the
  // SIGNAL, and taking it out on the member's account would silently cancel trades they asked for.
  if (key === "unknown") return prefs.quick || prefs.hold || prefs.swing;
  return prefs[key];
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
  // STRAIGHT GENX (owner 09-21: "I don't want the scalp or the swing. I just want the straight GENX how
  // it used to be"). The per-account Rapid / Normal / Swing switches no longer stand anybody down: every
  // account that takes GENX takes every GENX call, as it did before 09-20. GENX_TRADE_STYLES=on restores
  // the filter.
  // With all three horizons trading again (owner 09-21), each member's Quick / Intraday / Swing switches
  // decide which they take — swing stays opt-in because it holds through sessions and the weekend gap.
  // GENX_TRADE_STYLES=off makes every account take every horizon.
  /*
   * 09-22 (owner: "I don't want quick hold or swing toggles … I want GenX and Atlas to take the trades
   * they need to take without limits"). The three horizon switches no longer stand anybody down: every
   * account that takes GENX takes every GENX call, whichever horizon found it. The rule and its tests
   * stay here, and GENX_TRADE_STYLES=on re-arms them.
   */
  if ((process.env.GENX_TRADE_STYLES ?? "off").toLowerCase() !== "on") return accounts;
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
