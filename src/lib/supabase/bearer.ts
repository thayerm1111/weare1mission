import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from "./config";

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
