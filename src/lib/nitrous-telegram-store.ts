import type { SupabaseClient } from "@supabase/supabase-js";
import {
  nitrousTelegramToken, normalizeNitrousChannelUrl, sendNitrousTelegramEvent, sendNitrousTelegramTest,
  type NitrousTelegramConfig, type NitrousTelegramDeliveryStore, type NitrousChannelEvent,
} from "./nitrous-telegram";

export type NitrousTelegramSettingsRow = {
  id: number;
  telegram_channel_id: string | null;
  telegram_channel_url: string | null;
  telegram_enabled: boolean;
  telegram_verified_at: string | null;
  telegram_channel_title: string | null;
  telegram_bot_id: number | null;
  telegram_last_error: string | null;
  updated_at: string;
};

export type NitrousTelegramPublicState = {
  configured: boolean;
  status: "pending" | "paused" | "ready" | "error";
  url: string | null;
  title: string | null;
  lastVerifiedAt: string | null;
  latestAlert: { url: string; sentAt: string } | null;
};

export async function readNitrousTelegramSettings(db: SupabaseClient): Promise<NitrousTelegramSettingsRow | null> {
  const { data, error } = await db.from("nitrous_telegram_settings")
    .select("id,telegram_channel_id,telegram_channel_url,telegram_enabled,telegram_verified_at,telegram_channel_title,telegram_bot_id,telegram_last_error,updated_at")
    .eq("id", 1).maybeSingle();
  if (error) throw new Error("nitrous_telegram_configuration_unavailable");
  return data as NitrousTelegramSettingsRow | null;
}

export function nitrousTelegramPublicState(row: NitrousTelegramSettingsRow | null, tokenConfigured: boolean): NitrousTelegramPublicState {
  const configured = Boolean(tokenConfigured && row?.telegram_channel_id && row.telegram_verified_at);
  const status = !configured ? "pending" : row?.telegram_last_error ? "error" : !row?.telegram_enabled ? "paused" : "ready";
  return {
    configured, status,
    url: status === "ready" ? normalizeNitrousChannelUrl(row?.telegram_channel_url) : null,
    title: row?.telegram_channel_title ?? null,
    lastVerifiedAt: row?.telegram_verified_at ?? null,
    latestAlert: null,
  };
}

export async function readNitrousTelegramPublicState(db: SupabaseClient, settings?: NitrousTelegramSettingsRow | null): Promise<NitrousTelegramPublicState> {
  const row = settings === undefined ? await readNitrousTelegramSettings(db).catch(() => null) : settings;
  const state = nitrousTelegramPublicState(row, Boolean(nitrousTelegramToken()));
  if (state.status !== "ready" || !row?.telegram_channel_id) return state;

  // Verification stores the canonical numeric channel ID returned by Telegram.
  const channel = /^-100([1-9]\d*)$/.exec(row.telegram_channel_id)?.[1];
  if (!channel) return state;
  try {
    const { data, error } = await db.from("nitrous_telegram_deliveries").select("resolved_at,message_id")
      .eq("channel_id", row.telegram_channel_id).eq("state", "sent").gt("message_id", 0).not("resolved_at", "is", null)
      .order("resolved_at", { ascending: false }).limit(1).maybeSingle();
    if (!error && data && Number.isSafeInteger(data.message_id) && data.message_id > 0 && Number.isFinite(Date.parse(data.resolved_at))) {
      state.latestAlert = { url: `https://t.me/c/${channel}/${data.message_id}`, sentAt: data.resolved_at };
    }
  } catch { /* A missing delivery record must not hide the verified join link. */ }
  return state;
}

export function nitrousTelegramConfig(row: NitrousTelegramSettingsRow | null): NitrousTelegramConfig {
  return {
    token: nitrousTelegramToken(), channelId: row?.telegram_channel_id ?? null,
    channelUrl: normalizeNitrousChannelUrl(row?.telegram_channel_url),
    enabled: row?.telegram_enabled === true && !row.telegram_last_error,
    verifiedAt: row?.telegram_verified_at ?? null,
  };
}

