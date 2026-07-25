import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildSystem } from "@/lib/omai/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

type Msg = { role: "user" | "assistant"; content: string };

export async function POST(req: NextRequest) {
  // Only signed-in members may use OM AI (protects the API key from abuse).
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ notConfigured: true }, 200);

  let body: { messages?: unknown; mode?: unknown; memory?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const mode = body?.mode === "business" ? "business" : "trading";
  const memory = typeof body?.memory === "string" ? body.memory : "";
  const messages: Msg[] = (Array.isArray(body?.messages) ? body!.messages : [])
    .filter((m): m is Msg =>
      !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0)
    .slice(-24)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));

  if (!messages.length) return json({ error: "no_messages" }, 400);

  let upstream: Response;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: buildSystem(mode, memory),
        messages,
      }),
    });
  } catch {
    return json({ error: "upstream_unreachable" }, 502);
  }

  const data = await upstream.json().catch(() => null);
  if (!upstream.ok || !data) {
    const detail = typeof data?.error?.message === "string" ? data.error.message : `status ${upstream.status}`;
    return json({ error: "upstream_error", detail: detail.slice(0, 300) }, 502);
  }

  const text: string = Array.isArray(data.content)
    ? data.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("")
    : "";

  return new Response(text || "…", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
