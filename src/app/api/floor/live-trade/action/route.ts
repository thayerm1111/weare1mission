import { createClient } from "@/lib/supabase/server";
import { runMemberAction, MEMBER_ACTIONS, type MemberAction } from "@/lib/flow/memberManage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** POST { action: "close" | "partial" | "breakeven" } — acts on the signed-in member's own open GENX gold trades. */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const supabase = createClient();
  if (!supabase) return json({ ok: false, error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  let body: { action?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body.action || "") as MemberAction;
  if (!MEMBER_ACTIONS.includes(action)) return json({ ok: false, error: "bad_action" }, 400);
  const r = await runMemberAction(user.id, action);
  return json(r, 200);
}
