import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Minimal Telegram Bot API sender. Requires two env vars set in Vercel:
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   TELEGRAM_CHANNEL_ID  — "@channelname" (public) or "-100…" (private channel/group)
 *
 * Returns { ok, notConfigured?, detail? } and never throws.
 *
 * OBSERVABILITY: every send records its outcome into flow_heartbeat (component
 * "telegram", one upserted row — zero growth). Before this, a failed send was
 * silently swallowed at every call site, so a dead channel (bot kicked, token
 * revoked, wrong chat id) looked identical to a quiet market. The heartbeat
 * detail carries Telegram's actual error description so the exact cause is
 * readable straight from the DB.
 */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Best-effort: persist the last send outcome (and error counts) for diagnostics. */
async function recordSend(ok: boolean, detail?: string, notConfigured?: boolean): Promise<void> {
  try {
    const admin = createAdminClient();
    if (!admin) return;
    const now = new Date().toISOString();
    // Keep small rolling counters so "how long has this been failing?" is answerable.
    const { data } = await admin.from("flow_heartbeat").select("detail").eq("component", "telegram").maybeSingle();
    const prev = (data as { detail?: { ok_count?: number; fail_count?: number; last_ok_at?: string; last_fail_at?: string } } | null)?.detail ?? {};
    const next: Record<string, unknown> = {
      last_ok: ok,
      last_detail: detail ?? null,
      not_configured: !!notConfigured,
      ok_count: (prev.ok_count ?? 0) + (ok ? 1 : 0),
      fail_count: (prev.fail_count ?? 0) + (ok ? 0 : 1),
      last_ok_at: ok ? now : prev.last_ok_at ?? null,
      last_fail_at: !ok ? now : prev.last_fail_at ?? null,
    };
    await admin.from("flow_heartbeat").upsert(
      { component: "telegram", last_run: now, detail: next },
      { onConflict: "component" },
    );
  } catch { /* diagnostics are best-effort — never break the caller */ }
}

export async function sendTelegram(textHtml: string, opts?: { chatId?: string }): Promise<{ ok: boolean; notConfigured?: boolean; detail?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts?.chatId || process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chatId) { void recordSend(false, "missing token/chat id", true); return { ok: false, notConfigured: true }; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: textHtml, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j && j.ok) { await recordSend(true); return { ok: true }; }
    const detail = (j && (j.description as string)) || `HTTP ${r.status}`;
    await recordSend(false, detail);
    return { ok: false, detail };
  } catch (e) {
    const detail = e instanceof Error ? e.message : "network error";
    await recordSend(false, detail);
    return { ok: false, detail };
  }
}
