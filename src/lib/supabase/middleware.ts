import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./config";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Refreshes the Supabase auth session and guards /portal.
 *
 * SPEED + RESILIENCE REWRITE (owner 09-10: "I need to speed up the site", after a
 * member hit 504 MIDDLEWARE_INVOCATION_TIMEOUT and login itself crawled):
 *   • NO-COOKIE SHORT-CIRCUIT — a visitor with no Supabase auth cookie gets an
 *     instant answer (public page renders / portal redirects to login) with ZERO
 *     network calls. Most traffic is anonymous, so most requests now skip the
 *     auth round-trip entirely.
 *   • 5s TIMEOUT GUARD — the auth refresh races a timeout, so a slow Supabase
 *     moment can never hang the middleware into a site-wide 504 again. On a
 *     timeout, public pages render normally and portal pages bounce to /login
 *     (never fail-open into the member area).
 */
export async function updateSession(
  request: NextRequest,
  // THE FLOOR (owner 09-10): the floor.weare1mission.com host serves the standalone
  // Floor app via a rewrite. `rewriteTo` makes this same session-refresh produce a
  // REWRITTEN response (the subdomain renders /floor-app while the URL stays clean),
  // and `protect` guards that rewritten page exactly like /portal is guarded.
  opts?: { rewriteTo?: string; protect?: boolean },
) {
  const buildResponse = () =>
    opts?.rewriteTo
      ? NextResponse.rewrite(new URL(opts.rewriteTo, request.url), { request })
      : NextResponse.next({ request });
  let response = buildResponse();

  if (!isSupabaseConfigured) return response;

  const path = request.nextUrl.pathname;
  const toLogin = () => {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", path);
    return NextResponse.redirect(url);
  };
  const guarded = path.startsWith("/portal") || opts?.protect === true;

  // NO-COOKIE SHORT-CIRCUIT: nothing to refresh, nothing to verify.
  const hasAuthCookie = request.cookies.getAll().some((c) => c.name.startsWith("sb-") && c.name.includes("-auth-token"));
  if (!hasAuthCookie) {
    if (guarded) return toLogin();
    return response;
  }

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = buildResponse();
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // TIMEOUT GUARD: a hung auth call must never 504 the whole site.
  let user: unknown = null;
  try {
    const result = await Promise.race([
      supabase.auth.getUser(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
    ]);
    if (result !== "timeout") user = (result as { data: { user: unknown } }).data.user;
  } catch { /* auth error → treated as signed-out below */ }

  if (guarded && !user) return toLogin();

  return response;
}
