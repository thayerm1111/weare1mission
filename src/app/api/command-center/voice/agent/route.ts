import { createClient } from "@/lib/supabase/server";
import { callbackUrl, provisionAgent, ensureAgent } from "../../../../../../command-center/engines/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * WHAT THE PROVIDER ACTUALLY STORED.
 *
 * The custom-LLM request shape is not fully published, so an agent can be created successfully with a
 * configuration the provider then quietly ignores — which looks, from a microphone, exactly like a
 * conversation where nothing ever answers. This route reads the agent BACK from the provider so the
 * difference between "we sent it" and "they kept it" is visible instead of inferred.
 *
 * It returns the provider's own JSON with the obvious secrets stripped. Admin only, and read-only
 * unless asked: POST re-provisions, which is the repair when the answer is "they did not keep it".
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o, null, 2), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function admin(): Promise<boolean> {
  const supabase = createClient();
  if (!supabase) return false;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  return (data as { role?: string } | null)?.role === "admin";
}

/** Nothing here should ever print a key, however useful it would be at 2am. */
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = /api_key|secret|token|password/i.test(k) && typeof val === "string" ? "«redacted»" : redact(val);
    }
    return out;
  }
  return v;
}

export async function GET() {
  if (!(await admin())) return json({ error: "unauthorized" }, 401);
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return json({ error: "no key" }, 503);

  const agent = await ensureAgent();
  if (!agent.ok) return json({ ok: false, reason: agent.reason });

  const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agent.agentId}`, {
    headers: { "xi-api-key": key },
    cache: "no-store",
  });
  const text = await r.text();
  let parsed: unknown = text.slice(0, 4000);
  try { parsed = redact(JSON.parse(text)); } catch { /* provider sent something that is not JSON; show it raw */ }

  return json({
    ok: r.ok,
    status: r.status,
    agentId: agent.agentId,
    expectedCallback: callbackUrl(),
    agent: parsed,
  });
}

export async function POST() {
  if (!(await admin())) return json({ error: "unauthorized" }, 401);
  const p = await provisionAgent();
  return json(p);
}
