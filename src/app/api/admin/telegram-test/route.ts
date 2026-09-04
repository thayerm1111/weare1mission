import { getProfile } from "@/lib/auth";
import { isPriorityEmail } from "@/lib/marketData";
import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OWNER-ONLY Telegram connectivity test. Requires an authenticated session
 * whose email is in ADMIN_EMAILS (the owner). Posts a one-line probe to the
 * configured channel and returns Telegram's actual response, so a broken
 * token ("Not Found"/401) vs a broken channel ("chat not found") vs success
 * is visible instantly — no cron key needed. Every attempt also records into
 * the flow_heartbeat 'telegram' diagnostics like any other send.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const profile = await getProfile();
  if (!profile || !isPriorityEmail(profile.email)) return json({ ok: false, error: "admin_only" }, 403);
  const configured = { token: !!process.env.TELEGRAM_BOT_TOKEN, chatId: !!process.env.TELEGRAM_CHANNEL_ID, chatIdValue: process.env.TELEGRAM_CHANNEL_ID || null };
  if (!configured.token || !configured.chatId) return json({ ok: false, configured, error: "telegram_not_configured" });
  const res = await sendTelegram([
    "✅ <b>GENXFLOW connected</b>",
    "Alerts are wired back up — heads-ups, ENTER NOWs and wins will land here.",
  ].join("\n"));
  return json({ ok: res.ok, detail: res.detail ?? null, configured });
}
