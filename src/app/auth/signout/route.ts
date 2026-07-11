import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Signs the member out and returns to the homepage. */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  if (supabase) await supabase.auth.signOut();
  return NextResponse.redirect(`${new URL(request.url).origin}/`, { status: 303 });
}
