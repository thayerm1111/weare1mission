/**
 * THE BRAIN, SPEAKING IN THE GENX CHANNEL.
 *
 * The owner watches one Telegram channel. GENX 1.0 posts its ENTER NOW calls there; THE BRAIN now
 * posts alongside them, clearly labelled, so one feed answers both "what was called" and "is the new
 * engine alive".
 *
 * IT DOES NOT IMPORT FLOW'S SENDER, AND THAT IS THE POINT. src/lib/telegram.ts is the desk's, and the
 * clean-room boundary between the two stacks is about CODE, not about which channel a message lands
 * in. This is forty lines of the Bot API; sharing a module to save them would couple the Command
 * Center's worker to the desk's Next.js path aliases and its Supabase client for no benefit.
 *
 * TWO AUDIENCES, TWO CHATS.
 *
 *   Trade calls        → TELEGRAM_CHANNEL_ID, beside the GENX signals.
 *   Health and status  → CC_TELEGRAM_HEALTH_CHAT_ID, falling back to TELEGRAM_ADMIN_CHAT_ID and then
 *                        to the main channel.
 *
 * The fallback chain matters: a heartbeat every hour is useful to an owner and noise to a member, so
 * the moment a separate chat id exists the health stream moves to it without a deploy.
 *
 * NEVER THROWS, NEVER BLOCKS A TRADE. Every failure is swallowed and reported in the return value. A
 * message that cannot be sent must never be the reason an order is not placed, or the reason a worker
 * loop dies.
 */

export type TgResult = { ok: boolean; notConfigured?: boolean; detail?: string };

/** Telegram's HTML parse mode only allows a few tags; everything else has to be escaped. */
export const esc = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type Audience = "signals" | "health";

function chatFor(audience: Audience): string | null {
  const main = process.env.TELEGRAM_CHANNEL_ID || "";
  if (audience === "signals") return main || null;
  return process.env.CC_TELEGRAM_HEALTH_CHAT_ID
    || process.env.TELEGRAM_ADMIN_CHAT_ID
    || main
    || null;
}

export function telegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN && !!chatFor("signals");
}

export async function sendTelegram(textHtml: string, audience: Audience = "health"): Promise<TgResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = chatFor(audience);
  if (!token || !chatId) return { ok: false, notConfigured: true };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: textHtml,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (r.ok && j?.ok) return { ok: true };
    return { ok: false, detail: j?.description || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "network error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Two decimals, or an em dash. Gold is quoted to two, and a bare "null" in a channel looks broken. */
export const fmt = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : Number(n).toFixed(2);
