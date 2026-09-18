/**
 * THE RECORD RESET POINT (owner 09-18: "reset all stats on the floor, I want to start next week with all new
 * stats"). Set to the Sunday reopen — 6:00pm New York on 2026-09-20 — so the record starts clean with the
 * first trade of the new week. Until then every member-facing total reads zero.
 *
 * Every member-facing results number counts only activity at or after this time. Data before it stays in the
 * database; it just isn't counted. Env FLOOR_STATS_SINCE (ISO time) moves the reset without a code deploy.
 * Previous reset points: 2026-09-16T18:55:00Z, and the original "everything 0, start recording now".
 */
export const DEFAULT_STATS_SINCE = "2026-09-20T22:00:00Z";
export function statsSince(): string {
  const v = process.env.FLOOR_STATS_SINCE;
  return v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : DEFAULT_STATS_SINCE;
}
