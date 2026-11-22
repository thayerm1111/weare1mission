import { authedContext } from "@/lib/supabase/bearer";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { CREDIT_COST } from "@/lib/creditConfig";
import { atlasMessages } from "@/lib/atlas/actions";
import { answerAtlasApp, atlasContext, atlasHelpReply } from "@/lib/atlas/brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function POST(req: Request) {
  const { supabase, user, configured } = await authedContext(req);
  if (!configured || !supabase) return json({ error: "not_configured", reason: "Atlas is not connected right now." }, 503);
  if (!user) return json({ error: "unauthorized", reason: "Sign in to talk to Atlas." }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request", reason: "Send a question for Atlas." }, 400); }
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 2000) : "";
  if (!message) return json({ error: "empty", reason: "Send a question for Atlas." }, 400);
  const history = atlasMessages(body.history), context = atlasContext(body.context);
  const help = atlasHelpReply(message, history, context);
  if (help) return json(help);
  const gate = await gateCredits("chat", supabase);
  if (!gate.ok) return json({ error: gate.reason === "unauthorized" ? "unauthorized" : "insufficient_credits", reason: gate.reason === "unauthorized" ? "Sign in again to continue." : `This AI answer needs ${CREDIT_COST.chat} credit. Product help is still free.` }, gate.reason === "unauthorized" ? 401 : 402);
  const answer = await answerAtlasApp({ userId: user.id, message, history, context, mode: "chat" });
  if (!answer.ok) return json({ error: answer.error, reason: answer.reason }, 503);
  if (answer.usedModel) await chargeCredit("chat", supabase);
  return json({ reply: answer.reply, actions: answer.actions });
}
