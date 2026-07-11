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
    .select("id, email, full_name, role, tier, status, username, phone, referred_by")
    .eq("id", user.id)
    .single();

  if (data) return data as Profile;

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
  };
}
