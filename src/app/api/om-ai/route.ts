import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildSystem } from "@/lib/omai/prompts";
import { gateCredits, chargeCredit } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

type Msg = { role: "user" | "assistant"; content: string; images?: unknown };
type ImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
type TextBlock = { type: "text"; text: string };
type OutMsg = { role: "user" | "assistant"; content: string | (ImageBlock | TextBlock)[] };

const IMG_RE = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/;
const MAX_IMG_B64 = 4_500_000; // ~4.5MB per image
const MAX_IMAGES = 6; // total across the whole request (newest first)

function parseDataUrl(d: unknown): ImageBlock | null {
  if (typeof d !== "string") return null;
  const m = IMG_RE.exec(d);
  if (!m) return null;
  if (m[2].length > MAX_IMG_B64) return null;
  const media = m[1] === "image/jpg" ? "image/jpeg" : m[1];
  return { type: "image", source: { type: "base64", media_type: media, data: m[2] } };
}

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

  // Keep valid turns: text and/or attached images. Newest turns keep their
  // images; a global cap (newest first) bounds request size/cost.
  const raw: Msg[] = (Array.isArray(body?.messages) ? body!.messages : [])
    .filter((m): m is Msg => !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-24);

  let imageBudget = MAX_IMAGES;
  const messages: OutMsg[] = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    const m = raw[i];
    const txt = m.content.trim().slice(0, 6000);
    const imgs: ImageBlock[] = [];
    if (m.role === "user" && Array.isArray(m.images)) {
      for (const d of m.images) {
        if (imageBudget <= 0) break;
        const blk = parseDataUrl(d);
        if (blk) { imgs.push(blk); imageBudget--; }
      }
    }
    if (!txt && imgs.length === 0) continue; // skip empty turns
    if (imgs.length === 0) {
      messages.unshift({ role: m.role, content: txt });
    } else {
      const blocks: (ImageBlock | TextBlock)[] = [...imgs];
      blocks.push({ type: "text", text: txt || "Analyze this chart / screenshot of my analysis. Give your read on the structure, key levels, what I got right or wrong, and what you'd watch for — with risk." });
      messages.unshift({ role: m.role, content: blocks });
    }
  }

  if (!messages.length) return json({ error: "no_messages" }, 400);

  // Credit gate — one credit per message, charged only if the reply succeeds.
  const gate = await gateCredits("chat");
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);

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
        max_tokens: 1400,
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

  // Reply succeeded — charge the credit and surface the new balance via headers.
  const credits = await chargeCredit("chat");
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  if (credits) { headers["x-credits-daily-left"] = String(credits.dailyLeft); headers["x-credits-purchased"] = String(credits.purchased); }
  return new Response(text || "…", { headers });
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
