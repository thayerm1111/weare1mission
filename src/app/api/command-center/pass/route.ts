import { createClient } from "@/lib/supabase/server";
import { randomBytes } from "crypto";
import { claimPreview, openPass, passState } from "@/lib/ccPass";

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

export async function POST(req: Request) {
  const w = await who();
  if (!w) return json({ error: "unauthorized" }, 401);
  // ?preview=1 — the one free look at the entrance. Charges nothing; works once per member.
  if (new URL(req.url).searchParams.get("preview") === "1") {
    const ok = await claimPreview(w.user.id, randomBytes(16).toString("hex"));
    return json({ ok, preview: ok }, ok ? 200 : 409);
  }
  const r = await openPass(w.user.id, w.supabase);
  return json(r, r.error === "insufficient" ? 402 : 200);
}
