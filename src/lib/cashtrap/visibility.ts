import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Is Cashtrap open to members? Only for the portal menu link (admins always see it; the page and API
 * check access themselves). Cached for a minute; the settings route refreshes it when visibility changes.
 */
export const CASHTRAP_VISIBILITY_TAG = "cashtrap-visibility";

export const cashtrapOpenToMembers = unstable_cache(
  async (): Promise<boolean> => {
    try {
      const db = createAdminClient();
      if (!db) return false;
      const r = await db.from("cashtrap_settings").select("visibility").eq("id", 1).maybeSingle();
      return (r.data as { visibility?: string } | null)?.visibility === "members";
    } catch {
      return false;
    }
  },
  ["cashtrap-open-to-members"],
  { revalidate: 60, tags: [CASHTRAP_VISIBILITY_TAG] },
);
