import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Runs on every non-static request.
 *  1. App CORS: requests from the native/installed app's origin
 *     (capacitor://localhost on iOS, https://localhost on Android) call the API
 *     cross-origin, so they need permissive CORS headers + an OPTIONS preflight
 *     answer. This branch ONLY fires when the Origin is an app origin — every
 *     website request is completely unaffected and falls through to the
 *     original behaviour below.
 *  2. Redirects the former public pages (training/schedule/resources/leadership)
 *     into the member back office at /portal/*.
 *  3. Refreshes the Supabase session and protects /portal routes
 *     (see src/lib/supabase/middleware.ts).
 *
 * These four sections are now members-only. To make one public again, remove
 * it from MOVED_TO_PORTAL below and restore its link in src/data/navigation.ts.
 */
const MOVED_TO_PORTAL: Record<string, string> = {
  "/training": "/portal/training",
  "/schedule": "/portal/schedule",
  "/resources": "/portal/resources",
  "/leadership": "/portal/leadership",
  "/portal/live": "/portal/schedule", // Live Sessions merged into Schedule
};

// Native/installed-app origins that call the API cross-origin (no cookies).
const APP_ORIGINS = new Set([
  "capacitor://localhost",
  "https://localhost",
  "http://localhost",
]);
function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-credentials": "true",
  };
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // 1) App CORS — only for API calls coming from an app origin.
  const origin = request.headers.get("origin") ?? "";
  if (APP_ORIGINS.has(origin) && path.startsWith("/api/")) {
    if (request.method === "OPTIONS") {
      return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
    }
    const res = await updateSession(request);
    for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v);
    return res;
  }

  // 2) Redirect moved public pages into the portal.
  const dest = MOVED_TO_PORTAL[path];
  if (dest) {
    const url = request.nextUrl.clone();
    url.pathname = dest;
    return NextResponse.redirect(url);
  }

  // 3) Default: refresh session + protect /portal.
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Skip Next internals and static files; run on everything else.
    "/((?!_next/static|_next/image|favicon.ico|images/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
