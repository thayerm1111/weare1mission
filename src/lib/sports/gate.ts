import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Server-side authorization for the entire OM Sports AI feature.
 *
 * Access requires an authenticated Supabase session that is EITHER:
 *   - the owner account (id/email match), OR
 *   - a profile with role = 'admin'.
 * Everyone else is denied. This runs on the server for every page + API call;
 * the feature is never merely CSS-hidden. Unauthorized => the caller returns 404
 * (page) or 401 (API) so customers get no indication the feature exists.
 */
export const OWNER_ID = "3b5e06e5-258c-4880-b1f2-d1623cbca100";
export const OWNER_EMAIL = "thayerm1111@gmail.com";

export type Gate =
  | { ok: true; userId: string; email: string | null }
  | { ok: false };

export async function gateAdmin(): Promise<Gate> {
  const supabase = createClient();
  if (!supabase) return { ok: false };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  const email = user.email ? user.email.toLowerCase() : null;
  if (user.id === OWNER_ID || email === OWNER_EMAIL) {
    return { ok: true, userId: user.id, email };
  }
  // Otherwise require role = 'admin' on the profile.
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.role === "admin") return { ok: true, userId: user.id, email };
  return { ok: false };
}

/**
 * Service-role client for reading/writing the admin-only sports_* tables from a
 * gated route. Safe because the route is already gated to owner/admin above.
 */
export function sportsDb() {
  return createAdminClient();
}
