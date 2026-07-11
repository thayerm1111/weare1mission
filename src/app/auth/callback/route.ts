import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Magic-link callback. Supabase redirects here with a `code` after the user
 * clicks their email link; we exchange it for a session cookie, then send them
 * on to the portal (or their original destination).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const redirect = searchParams.get("redirect") || "/portal";

  if (code) {
    const supabase = createClient();
    if (supabase) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(`${origin}${redirect}`);
    }
  }
  // Something went wrong — back to login with a flag.
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
