/**
 * Minimal Telegram Bot API sender. Requires two env vars set in Vercel:
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   TELEGRAM_CHANNEL_ID  — "@channelname" (public) or "-100…" (private channel/group)
 *
 * Returns { ok, notConfigured?, detail? } and never throws.
 */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendTelegram(textHtml: string, opts?: { chatId?: string }): Promise<{ ok: boolean; notConfigured?: boolean; detail?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts?.chatId || process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chatId) return { ok: false, notConfigured: true };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: textHtml, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j && j.ok) return { ok: true };
    return { ok: false, detail: (j && (j.description as string)) || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "network error" };
  }
}
