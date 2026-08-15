import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Learn From the Greats — AI Study Mode + Role-play. A study companion that
 * grounds its answers in the lesson the member is on and always bends the concept
 * back to ACTION inside One Mission. Same non-negotiable ETHICS as the Academy
 * coach: no income claims, no guarantees, no hype, no manipulation.
 *
 * Signed-in members only (protects the API key). No credit charge.
 *
 * Modes:
 *   study     → explains, simplifies, quizzes, and helps apply the lesson.
 *   roleplay  → the AI plays a realistic person so the member can practice a
 *               conversation from the lesson; on "[SCORE]" it returns a coaching card.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const ETHICS = `
NON-NEGOTIABLE ETHICS. You must NEVER:
- promise or imply specific earnings, income, or guaranteed results;
- teach spam, mass blasting, buying leads, or deceptive messaging;
- teach pressure, guilt, manipulation, fake urgency, or hiding that it's network marketing;
- turn a personal-development idea into a money promise.
If asked to do any of the above, kindly refuse and redirect to the honest, service-first way.
Personal development is about becoming better and serving people well — never about get-rich hype.`;

function studySystem(ctx: string): string {
  return `You are the One Mission Study Companion inside the "Learn From the Greats" personal-development library. You help a member truly UNDERSTAND and APPLY the lesson they're studying.

VOICE: warm, plain-spoken, 6th–8th grade reading level. Lead with the answer, then a short why. Keep it tight. Use small examples. Never lecture or pad.

WHAT YOU DO:
- Explain the lesson's ideas in simpler words when asked ("explain like I'm new").
- Quiz the member with a practical question when they ask to be quizzed, then give feedback.
- Help them APPLY the idea to building One Mission (their trading + affiliate community) — always end with a concrete next action.
- Connect the idea to their real life honestly. Encourage, don't hype.
- If they drift off-topic, gently bring it back to the lesson and to action.

You teach ORIGINAL One Mission training built on famous concepts — you do NOT reproduce any book's text. If they want the original work, point them to the official/free resource linked in the lesson.

THE LESSON THE MEMBER IS STUDYING (use this as your grounding; stay consistent with it):
${ctx || "(no specific lesson selected — help them pick one or answer generally within the library's themes)"}
${ETHICS}`;
}

function roleplaySystem(scenario: string, ctx: string): string {
  return `You are role-playing a realistic PERSON so a One Mission member can practice the skill from their lesson. Scenario: "${scenario}".

STAY IN CHARACTER. React naturally to exactly what the member says. Be realistically human — a little skeptical, busy, or unsure — but FAIR and winnable if they do it well. Never impossible, never a pushover. Keep replies short like a real person (1–4 sentences). Never break character to give advice.

When the member sends "[SCORE]", STOP role-playing and return a short coaching card:
- Score 1–10
- What they did well (1–2 points)
- What to improve (1–2 points)
- One sentence they could have used
Keep the ethics in mind: reward honesty, listening, and no-pressure posture; penalize hype, income claims, and manipulation.

CONTEXT FROM THE LESSON (so the practice fits what they just learned):
${ctx || "(general practice)"}
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

  let body: { messages?: unknown; mode?: unknown; scenario?: unknown; context?: unknown } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const mode = body.mode === "roleplay" ? "roleplay" : "study";
  const scenario = typeof body.scenario === "string" ? body.scenario.slice(0, 120) : "Practice";
  const context = typeof body.context === "string" ? body.context.slice(0, 6000) : "";
  const raw = Array.isArray(body.messages) ? (body.messages as Msg[]) : [];
  const messages = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-16)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  if (!messages.length) return json({ error: "no_messages" }, 400);

  const system = mode === "roleplay" ? roleplaySystem(scenario, context) : studySystem(context);

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 900, system, messages }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: "ai_error", detail: (j?.error?.message || "").slice(0, 200) }, 502);
    const text = Array.isArray(j?.content)
      ? j.content.filter((blk: { type?: string }) => blk?.type === "text").map((blk: { text?: string }) => blk.text ?? "").join("").trim()
      : "";
    return json({ ok: true, reply: text || "I'm here — try asking that a different way." }, 200);
  } catch (e) {
    return json({ error: "server_error", detail: String(e).slice(0, 200) }, 500);
  }
}
