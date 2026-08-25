import { createClient } from "@/lib/supabase/server";
import type { Role, Tier } from "@/lib/access";

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: Role;
  tier: Tier;
  status: "active" | "pending" | "suspended";
  username: string | null;
  phone: string | null;
  referred_by: string | null;
  access_expires_at: string | null;
}

/** True once a time-limited (promo) grant has lapsed. Members with no expiry are unlimited. */
export function accessExpired(accessExpiresAt: string | null | undefined): boolean {
  if (!accessExpiresAt) return false;
  const t = Date.parse(accessExpiresAt);
  return Number.isFinite(t) && t <= Date.now();
}

/**
 * Returns the current authenticated user's profile (server-side), or null.
 * A DB trigger creates a profile row automatically on first sign-in,
 * defaulting to role 'member', tier 'starter', status 'pending'.
 */
export async function getProfile(): Promise<Profile | null> {
  const supabase = createClient();
  if (!supabase) return null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, tier, status, username, phone, referred_by, access_expires_at")
    .eq("id", user.id)
    .single();

  if (data) {
    const p = data as Profile;
    // Time-limited (promo) access: once the grant lapses, treat the member as
    // suspended so the portal gate pauses them — no cron required, enforced on read.
    if (p.status === "active" && accessExpired(p.access_expires_at)) {
      return { ...p, status: "suspended" };
    }
    return p;
  }

  // Fallback if the profile row hasn't been created yet.
  return {
    id: user.id,
    email: user.email ?? null,
    full_name: (user.user_metadata?.full_name as string) ?? null,
    role: "member",
    tier: "starter",
    status: "active",
    username: null,
    phone: null,
    referred_by: null,
    access_expires_at: null,
  };
}
