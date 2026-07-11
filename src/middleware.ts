import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Runs on every non-static request.
 *  1. Redirects the former public pages (training/schedule/resources/leadership)
 *     into the member back office at /portal/*.
 *  2. Refreshes the Supabase session and protects /portal routes
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

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const dest = MOVED_TO_PORTAL[path];
  if (dest) {
    const url = request.nextUrl.clone();
    url.pathname = dest;
    return NextResponse.redirect(url);
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Skip Next internals and static files; run on everything else.
    "/((?!_next/static|_next/image|favicon.ico|images/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
