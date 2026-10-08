/**
 * What the settings screens say about the three trade settings (manageSettings.ts). One place, so the site
 * and the phone app say the same thing — tests/flow-trade-settings-screens.test.ts checks the phone app
 * carries these lines word for word.
 */
import type { FollowMode, PartialPct } from "./manageSettings";

export const MGMT_TITLE = "How the AI looks after a trade";
export const MGMT_APPLIES = "Applies to trades already open too.";

export const BE_LABEL = "Break-even";
export function beLine(on: boolean, pips: number): string {
  return on
    ? `Gold: once a trade is ${pips} pips up, the stop moves into profit so it can't turn into a loss. EUR/USD and GBP/JPY: halfway to the target.`
    : "Off — the stop stays where the trade was placed.";
}

export const FOLLOW_LABEL = "Follow price";
export const FOLLOW_NAMES: Record<FollowMode, string> = { off: "Off", tight: "Tight", normal: "Normal", loose: "Loose" };
export const FOLLOW_LINES: Record<FollowMode, string> = {
  off: "Off — once break-even is set, the stop stays there until the target or the stop.",
  tight: "Tight — the stop stays close behind the best price. Keeps more of a move; a normal pullback can close the trade.",
  normal: "Normal — the stop follows with room to breathe and tightens near the target.",
  loose: "Loose — the most room: rides out pullbacks, gives back more if the move turns.",
};
export const FOLLOW_SNAP = "On gold it also snaps in when the market turns against a trade that's run 50+ pips.";
export const FOLLOW_NEEDS_BE = "Needs break-even on — the stop only follows a trade that's already protected.";
export function followLine(mode: FollowMode, breakEvenOn: boolean): string {
  if (!breakEvenOn) return FOLLOW_NEEDS_BE;
  return mode === "off" ? FOLLOW_LINES.off : `${FOLLOW_LINES[mode]} ${FOLLOW_SNAP}`;
}

export const PARTIALS_LABEL = "Partials";
export const PARTIAL_LINES: Record<PartialPct, string> = {
  0: "Off — the whole trade rides to its target or stop.",
  25: "Banks 25% of the trade halfway to its target; the rest rides on. A trade under 0.04 lots can't be split and rides whole.",
  50: "Banks half the trade halfway to its target; the rest rides on. A trade under 0.02 lots can't be split and rides whole.",
};

/** When the account's settings could not be read just now: the buttons wait rather than show a guess. */
export const MGMT_UNREAD = "Couldn't read this account's trade settings just now — tap Re-check.";

/** A short summary for a card that has no room for the settings themselves. */
export function mgmtSummary(o: { beEnabled?: boolean; breakEvenPips?: number; followPrice?: FollowMode; followActive?: boolean; partialPct?: number; settingsUnread?: boolean }): string {
  if (o.settingsUnread) return "Trade settings unavailable";
  const parts: string[] = [];
  parts.push(o.beEnabled === false ? "Break-even off" : `Break-even ${o.breakEvenPips ?? 30}`);
  if (o.followActive !== false && o.beEnabled !== false && o.followPrice && o.followPrice !== "off") parts.push(`Follow ${FOLLOW_NAMES[o.followPrice].toLowerCase()}`);
  if (o.partialPct === 25 || o.partialPct === 50) parts.push(`Bank ${o.partialPct}%`);
  return parts.join(" · ");
}
