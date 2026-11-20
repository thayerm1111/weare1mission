import { type NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { SHELL_COOKIE } from "@/lib/floor/nav";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE REDESIGN PREVIEW SWITCH (owner 11-20: "Work in an isolated branch or preview. Keep the current
 * application functional").
 *
 *   /api/floor/preview?on=1   an ADMIN's browser starts seeing the new shell and The Floor
 *   /api/floor/preview?on=0   back to the classic portal
 *
 * It sets one cookie on the admin's own browser and changes nothing else — no setting, no member, no
 * trading switch. The cookie alone does nothing: the portal reads the role on the server every time
 * (nav.wantsNextShell), so a member who set it by hand would still get the classic portal. Anyone who is
 * not an admin is answered as if this address did not exist.
 */
export async function GET(req: NextRequest) {
  const profile = await getProfile();
  if (!profile || profile.role !== "admin") return new NextResponse("Not found", { status: 404 });
  const on = new URL(req.url).searchParams.get("on") !== "0";
  const res = NextResponse.redirect(new URL("/portal/trading", req.url), 303);
  if (on) res.cookies.set(SHELL_COOKIE, "next", { path: "/", httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 30 });
  else res.cookies.set(SHELL_COOKIE, "", { path: "/", httpOnly: true, sameSite: "lax", secure: true, maxAge: 0 });
  return res;
}
