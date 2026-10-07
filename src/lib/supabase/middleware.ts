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
 *   • TIMEOUT GUARD — the auth refresh races a timeout, so a slow Supabase
 *     moment can never hang the middleware into a site-wide 504 again.
 *
 * SIGNED OUT IS NOT THE SAME AS "COULD NOT TELL" (10-07). For three minutes one
 * network route between this middleware and the sign-in service timed out while
 * every other route was fine. The check came back empty, "empty" was read as
 * "signed out", and members who had just signed in — successfully — were sent
 * straight back to the login page, over and over. Now:
 *   • the sign-in service says there is no session  → guarded pages go to /login,
 *     as before;
 *   • the check timed out, or the service could not be reached or answered with a
 *     server error → we could not tell, so the request goes on to the page, and
 *     THE PAGE DECIDES. Every guarded page checks the sign-in itself on the server
 *     (portal/layout.tsx and floor-app/page.tsx both redirect to /login without
 *     a user), from the site's own region, so nothing in the member area is
 *     opened by this: the door is checked once more, by a route that works.
 */
/** What the sign-in check came back with. */
export type SessionCheck = "signed-in" | "signed-out" | "unknown";
type CheckResult = "timeout" | { data?: { user?: unknown } | null; error?: unknown } | null | undefined;
/**
 * Pure. "signed-out" only on a definite answer: no user and no error, or an error the sign-in
 * service itself gave (a 4xx — no session, a bad or expired token). Anything else — no answer in
 * time, a network failure (status 0), a 5xx, a reply that was not the service's at all (a gateway's
 * error page) — is "unknown".
 */
export function sessionCheckOf(result: CheckResult): SessionCheck {
  if (result === "timeout" || !result) return "unknown";
  if (result.data?.user) return "signed-in";
  const e = result.error as { status?: unknown } | null | undefined;
  if (!e) return "signed-out";
  return typeof e.status === "number" && e.status >= 400 && e.status < 500 ? "signed-out" : "unknown";
}
/** How long the middleware waits for the sign-in check. It normally takes about 30 ms. */
export const SESSION_CHECK_MS = 3000;

export async function updateSession(
  request: NextRequest,
  // THE FLOOR (owner 09-10): the floor.weare1mission.com host serves the standalone
  // Floor app via a rewrite. `rewriteTo` makes this same session-refresh produce a
  // REWRITTEN response (the subdomain renders /floor-app while the URL stays clean),
  // and `protect` guards that rewritten page exactly like /portal is guarded.
  opts?: { rewriteTo?: string; protect?: boolean },
) {
  const buildResponse = () => {
    if (!opts?.rewriteTo) return NextResponse.next({ request });
    // Clone keeps the QUERY STRING — the Floor's tool switch lives in ?view=, so a
    // rewrite that dropped it would snap every tool click back to the Floor home.
    const u = request.nextUrl.clone();
    u.pathname = opts.rewriteTo;
    return NextResponse.rewrite(u, { request });
  };
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
  let check: SessionCheck = "unknown";
  try {
    check = sessionCheckOf(await Promise.race([
      supabase.auth.getUser(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SESSION_CHECK_MS)),
    ]));
  } catch { /* the check itself failed: we could not tell */ }

  // Signed out for certain → the login page. Could not tell → the page checks for itself (see above).
  if (guarded && check === "signed-out") return toLogin();

  return response;
}
