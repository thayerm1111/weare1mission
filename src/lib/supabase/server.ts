import { cookies, headers } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./config";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Server Supabase client (for Server Components, Route Handlers, Server Actions).
 * Returns null when Supabase isn't configured.
 *
 * Auth resolves from EITHER source, so every route works on both surfaces:
 *  - the web app sends an HTTP-only cookie session (unchanged), OR
 *  - the native app sends `Authorization: Bearer <access-token>` — it has no
 *    cookie jar. When that header is present we scope the client to the token so
 *    every cookie-only endpoint authenticates the app user too; without this the
 *    app 401s on any route that wasn't individually converted to authedContext.
 *
 * Web requests never carry an Authorization header, so their code path is
 * completely unchanged — the Bearer branch is inert for the website.
 */
export function createClient() {
  if (!isSupabaseConfigured) return null;

  const cookieStore = cookies();

  // Native-app Bearer token (if any). Read defensively — headers() can be
  // unavailable in some rendering contexts, in which case we fall back to cookies.
  let bearer = "";
  try {
    const auth = headers().get("authorization") || "";
    if (auth.startsWith("Bearer ")) bearer = auth.slice(7);
  } catch {
    // headers() not available here — cookie session only.
  }

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // called from a Server Component — safe to ignore; middleware refreshes.
        }
      },
    },
    // Only added for native-app requests; absent for the web (cookie) path.
    ...(bearer ? { global: { headers: { Authorization: `Bearer ${bearer}` } } } : {}),
  });
}
