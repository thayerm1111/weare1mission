import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildSystem } from "@/lib/omai/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
        max_tokens: 1200,
        system: buildSystem(mode, memory),
        messages,
        stream: true,
      }),
    });
  } catch {
    return json({ error: "upstream_unreachable" }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return json({ error: "upstream_error", status: upstream.status, detail: detail.slice(0, 300) }, 502);
  }

  // Transform Anthropic SSE into a plain-text delta stream the client can read.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const evt = JSON.parse(data);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            controller.enqueue(encoder.encode(evt.delta.text));
          }
        } catch { /* partial JSON across chunks — ignore */ }
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });

  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
