import { gateAdmin } from "@/lib/sports/gate";
import { SPORTS_AI_HTML_B64 } from "@/data/sportsAiHtml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OM SPORTS AI — ADMIN COMMAND CENTER (private).
 *
 * Server-side gated to owner/admin ONLY. Unauthorized (including anonymous)
 * gets a real 404 — no redirect, no hint the feature exists. noindex + no-store
 * so it never lands in search or a sitemap. The page is raw HTML served from a
 * base64 module (bypasses layouts/nav) so nothing about this leaks into the
 * customer app. All data/AI/tracking happens through the sibling gated routes.
 */
function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store",
    },
  });
}

export async function GET() {
  const gate = await gateAdmin();
  if (!gate.ok) return notFound();
  const html = Buffer.from(SPORTS_AI_HTML_B64, "base64").toString("utf-8");
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
