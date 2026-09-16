/**
 * THE RECORD RESET POINT (owner 09-16: "completely restart over — everything 0 — start
 * recording now"). Every member-facing results number counts only activity at or after
 * this time. Data before it stays in the database; it just isn't counted. Env
 * FLOOR_STATS_SINCE (ISO time) moves the reset without a code deploy.
 */
export const DEFAULT_STATS_SINCE = "2026-09-16T01:57:00Z";
export function statsSince(): string {
  const v = process.env.FLOOR_STATS_SINCE;
  return v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : DEFAULT_STATS_SINCE;
}
