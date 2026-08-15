import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { FANTASY_HTML_B64 } from "@/data/fantasyHtml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Private Fantasy Football Command Center — visible to ONE account only.
 *
 * - Server-side gated: the HTML is never sent to an unauthenticated or
 *   unauthorised visitor (the route returns 404, not a redirect, not an empty
 *   page). No CSS/JS hiding.
 * - Not linked anywhere (no nav entry, no sitemap) and marked noindex/nofollow.
 * - Lives OUTSIDE /portal on purpose, so unauthorised visitors get a clean 404
 *   instead of the /portal middleware's redirect-to-login.
 */
const OWNER_ID = "3b5e06e5-258c-4880-b1f2-d1623cbca100"; // Matthew's weare1mission auth uid
const OWNER_EMAIL = "thayerm1111@gmail.com";

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" },
  });
}

export async function GET(_req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return notFound();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return notFound();

  const allowed = user.id === OWNER_ID || (!!user.email && user.email.toLowerCase() === OWNER_EMAIL);
  if (!allowed) return notFound();

  const html = Buffer.from(FANTASY_HTML_B64, "base64").toString("utf-8");
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "referrer-policy": "no-referrer",
    },
  });
}
