import type { SupabaseClient } from "@supabase/supabase-js";

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

/**
 * A MEMBER'S OWN RESET POINT (owner 09-29: "reset these stats — I need to reconnect new accounts and I
 * want fresh stats"). FLOOR_STATS_SINCE above is the community's clock; moving it wipes everybody's
 * record. A member starting over on new accounts needs their OWN clock, kept in
 * flow_trade_prefs.stats_since: their member-facing results (the Live Trade card's last three,
 * streak and record; the owner's private results view) count only fills at or after it. The desk
 * record and the GENX results card never read it. Null (or unreadable) means no personal reset.
 */
export async function memberStatsSince(admin: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data } = await admin.from("flow_trade_prefs").select("stats_since").eq("user_id", userId).maybeSingle();
    const v = (data as { stats_since?: string | null } | null)?.stats_since;
    return v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
  } catch { return null; }
}

/** The later of the community clock and the member's own. Pure, so the rule is testable. */
export function effectiveSince(community: string, member: string | null): string {
  if (!member) return community;
  return Date.parse(member) > Date.parse(community) ? member : community;
}
