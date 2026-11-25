import type { SupabaseClient } from "@supabase/supabase-js";
import {
  nitrousTelegramToken, normalizeNitrousChannelUrl, sendNitrousTelegramEvent,
  type NitrousTelegramConfig, type NitrousTelegramDeliveryStore, type NitrousTelegramEvent,
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
  };
}

export async function readNitrousTelegramPublicState(db: SupabaseClient): Promise<NitrousTelegramPublicState> {
  try { return nitrousTelegramPublicState(await readNitrousTelegramSettings(db), Boolean(nitrousTelegramToken())); }
  catch { return { configured: false, status: "pending", url: null, title: null, lastVerifiedAt: null }; }
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
export async function publishNitrousTelegramEvent(db: SupabaseClient, event: NitrousTelegramEvent) {
  try {
    const row = await readNitrousTelegramSettings(db);
    const config = nitrousTelegramConfig(row);
    return await sendNitrousTelegramEvent({ config, event, store: nitrousTelegramDeliveryStore(db, config.channelId) });
  } catch { return { ok: false, state: "store_unavailable" as const }; }
}
