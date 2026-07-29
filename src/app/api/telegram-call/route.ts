import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * Push an OM Strategy Scanner call-out to the team Telegram channel.
 *
 * Admin-only (the desk calls out the trade). The client sends the already
 * display-formatted levels; we assemble a branded message and post it via the
 * Telegram Bot API. Requires two env vars set in Vercel:
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   TELEGRAM_CHANNEL_ID  — "@channelname" (public) or "-100…" (private)
 */

type Body = {
  symbol?: unknown;
  direction?: unknown;
  entry?: unknown;
  stop_loss?: unknown;
  take_profits?: unknown;
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

export async function POST(req: NextRequest) {
  // Auth + admin gate — only the desk (admin) can broadcast call-outs.
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  }
  const profile = await getProfile().catch(() => null);
  if (!profile || profile.role !== "admin") {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chatId) return json({ ok: false, notConfigured: true }, 200);

  let body: Body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }

  const symbol = str(body.symbol).slice(0, 40);
  const dir = str(body.direction).toLowerCase();
  const side = /long|buy/.test(dir) ? "BUY" : /short|sell/.test(dir) ? "SELL" : str(body.direction).toUpperCase();
  const entry = str(body.entry);
  const stop = str(body.stop_loss);
  const tps = (Array.isArray(body.take_profits) ? body.take_profits : [])
    .map(str)
    .filter((t) => t.length > 0)
    .slice(0, 5);

  if (!side || (!entry && !stop && tps.length === 0)) {
    return json({ ok: false, error: "no_trade" }, 400);
  }

  // Branded header + levels (HTML formatting for the bold header).
  const titleBits = [symbol, side].filter(Boolean).map(esc).join(" · ");
  const lines: string[] = [
    "<b>🎯 1 Mission — OM Strategy Scanner</b>",
  ];
  if (titleBits) lines.push(`<b>${titleBits}</b>`);
  lines.push("");
  if (entry) lines.push(`Entry: ${esc(entry)}`);
  if (stop) lines.push(`Stop Loss: ${esc(stop)}`);
  for (const t of tps) lines.push(`Take Profit: ${esc(t)}`);
  const text = lines.join("\n");

  let tgOk = false;
  let detail = "";
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => null);
    tgOk = !!(res.ok && data && data.ok);
    if (!tgOk) detail = (data && typeof data.description === "string" ? data.description : `status ${res.status}`).slice(0, 200);
  } catch {
    return json({ ok: false, error: "telegram_unreachable" }, 502);
  }

  if (!tgOk) return json({ ok: false, error: "telegram_error", detail }, 502);
  return json({ ok: true }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
