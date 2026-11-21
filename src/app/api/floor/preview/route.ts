import { type NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { SHELL_COOKIE } from "@/lib/floor/nav";
import { landingPath } from "@/lib/floor/app";

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
 *
 * `&to=` (a path on this site, nothing else) is where to land afterwards: the installed app uses it to turn the
 * preview on and come straight back to the screen it was opened on (lib/floor/app.ts, APP_RETURN_SCRIPT).
 */
export async function GET(req: NextRequest) {
  const profile = await getProfile();
  if (!profile || profile.role !== "admin") return new NextResponse("Not found", { status: 404 });
  const q = new URL(req.url).searchParams;
  const on = q.get("on") !== "0";
  const res = NextResponse.redirect(new URL((on && landingPath(q.get("to"))) || "/portal/trading", req.url), 303);
  if (on) res.cookies.set(SHELL_COOKIE, "next", { path: "/", httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 30 });
  else res.cookies.set(SHELL_COOKIE, "", { path: "/", httpOnly: true, sameSite: "lax", secure: true, maxAge: 0 });
  return res;
}
