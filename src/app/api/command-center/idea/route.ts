import { createClient } from "@/lib/supabase/server";
import { hasPass } from "@/lib/ccPass";
import { generateIdea, followStoredIdea, listIdeas, watchIdea } from "../../../../../command-center/engines/ideaDesk";
import { ideaText } from "../../../../../command-center/engines/idea";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GENERATE WITH ATLAS (owner 11-11).
 *
 * One press, one answer: which way, where to enter, where the stop goes, where it is aiming, why, and what
 * would make it wrong — from ATLAS's own engine (command-center/engines/idea.ts), never from a model.
 *
 *   GET                         the member's recent ideas and their record
 *   POST { action: "generate", options? }   a new idea from the market as it stands
 *   POST { action: "follow", id }           where a stored idea stands now, and how it has done on real candles
 *   POST { action: "watch", id }            have ATLAS tell the member when that idea's entry is reached
 *
 * THIS ROUTE CANNOT TRADE. It never calls the executor and never reaches a broker. Taking an idea is done
 * through /api/command-center/trade, with that route's own validation, risk-disclosure consent and
 * idempotency — unchanged. The only thing this route can arm is an informational watch.
 *
 * Access is the same as talking to ATLAS: signed in, with an open Command Center pass (5 credits per 30
 * minutes). Generating costs nothing extra.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function member() {
  const supabase = createClient();
  if (!supabase) return { error: json({ ok: false, error: "not_configured" }, 503) };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: json({ ok: false, error: "unauthorized" }, 401) };
  if (!(await hasPass(user.id))) return { error: json({ ok: false, error: "pass_required" }, 402) };
  return { user };
}

export async function GET() {
  const m = await member();
  if (m.error) return m.error;
  try {
    return json({ ok: true, ...(await listIdeas(m.user.id, 10)) });
  } catch (e) {
    return json({ ok: false, error: "list_failed", detail: e instanceof Error ? e.message.slice(0, 160) : "unknown" }, 500);
  }
}

export async function POST(req: Request) {
  const m = await member();
  if (m.error) return m.error;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
  const action = String(body.action ?? "generate");

  try {
    if (action === "generate") {
      const g = await generateIdea(m.user.id, body.options);
      return json({ ok: true, ...g, copy: ideaText(g.idea) });
    }
    if (action === "follow") {
      const r = await followStoredIdea(m.user.id, String(body.id ?? ""));
      if (!r) return json({ ok: false, error: "not_found", message: "I couldn't find that idea." }, 404);
      return json({ ok: true, idea: r.row.idea, update: r.update, copy: ideaText(r.row.idea) });
    }
    if (action === "watch") {
      const r = await watchIdea(m.user.id, String(body.id ?? ""));
      return json(r, r.ok ? 200 : 400);
    }
    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: "idea_failed", detail: e instanceof Error ? e.message.slice(0, 160) : "unknown" }, 500);
  }
}
