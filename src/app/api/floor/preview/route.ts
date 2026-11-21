import { type NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { CLASSIC_SHELL, SHELL_COOKIE } from "@/lib/floor/nav";
import { landingPath } from "@/lib/floor/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AN ADMIN'S CLASSIC-PORTAL SWITCH. The new design was a preview (owner 11-20) and is everyone's since 11-21
 * ("push live to everyone"); this switch is kept for support:
 *
 *   /api/floor/preview?on=0   an ADMIN's browser goes back to the classic portal ("Classic portal" in the menu)
 *   /api/floor/preview?on=1   and comes back to the new design
 *
 * It sets one cookie on the admin's own browser and changes nothing else — no setting, no member, no
 * trading switch. The cookie alone does nothing: the portal reads the role on the server every time
 * (nav.wantsNextShell), so a member who set it by hand would still get the new design. Anyone who is
 * not an admin is answered as if this address did not exist.
 *
 * `&to=` (a path on this site, nothing else) is where to land afterwards when coming back to the new design.
 */
export async function GET(req: NextRequest) {
  const profile = await getProfile();
  if (!profile || profile.role !== "admin") return new NextResponse("Not found", { status: 404 });
  const q = new URL(req.url).searchParams;
  const on = q.get("on") !== "0";
  const res = NextResponse.redirect(new URL((on && landingPath(q.get("to"))) || "/portal/trading", req.url), 303);
  // Since the new design went to everyone (owner 11-21), "on" is the default and "off" is an admin's own choice of the
  // classic portal, for support: on=0 keeps that choice for 30 days; on=1 forgets it.
  if (on) res.cookies.set(SHELL_COOKIE, "", { path: "/", httpOnly: true, sameSite: "lax", secure: true, maxAge: 0 });
  else res.cookies.set(SHELL_COOKIE, CLASSIC_SHELL, { path: "/", httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 30 });
  return res;
}
