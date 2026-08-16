import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Fantasy AI General Manager — the "brain" behind the Command Center.
 * Server-side Anthropic call so NO API key ever sits in the browser. Gated to
 * the one owner account (same gate as the page). Given the live team context the
 * app assembles (roster, week, matchup, waiver signal, byes), it returns a
 * decisive weekly plan: optimal lineup, start/sit, adds/drops, and the actions
 * to tap in Sleeper.
 *
 * NOTE on execution: Sleeper's API is read-only, so the GM decides everything
 * and the user taps to execute. The system prompt tells it to end with the exact
 * tap-to-do actions.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";
const OWNER_ID = "3b5e06e5-258c-4880-b1f2-d1623cbca100";
const OWNER_EMAIL = "thayerm1111@gmail.com";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}

const SYSTEM = `You are Matthew's fantasy football General Manager for the 2026 season. You run his team like a sharp, decisive GM — no hedging, no "it depends," no long disclaimers.

HIS LEAGUE (fixed facts — trust these over any assumption):
- League: Arbor Ridge Tier 3, 12 teams, snake draft, he drafted from slot #2.
- Starting lineup: 1 QB, 2 RB, 2 WR, 1 TE, 2 FLEX (RB/WR/TE), 1 K, 1 DEF. Bench 5, IR 1.
- Scoring is NON-STANDARD: 0.5 PPR (half point per reception), 6-point passing TDs, -2 per INT. Kickers score by distance (longer FGs worth more); DEF scores on BOTH points and yards allowed with negative floors for bad games.
- Playoffs: 6 teams, start Week 15. Trade deadline: end of Week 11. Waivers clear Wednesday 2:00 AM CT (2-day process).

HOW YOU ANSWER:
- LINEUP: output the exact 9 starters by slot (QB / RB / RB / WR / WR / TE / FLEX / FLEX / K / DEF), then bench. Call out only the 1-2 closest decisions. Flag anyone on bye or injured — never start them.
- WAIVERS / FREE AGENTS: give a ranked list of adds, each paired with the exact player to DROP, and a waiver-priority order. Prioritize players who just inherited a starting role (injury/depth-chart movers).
- TRADES: say accept / decline / counter, and if counter give the exact offer. Remember the Week 11 deadline.
- Ground every call in the roster and live data provided in the message. If live data (current week, opponent, injuries, trending adds) is included, use it. If something isn't provided, reason from the roster and say what you'd confirm.
- 6-pt passing TDs make elite QBs more valuable than in most leagues; half-PPR slightly favors target-earners; the negative K/DEF floors make streaming the matchup matter.

EXECUTION REALITY: You cannot submit moves into Sleeper yourself (its API is read-only). So ALWAYS end your answer with a short "DO THIS IN SLEEPER" checklist — the exact taps Matthew should make (set these starters; drop X add Y on waivers; etc.). Keep it tight and copy-ready.`;

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 500);
  const { data: { user } } = await supabase.auth.getUser();
  const allowed = !!user && (user.id === OWNER_ID || (!!user.email && user.email.toLowerCase() === OWNER_EMAIL));
  if (!allowed) return json({ error: "unauthorized" }, 401);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ notConfigured: true }, 200);

  let body: { prompt?: unknown; messages?: unknown } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  // Accept either a single prompt string (the app builds a rich one) or a messages array.
  let messages: { role: "user" | "assistant"; content: string }[] = [];
  if (Array.isArray(body.messages)) {
    messages = (body.messages as { role: "user" | "assistant"; content: string }[])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-12)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 12000) }));
  } else if (typeof body.prompt === "string" && body.prompt.trim()) {
    messages = [{ role: "user", content: body.prompt.slice(0, 12000) }];
  }
  if (!messages.length) return json({ error: "no_prompt" }, 400);

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1800, system: SYSTEM, messages }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: "ai_error", detail: (j?.error?.message || "").slice(0, 300) }, 502);
    const text = Array.isArray(j?.content)
      ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("").trim()
      : "";
    return json({ ok: true, reply: text || "I couldn't produce a plan — try again." }, 200);
  } catch (e) {
    return json({ error: "server_error", detail: String(e).slice(0, 200) }, 500);
  }
}