export function nitrousTelegramDeliveryStore(db: SupabaseClient, channelId: string | null): NitrousTelegramDeliveryStore {
  return {
    async claim(key, event, channelId) {
      const { error } = await db.from("nitrous_telegram_deliveries").insert({
        event_key: key, setup_id: event.setupId, event_kind: event.kind,
        channel_id: channelId, state: "sending",
      });
      if (error?.code === "23505") return false;
      if (error) throw new Error("nitrous_telegram_delivery_store_unavailable");
      return true;
    },
    async finish(key, result) {
      const { error } = await db.from("nitrous_telegram_deliveries").update({
        state: result.state, message_id: result.messageId ?? null, error_code: result.code ?? null,
        resolved_at: new Date().toISOString(),
      }).eq("event_key", key).eq("state", "sending");
      if (error) throw new Error("nitrous_telegram_delivery_record_unavailable");
      // Pause on known permission/configuration failures; no customer data is retained here.
      if (result.state === "refused" && ["telegram_400", "telegram_401", "telegram_403"].includes(result.code ?? "")) {
        await db.from("nitrous_telegram_settings").update({
          telegram_last_error: result.code, updated_at: new Date().toISOString(),
        }).eq("id", 1).eq("telegram_channel_id", channelId);
      }
    },
  };
}

/** Worker entry point. All exceptions become a non-delivery result, never an order failure. */
export async function publishNitrousTelegramEvent(db: SupabaseClient, event: NitrousChannelEvent) {
  try {
    const row = await readNitrousTelegramSettings(db);
    const config = nitrousTelegramConfig(row);
    return await sendNitrousTelegramEvent({ config, event, store: nitrousTelegramDeliveryStore(db, config.channelId) });
  } catch { return { ok: false, state: "store_unavailable" as const }; }
}

export async function queueNitrousTelegramTest(db: SupabaseClient) {
  const row = await readNitrousTelegramSettings(db);
  if (!row?.telegram_enabled || !row.telegram_channel_id || !row.telegram_bot_id || !row.telegram_verified_at || row.telegram_last_error) return null;
  const { data, error } = await db.from("nitrous_telegram_tests").insert({
    channel_id: row.telegram_channel_id, bot_id: row.telegram_bot_id,
  }).select("id,state").single();
  if (error || !data) throw new Error("test_queue_unavailable");
  return data as { id: string; state: string };
}

/** Separate worker loop. A durable conditional claim precedes sending; unknown delivery is never retried. */
export async function processNitrousTelegramTest(db: SupabaseClient) {
  const now = new Date().toISOString();
  const expired = await db.from("nitrous_telegram_tests").update({ state: "unknown", error_code: "delivery_unknown", resolved_at: now })
    .eq("state", "sending").lt("claimed_at", new Date(Date.now() - 120_000).toISOString());
  if (expired.error) throw new Error("test_queue_unavailable");
  const next = await db.from("nitrous_telegram_tests").select("id").eq("state", "queued")
    .order("requested_at", { ascending: true }).limit(1).maybeSingle();
  if (next.error) throw new Error("test_queue_unavailable");
  if (!next.data) return;
  const claim = await db.from("nitrous_telegram_tests").update({ state: "sending", claimed_at: now })
    .eq("id", next.data.id).eq("state", "queued").select("id,channel_id,bot_id,requested_at").maybeSingle();
  if (claim.error) throw new Error("test_claim_unavailable");
  if (!claim.data) return;
  const request = claim.data;
  let result: import("./nitrous-telegram").NitrousTelegramDelivery;
  try {
    const settings = await readNitrousTelegramSettings(db);
    if (!settings || settings.telegram_channel_id !== request.channel_id || Number(settings.telegram_bot_id) !== Number(request.bot_id)) {
      result = { state: "refused", code: "test_destination_changed" };
    } else if (Date.now() - Date.parse(request.requested_at) > 600_000) {
      result = { state: "refused", code: "test_request_expired" };
    } else {
      result = await sendNitrousTelegramTest(nitrousTelegramConfig(settings), Number(request.bot_id));
    }
  } catch { result = { state: "unknown", code: "delivery_unknown" }; }
  const saved = await db.from("nitrous_telegram_tests").update({
    state: result.state, message_id: result.messageId ?? null, error_code: result.code ?? null, resolved_at: new Date().toISOString(),
  }).eq("id", request.id).eq("state", "sending");
  if (saved.error) throw new Error("test_result_unavailable");
}

