import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from "./config";
import { createClient } from "./server";

/**
 * A Supabase client scoped to a caller's access token, for requests that
 * authenticate with `Authorization: Bearer <token>` instead of cookies — i.e.
 * the native mobile app, which has no cookie jar. No cookie I/O happens here, so
 * this is completely separate from the cookie-based server client used by the
 * web app (that path is untouched). Returns null when Supabase isn't configured
 * or no token was supplied.
 */
export function bearerClient(token: string) {
  if (!isSupabaseConfigured || !token) return null;
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: { getAll() { return []; }, setAll() { /* no-op: token-scoped */ } },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** Extract the bearer token from a request's Authorization header. */
export function bearerFromReq(req: Request): string {
  const a = req.headers.get("authorization") || "";
  return a.startsWith("Bearer ") ? a.slice(7) : "";
}

/**
 * Resolve the authenticated user + a Supabase client for a route handler,
 * accepting EITHER the web's cookie session OR a native app's Bearer token.
 *
 * The cookie path is tried FIRST and is unchanged from before — if a cookie
 * session exists (every web request), this returns exactly the cookie client and
 * user the routes used previously. Only when there is no cookie user does it fall
 * back to the Bearer token. In production today all traffic is cookie-based, so
 * the Bearer branch is inert until the mobile app ships.
 *
 * `configured` mirrors the old `if (createClient())` guard: true when Supabase is
 * set up at all (so routes can 401 on a missing user vs. fail-open when unset).
 */
export async function authedContext(
  req: Request
): Promise<{ supabase: ReturnType<typeof createClient>; user: User | null; configured: boolean }> {
  const cookieClient = createClient();
  if (cookieClient) {
    const { data: { user } } = await cookieClient.auth.getUser();
    if (user) return { supabase: cookieClient, user, configured: true };
  }
  const b = bearerClient(bearerFromReq(req));
  if (b) {
    const { data: { user } } = await b.auth.getUser();
    if (user) return { supabase: b as unknown as ReturnType<typeof createClient>, user, configured: true };
  }
  return { supabase: cookieClient, user: null, configured: Boolean(cookieClient) };
}
