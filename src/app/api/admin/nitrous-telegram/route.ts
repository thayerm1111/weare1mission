import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { nitrousTelegramToken, normalizeNitrousChannelId, normalizeNitrousChannelUrl, readNitrousTelegramBotUsername, verifyNitrousTelegramChannel } from "@/lib/nitrous-telegram";
import { nitrousTelegramPublicState, readNitrousTelegramSettings, queueNitrousTelegramTest } from "@/lib/nitrous-telegram-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function adminContext() {
  const profile = await getProfile().catch(() => null);
  if (!profile || profile.role !== "admin" || profile.status !== "active") return { error: json({ error: "admin_only" }, 403) } as const;
  const db = createAdminClient();
  if (!db) return { error: json({ error: "configuration_unavailable" }, 503) } as const;
  return { db, profile } as const;
}

/** Metadata only. GET never emits a test post into a member channel. */
export async function GET(req?: Request) {
  const context = await adminContext();
  if ("error" in context) return context.error;
  try {
    const testId = req ? new URL(req.url).searchParams.get("testId") : null;
    if (testId) {
      if (!/^[a-f0-9-]{36}$/i.test(testId)) return json({ error: "not_found" }, 404);
      const test = await context.db.from("nitrous_telegram_tests").select("id,state,message_id,error_code").eq("id", testId).maybeSingle();
      if (test.error) return json({ error: "test_status_unavailable" }, 503);
      return test.data ? json({ ok: true, ...test.data }) : json({ error: "not_found" }, 404);
    }
    const [row, botUsername] = await Promise.all([
      readNitrousTelegramSettings(context.db), readNitrousTelegramBotUsername(nitrousTelegramToken()),
    ]);
    return json({
      ok: true, ...nitrousTelegramPublicState(row, Boolean(nitrousTelegramToken())),
      channelId: row?.telegram_channel_id ?? "", channelUrl: row?.telegram_channel_url ?? "",
      enabled: row?.telegram_enabled ?? false, tokenConfigured: Boolean(nitrousTelegramToken()),
      botUsername,
      lastError: row?.telegram_last_error ?? null,
    });
  } catch { return json({ error: "configuration_unavailable" }, 503); }
}

/** Configure and verify the existing channel; creating a Telegram channel requires its owner. */
export async function POST(req: Request) {
  const context = await adminContext();
  if ("error" in context) return context.error;
  const origin = req.headers.get("origin");
  if (!origin || origin !== new URL(req.url).origin || req.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "origin_not_allowed" }, 403);
  }
  if (!req.headers.get("content-type")?.includes("application/json")) return json({ error: "json_required" }, 415);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  if (body.action === "pause") {
    const { error } = await context.db.from("nitrous_telegram_settings").update({
      telegram_enabled: false, updated_by: context.profile.id, updated_at: new Date().toISOString(),
    }).eq("id", 1);
    return error ? json({ error: "save_failed" }, 503) : json({ ok: true, status: "paused" });
  }
  if (body.action === "test") {
    try {
      const test = await queueNitrousTelegramTest(context.db);
      return test ? json({ ok: true, ...test }, 202) : json({ error: "channel_not_ready", detail: "Verify and enable the Nitrous channel first." }, 409);
    } catch { return json({ error: "test_queue_unavailable", detail: "Unable to queue the test message." }, 503); }
  }
  if (body.action !== "save") return json({ error: "unsupported_action" }, 400);
  const channelId = normalizeNitrousChannelId(body.channelId);
  if (!channelId) return json({ error: "invalid_channel", detail: "Use a channel @username or its -100… identifier." }, 400);
  const channelUrl = normalizeNitrousChannelUrl(body.channelUrl);
  if (body.channelUrl && !channelUrl) return json({ error: "invalid_channel_url", detail: "Use an HTTPS t.me channel or invite link." }, 400);
  if (typeof body.enabled !== "boolean") return json({ error: "enabled_must_be_boolean" }, 400);

  const verification = await verifyNitrousTelegramChannel({ token: nitrousTelegramToken(), channelId, channelUrl });
  if (!verification.ok) return json({ error: verification.code, detail: verification.detail }, 409);

  const { error } = await context.db.from("nitrous_telegram_settings").upsert({
    id: 1, telegram_channel_id: verification.channelId, telegram_channel_url: verification.channelUrl,
    telegram_enabled: body.enabled, telegram_verified_at: verification.checkedAt,
    telegram_channel_title: verification.title, telegram_bot_id: verification.botId,
    telegram_last_error: null, updated_by: context.profile.id, updated_at: new Date().toISOString(),
  }, { onConflict: "id" });
  if (error) return json({ error: "save_failed" }, 503);
  return json({
    ok: true, configured: true, status: body.enabled ? "ready" : "paused",
    channelId: verification.channelId, channelUrl: verification.channelUrl, url: body.enabled ? verification.channelUrl : null,
    title: verification.title, enabled: body.enabled, tokenConfigured: true,
    botUsername: verification.botUsername, lastVerifiedAt: verification.checkedAt,
  });
}
