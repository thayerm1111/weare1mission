import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side Sleeper relay for the private Fantasy command center.
 * Same one-account gate as the page. Sleeper's API is public and read-only —
 * this relay exists only to dodge CORS/network filtering, not for credentials.
 *
 * SSRF guard: forwards ONLY to https://api.sleeper.app/* — anything else is 400.
 */
const OWNER_ID = "3b5e06e5-258c-4880-b1f2-d1623cbca100";
const OWNER_EMAIL = "thayerm1111@gmail.com";

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

export async function GET(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "unauthorized" }, 401);

  const { data: { user } } = await supabase.auth.getUser();
  const allowed = !!user && (user.id === OWNER_ID || (!!user.email && user.email.toLowerCase() === OWNER_EMAIL));
  if (!allowed) return json({ error: "unauthorized" }, 401);

  const target = req.nextUrl.searchParams.get("url") || "";
  let u: URL;
  try { u = new URL(target); } catch { return json({ error: "bad_url" }, 400); }
  if (u.protocol !== "https:" || u.hostname !== "api.sleeper.app") {
    return json({ error: "forbidden_url" }, 400);
  }

  try {
    const r = await fetch(u.toString(), { headers: { accept: "application/json" }, cache: "no-store" });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: {
        "content-type": r.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  } catch {
    return json({ error: "relay_failed" }, 502);
  }
}
