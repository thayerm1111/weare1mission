import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Runs on every non-static request. Refreshes the Supabase session and
 * protects /portal routes. No-op until Supabase env vars are set.
 *
 * SUPABASE INTEGRATION POINT: route protection lives here.
 */
export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Skip Next internals and static files; run on everything else.
    "/((?!_next/static|_next/image|favicon.ico|images/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
