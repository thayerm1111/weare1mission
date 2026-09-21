import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/supabase/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * APP → WEBSITE SESSION BRIDGE.
 *
 * The app keeps its session as tokens (it has no cookie jar of its own on some devices); the website
 * reads an HTTP-only cookie. So the app can show the real website Command Center inside itself —
 * identical, and never drifting out of date again — it hands its own tokens here once and the
 * server writes the same member's cookie session on this origin.
 *
 * Nothing new is granted: the tokens are already this member's, Supabase verifies them in
 * setSession, and the cookie is scoped to this site. Same-origin only, so no other site can use
 * this to sign a visitor in as someone else.
 */
type CookieToSet = { name: string; value: string; options?: CookieOptions };

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured) return json({ ok: false, error: "not_configured" }, 503);
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return json({ ok: false, error: "same_origin_only" }, 403);

  let body: { access_token?: string; refresh_token?: string } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
  if (!body.access_token || !body.refresh_token) return json({ ok: false, error: "missing_tokens" }, 400);

  const store = cookies();
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list: CookieToSet[]) => { list.forEach(({ name, value, options }) => store.set(name, value, options)); },
    },
  });
  const { data, error } = await supabase.auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token });
  if (error || !data.user) return json({ ok: false, error: "invalid_session" }, 401);
  return json({ ok: true });
}
