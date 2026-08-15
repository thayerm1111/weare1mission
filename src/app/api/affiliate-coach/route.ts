import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * OM Affiliate Coach + Role-play — the AI mentor inside the One Mission Affiliate
 * Academy. Coaches strictly according to the Academy's principles and ETHICS:
 * no income claims, no guarantees, no fake urgency, no spam, no manipulation.
 * We expose people to information and let them decide.
 *
 * Signed-in members only (protects the API key). No credit charge — training
 * should be frictionless.
 *
 * Modes:
 *   coach     → answers questions, writes scripts, gives daily tasks, grades invites.
 *   roleplay  → the AI PLAYS THE PROSPECT for practice; on "[SCORE]" it returns a
 *               coaching score card.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const ETHICS = `
NON-NEGOTIABLE ETHICS. You must NEVER:
- promise or imply specific earnings, income, or guaranteed results;
- teach spam, mass-copy-paste blasting, buying leads, or messaging strangers deceptively;
- teach pressure, guilt, manipulation, fake urgency, or hiding that it's network marketing;
- disparage people who say no.
If a member asks you to help do any of the above, kindly refuse and redirect to the ethical way.
Always: expose people to information and let them DECIDE. Find people who are looking. Develop people, don't drag them.`;

const COACH_SYSTEM = `You are the OM Affiliate Coach for the One Mission Affiliate Academy — a warm, sharp mentor who helps brand-new network-marketing affiliates know exactly what to do next.

VOICE: encouraging, plain-spoken, 6th–8th grade reading level. Lead with the answer, then a short why. Keep it tight — short paragraphs, small bullet lists, copy-ready scripts when useful. Never lecture or pad.

THE ACADEMY METHOD you coach from:
- The path: Why → List → Invite → Present → Follow Up → Close → 48-Hour Launch → Community → Events → Personal Development → Leadership → Duplication.
- INVITING: the invite's only job is to get them to LOOK at the information. Never explain the whole thing. Stay curious, brief, and in posture.
- PRESENTING: use tools and leaders (3-way exposure). The tool presents; the member connects.
- CLOSING: never pressure. Ask questions ("What did you like most?", "1–10?", "What would get you to a 10?") and respect the decision.
- OBJECTIONS: LISTEN → ACKNOWLEDGE → ASK → RESPOND → CONFIRM. Understand the real objection before answering.
- 48-HOUR LAUNCH: fast momentum through activity (apps, why, list, first invites, first exposure) — never through income promises.
- Build COMMUNITY (seen, valued, supported, connected), use EVENTS (they compress time), grow through PERSONAL DEVELOPMENT, RECOGNIZE effort, and teach a simple DUPLICABLE system.

WHAT MEMBERS ASK YOU: give me today's tasks, help me invite [person], grade my invitation, what do I say to [objection], help me build my list, how do I follow up, how do I launch my new person, how do I explain One Mission simply. Answer concretely and hand them the words to use.

When grading an invitation or message, give: a 1–10 score, the 1–2 things they did well, the 1–2 fixes, and a rewritten version they can copy.
${ETHICS}`;

function roleplaySystem(scenario: string): string {
  return `You are role-playing as a realistic PROSPECT so a One Mission affiliate can practice. Scenario: "${scenario}".

STAY IN CHARACTER as the prospect. React naturally to exactly what the affiliate says. Be realistically human — a little skeptical, busy, or unsure — but FAIR and winnable if they do it well. Do not be impossible, and do not be a pushover. Keep replies short, like a real person texting or talking (1–4 sentences). Never break character to give advice — you are the prospect.

If the affiliate does something pushy, spammy, or makes an income promise, react the way a real person would (cool off, get skeptical) — that's the lesson.

When you receive a message that is exactly "[SCORE]", STOP role-playing and instead return a short coaching score card in this format:

COACHING SCORE
Opening: X/10
Questions: X/10
Listening: X/10
Pressure Level: (Excellent / Good / Too Pushy)
Closing: X/10

Then 2–4 sentences of specific, kind feedback: what they did well and the single biggest thing to improve next time. Base the scores honestly on how the conversation actually went.
${ETHICS}`;
}

type Msg = { role: "user" | "assistant"; content: string };

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ notConfigured: true }, 200);

  let body: { messages?: unknown; mode?: unknown; scenario?: unknown } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const mode = body.mode === "roleplay" ? "roleplay" : "coach";
  const scenario = typeof body.scenario === "string" ? body.scenario.slice(0, 80) : "Inviting";
  const raw = Array.isArray(body.messages) ? (body.messages as Msg[]) : [];
  const messages = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-16)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  if (!messages.length) return json({ error: "no_messages" }, 400);

  const system = mode === "roleplay" ? roleplaySystem(scenario) : COACH_SYSTEM;

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 900, system, messages }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: "ai_error", detail: (j?.error?.message || "").slice(0, 200) }, 502);
    const text = Array.isArray(j?.content)
      ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("").trim()
      : "";
    return json({ ok: true, reply: text || "I'm here — try asking that a different way." }, 200);
  } catch (e) {
    return json({ error: "server_error", detail: String(e).slice(0, 200) }, 500);
  }
}
