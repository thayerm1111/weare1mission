import { authedContext } from "@/lib/supabase/bearer";
import { actOnActiveTrade } from "@/lib/floor/activeTrades";
import { parseTradeAction } from "@/lib/floor/activeTradeModel";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
export async function POST(req: Request) {
  // Browser mutations are same-origin. Native clients without an Origin use the existing authenticated bearer path.
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin || req.headers.get("sec-fetch-site") === "cross-site") return json({ ok: false, state: "refused", message: "Open this action from the app." }, 403);
  const { user, configured } = await authedContext(req);
  if (!configured) return json({ ok: false, state: "refused", message: "Trading is unavailable right now." }, 503);
  if (!user) return json({ ok: false, state: "refused", message: "Sign in before managing a trade." }, 401);
  const input = await req.json().catch(() => null), action = parseTradeAction(input);
  if (!action) return json({ ok: false, state: "refused", message: "Review and confirm one current position first." }, 400);
  const answer = await actOnActiveTrade(user.id, action);
  return json(answer.body, answer.status);
}
