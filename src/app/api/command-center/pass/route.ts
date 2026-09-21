import { createClient } from "@/lib/supabase/server";
import { openPass, passState } from "@/lib/ccPass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: is my Command Center window open? POST: open one (5 credits, 30 minutes). */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function who() {
  const supabase = createClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user ? { supabase, user } : null;
}

export async function GET() {
  const w = await who();
  if (!w) return json({ error: "unauthorized" }, 401);
  return json(await passState(w.user.id, w.supabase));
}

export async function POST() {
  const w = await who();
  if (!w) return json({ error: "unauthorized" }, 401);
  const r = await openPass(w.user.id, w.supabase);
  return json(r, r.error === "insufficient" ? 402 : 200);
}
