import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "./config";

/**
 * Service-role Supabase client — bypasses RLS. ONLY for trusted server code
 * with no user session, e.g. the Stripe webhook crediting a member's balance
 * after a verified purchase. Never import this into client code. Returns null
 * if the service-role key isn't configured.
 */
export function createAdminClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !serviceKey) return null;
  return createClient(SUPABASE_URL, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
