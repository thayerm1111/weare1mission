import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * THE RECORD RESET POINT lives in ../statsClock.ts (owner 10-11: "please reset all the stats on the
 * platform"), where every product — AURIC and the Command Center included — can read it. Every
 * member-facing results number counts only activity at or after it; data before it stays in the database.
 */
export { DEFAULT_STATS_SINCE, statsSince, statsSinceMs, windowStart } from "../statsClock";

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
