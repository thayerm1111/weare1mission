import type { SupabaseClient } from "@supabase/supabase-js";

type AccessDb = Pick<SupabaseClient, "rpc">;
type AccessAccount = { id: string; user_id: string; automation_enabled: boolean; automation_version: number };

/** Read current server-owned entitlement for every entry decision; never cache a paid flag. */
export async function hasNitrousAddonAccess(db: AccessDb, userId: string): Promise<boolean> {
  try {
    const result = await db.rpc("nitrous_has_addon_access", { p_user: userId });
    return !result.error && result.data === true;
  } catch { return false; }
}

/** Losing access pauses future entries. Restoring payment alone never rearms an account. */
export async function revokeNitrousAutomationWithoutAccess(db: AccessDb, acct: AccessAccount): Promise<boolean> {
  if (await hasNitrousAddonAccess(db, acct.user_id)) return true;
  if (acct.automation_enabled) {
    try {
      // The RPC checks current entitlement and the account version again before changing anything.
      await db.rpc("nitrous_pause_without_addon", {
        p_user: acct.user_id, p_account: acct.id, p_expected_version: acct.automation_version,
      });
    } catch { /* Missing database evidence still blocks a new order. Recovery runs on the next pass. */ }
  }
  return false;
}
