/**
 * THE RECORD RESET POINT — the clock every member-facing and public results number on the platform
 * counts from. Activity before it stays in the database; it is just not counted.
 *
 * Resets so far (each one asked for by the owner):
 *   2026-10-11T21:00:00Z  owner 10-11: "please reset all the stats on the platform". 5pm New York on
 *                         the Sunday, before the forex and gold reopen, so the record starts with the
 *                         first trade of the week. This one also brought every remaining results number
 *                         onto the clock: the /wins page, GEN FX's record and latest calls, Community
 *                         Results, the OM AI Plays header, ATLAS's own record, Matty Pips' stats and the
 *                         follower count. Not on it: admin tuning views (GenxLab, LearningDesk, xGhost,
 *                         community P&L), AURIC's P&L (an account's own money), XP and posted wins.
 *   2026-09-26T01:45:00Z  owner 09-25 (set on Vercel as FLOOR_STATS_SINCE)
 *   2026-09-25T01:50:00Z, 2026-09-20T22:00:00Z, 2026-09-16T18:55:00Z, and the original
 *                         "everything 0, start recording now".
 *
 * The clock is the LATER of two settings: DEFAULT_STATS_SINCE here and the env FLOOR_STATS_SINCE (an ISO
 * time on Vercel). Either can move the record forward — the env without a code deploy — and neither can
 * pull it back on its own: an env left at an older reset is simply outrun by a newer one in code. Moving
 * the record back (an undo) means changing both.
 *
 * Its own file, apart from lib/genx, so the Command Center — which may not import GENX code
 * (tests/cc-core.test.ts) — reads the same clock as everything else.
 */
export const DEFAULT_STATS_SINCE = "2026-10-11T21:00:00Z";

/** The reset point as an ISO time. */
export function statsSince(env: string | undefined = process.env.FLOOR_STATS_SINCE): string {
  const code = Date.parse(DEFAULT_STATS_SINCE);
  const v = env?.trim() ?? "";
  const fromEnv = v !== "" ? Date.parse(v) : NaN;
  return Number.isFinite(fromEnv) && fromEnv > code ? new Date(fromEnv).toISOString() : DEFAULT_STATS_SINCE;
}

/** The reset point in milliseconds. */
export function statsSinceMs(): number {
  return Date.parse(statsSince());
}

/** A rolling window ("the last 30 days") that never reaches back past the reset: the later of the two. */
export function windowStart(ms: number): number {
  return Math.max(ms, statsSinceMs());
}
