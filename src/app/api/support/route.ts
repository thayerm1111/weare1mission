import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";
const SUPPORT_EMAIL = "support@onemissioncollection.com";

type Msg = { role: "user" | "assistant"; content: string };

// Support assistant persona. It knows how weare1mission works and always points
// people to a human when it can't fully resolve something. Support is FREE —
// this route never charges credits.
const SYSTEM = `You are the weare1mission Support Assistant — a warm, concise help agent for members of the 1 Mission community platform (weare1mission.com).

What you help with:
- Account & login: members sign in with their member ID or email and password. Access is granted to people active on Conectiv/Kuvera or approved by an admin. They can set a password on the Account page.
- Credits: members get a weekly free floor of credits that tops up once each week, plus a one-time welcome grant. Purchased credit packs (Starter 50/$19.99, Trader 200/$39.99, Pro 500/$79.99) never expire and stack on top. Credits are bought on the Credits page via secure Stripe checkout. Actions like OM AI chat, generating a play, deep dives, and Market Pulse scans cost credits.
- OM AI tools: OM AI chat (trading & business co-pilot), OM AI Plays, OM Charts, MFXGHOST, Market Command, Strategy Scanner — found under The Floor.
- Purchase history is on the Account page.
- General navigation and "how do I…" questions about the member portal.

Rules:
- Be friendly, brief, and practical. Use plain language and short steps.
- You give guidance on using the platform. You do NOT give financial or investment advice — OM AI's market content is educational only.
- If someone needs a human, a refund, has a billing problem you can't resolve, reports a bug, or asks something you're unsure about, tell them to email ${SUPPORT_EMAIL} and briefly say what to include (their member ID and a short description).
- Never invent account-specific details (balances, order IDs, dates) — you don't have access to their data. Point them to the Account or Credits page, or to email support.
- Keep replies focused; don't pad. It's fine to answer in a sentence or two.`;

export async function POST(req: NextRequest) {
  // Signed-in members only (protects the API key from abuse). Support is free.
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ notConfigured: true }, 200);

  let body: { messages?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const messages: Msg[] = (Array.isArray(body?.messages) ? body!.messages : [])
    .filter((m): m is Msg => !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 4000) }))
    .filter((m) => m.content.length > 0)
    .slice(-20);

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
      body: JSON.stringify({ model: MODEL, max_tokens: 900, system: SYSTEM, messages }),
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
