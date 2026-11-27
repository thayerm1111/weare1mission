/**
 * Public Nitrous setup alerts. This module can be used by the server and worker.
 * It deliberately has no fallback to the existing GENX/FLOW channel.
 * Customer/account fields are not accepted by the formatter.
 */
import { createHash } from "node:crypto";

export type NitrousTelegramKind = "setup" | "triggered" | "expired" | "invalidated" | "target_observed" | "stop_observed";
export type NitrousTelegramEvent = {
  setupId: string;
  kind: NitrousTelegramKind;
  side: "buy" | "sell";
  family: "trend_pullback" | "break_retest" | "range_reaction" | "sweep_reclaim" | "range_edge_rejection" | "compression_breakout";
  profile: "slow_drip" | "nitrous" | "both";
  occurredAt: string;
  expiresAt: string;
  entryLow: number;
  entryHigh: number;
  stop: number;
  target: number;
};

/** Public confirmation of a broker-observed live fill. setupId is the shared strategy opportunity. */
export type NitrousActivationEvent = Pick<NitrousTelegramEvent, "setupId" | "side" | "occurredAt"> & {
  kind: "activated";
};
export type NitrousChannelEvent = NitrousTelegramEvent | NitrousActivationEvent;

export type NitrousTelegramConfig = {
  token: string | null;
  channelId: string | null;
  channelUrl: string | null;
  enabled: boolean;
  verifiedAt: string | null;
};

export type NitrousTelegramDelivery = {
  state: "sent" | "refused" | "unknown";
  messageId?: number;
  code?: string;
};

export interface NitrousTelegramDeliveryStore {
  /** A durable unique insert, committed before the first HTTP request. */
  claim(key: string, event: NitrousChannelEvent, channelId: string): Promise<boolean>;
  finish(key: string, result: NitrousTelegramDelivery): Promise<void>;
}

export type NitrousTelegramResult = {
  ok: boolean;
  state: "sent" | "disabled" | "not_configured" | "unverified" | "invalid_event" | "expired" | "duplicate" | "store_unavailable" | "refused" | "unknown";
  code?: string;
  messageId?: number;
};

type Fetcher = typeof fetch;
type ApiEnvelope = { ok?: boolean; result?: Record<string, unknown>; error_code?: number };
const KINDS: NitrousTelegramKind[] = ["setup", "triggered", "expired", "invalidated", "target_observed", "stop_observed"];
const FAMILY = { trend_pullback: "Trend pullback", break_retest: "Break and retest", range_reaction: "Range reaction", sweep_reclaim: "Sweep and reclaim", range_edge_rejection: "Range edge rejection", compression_breakout: "Compression breakout" };
const PROFILE = { slow_drip: "Slow Drip", nitrous: "Nitrous", both: "Slow Drip + Nitrous" };
const LABEL: Record<NitrousTelegramKind, string> = {
  setup: "SETUP WATCH", triggered: "TRIGGER CONFIRMED", expired: "SETUP EXPIRED",
  invalidated: "SETUP INVALIDATED", target_observed: "TARGET OBSERVED", stop_observed: "STOP OBSERVED",
};
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const finitePositive = (n: number) => Number.isFinite(n) && n > 0;

export function nitrousTelegramToken(env: Record<string, string | undefined> = process.env): string | null {
  return env.NITROUS_TELEGRAM_BOT_TOKEN?.trim() || env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

export function normalizeNitrousChannelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(id) || /^-100\d{5,16}$/.test(id) ? id : null;
}

export function normalizeNitrousChannelUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "t.me" || url.username || url.password || url.port || url.search || url.hash) return null;
    if (!/^\/(?:[A-Za-z][A-Za-z0-9_]{4,31}|\+[A-Za-z0-9_-]{8,128}|joinchat\/[A-Za-z0-9_-]{8,128})\/?$/.test(url.pathname)) return null;
    return `https://t.me${url.pathname.replace(/\/$/, "")}`;
  } catch { return null; }
}

/** Safe to show as a reference, never a broker order or customer identifier. */
export function nitrousTelegramEventKey(channelId: string, event: NitrousChannelEvent): string {
  return createHash("sha256").update(`${channelId}|${event.setupId}|${event.kind}`).digest("hex");
}

export function validNitrousTelegramEvent(event: NitrousChannelEvent): boolean {
  if (!event || typeof event.setupId !== "string" || !/^[A-Za-z0-9_.:-]{1,180}$/.test(event.setupId)) return false;
  if (event.kind === "activated") return ["buy", "sell"].includes(event.side) && Number.isFinite(Date.parse(event.occurredAt));
  if (!KINDS.includes(event.kind)) return false;
  if (!Object.prototype.hasOwnProperty.call(FAMILY, event.family) || !Object.prototype.hasOwnProperty.call(PROFILE, event.profile) || !["buy", "sell"].includes(event.side)) return false;
  if (![event.entryLow, event.entryHigh, event.stop, event.target].every(finitePositive) || event.entryLow > event.entryHigh) return false;
  if (!Number.isFinite(Date.parse(event.occurredAt)) || !Number.isFinite(Date.parse(event.expiresAt))) return false;
  return event.side === "buy"
    ? event.stop < event.entryLow && event.target > event.entryHigh
    : event.stop > event.entryHigh && event.target < event.entryLow;
}

export function formatNitrousTelegramEvent(event: NitrousChannelEvent): string {
  if (!validNitrousTelegramEvent(event)) throw new Error("invalid_nitrous_telegram_event");
  if (event.kind === "activated") return [
    "<b>⚡ Nitrous activated</b>",
    `XAU/USD · ${event.side === "buy" ? "Buy" : "Sell"}`,
    "Trade live on TradeLocker.",
  ].join("\n");
  const entry = event.entryLow === event.entryHigh ? event.entryLow.toFixed(2) : `${event.entryLow.toFixed(2)} – ${event.entryHigh.toFixed(2)}`;
  const reference = createHash("sha256").update(event.setupId).digest("hex").slice(0, 10).toUpperCase();
  const lifecycle = event.kind === "setup"
    ? "Conditional setup. Wait for the displayed trigger."
    : event.kind === "triggered"
      ? "The setup trigger was observed. This is not confirmation of an account fill."
      : event.kind.endsWith("_observed")
        ? "Price observation for this setup, not realized account profit or loss."
        : "This entry offer is no longer available.";
  return [
    "<b>ONE MISSION · NITROUS</b>",
    `<b>GOLD · ${event.side.toUpperCase()} · ${LABEL[event.kind]}</b>`,
    `${FAMILY[event.family]} · ${PROFILE[event.profile]}`,
    "", `Entry zone: ${entry}`, `Stop: ${event.stop.toFixed(2)}`, `Target: ${event.target.toFixed(2)}`,
    "", lifecycle,
    `Observed: ${esc(new Date(event.occurredAt).toISOString().replace("T", " ").replace(".000Z", " UTC"))}`,
    `Setup ${reference}`,
    '<a href="https://weare1mission.com/portal/nitrous">Open Nitrous</a>',
  ].join("\n");
}

async function telegramCall(token: string, method: string, body: Record<string, unknown>, fetcher: Fetcher): Promise<{ envelope: ApiEnvelope | null; status: number; unknown: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7_000);
  try {
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal, cache: "no-store",
    });
    const envelope = await response.json().catch(() => null) as ApiEnvelope | null;
    return { envelope, status: response.status, unknown: !envelope || response.status >= 500 };
  } catch {
    // Exception text can contain the request URL (and therefore the token). Never retain it.
    return { envelope: null, status: 0, unknown: true };
  } finally { clearTimeout(timer); }
}

export type NitrousTelegramVerification =
  | { ok: true; channelId: string; channelUrl: string | null; title: string; botId: number; botUsername: string | null; checkedAt: string }
  | { ok: false; code: string; detail: string };

export async function readNitrousTelegramBotUsername(token: string | null, fetcher: Fetcher = fetch): Promise<string | null> {
  if (!token) return null;
  const result = await telegramCall(token, "getMe", {}, fetcher);
  const username = result.envelope?.result?.username;
  return result.envelope?.ok === true && typeof username === "string" && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) ? username : null;
}

/** Read-only check: does not send a test message or create/change the channel. */
export async function verifyNitrousTelegramChannel(input: {
  token: string | null; channelId: string; channelUrl?: string | null;
}, fetcher: Fetcher = fetch): Promise<NitrousTelegramVerification> {
  if (!input.token) return { ok: false, code: "bot_not_configured", detail: "The Telegram bot is not configured on the server." };
  const channelId = normalizeNitrousChannelId(input.channelId);
  if (!channelId) return { ok: false, code: "invalid_channel", detail: "Use a channel @username or its -100… identifier." };
  const [me, chat] = await Promise.all([
    telegramCall(input.token, "getMe", {}, fetcher),
    telegramCall(input.token, "getChat", { chat_id: channelId }, fetcher),
  ]);
  if (me.unknown || chat.unknown) return { ok: false, code: "telegram_unavailable", detail: "Telegram could not verify the channel. Nothing was posted." };
  if (!me.envelope?.ok || !me.envelope.result?.id) return { ok: false, code: "bot_auth_failed", detail: "Telegram did not accept the configured bot." };
  if (!chat.envelope?.ok || !chat.envelope.result?.id) return { ok: false, code: "channel_unavailable", detail: "The bot cannot access that channel. Add it as an administrator first." };
  if (chat.envelope.result.type !== "channel") return { ok: false, code: "channel_required", detail: "Choose a dedicated Telegram channel, rather than a private chat or group." };
  const botId = Number(me.envelope.result.id);
  const member = await telegramCall(input.token, "getChatMember", { chat_id: chat.envelope.result.id, user_id: botId }, fetcher);
  if (member.unknown) return { ok: false, code: "telegram_unavailable", detail: "Telegram could not verify the bot's posting permission." };
  if (!member.envelope?.ok || member.envelope.result?.status !== "administrator" || member.envelope.result?.can_post_messages !== true) {
    return { ok: false, code: "post_permission_required", detail: "Give the bot administrator access with Post Messages enabled." };
  }
  const username = typeof chat.envelope.result.username === "string" ? chat.envelope.result.username : null;
  const publicUrl = username ? normalizeNitrousChannelUrl(`https://t.me/${username}`) : null;
  const brokerInvite = normalizeNitrousChannelUrl(chat.envelope.result.invite_link);
  const suppliedUrl = normalizeNitrousChannelUrl(input.channelUrl);
  if (!publicUrl && input.channelUrl && !suppliedUrl) return { ok: false, code: "invalid_invite_link", detail: "Use an HTTPS t.me invite link for the private channel." };
  return {
    ok: true, channelId: String(chat.envelope.result.id), channelUrl: publicUrl || brokerInvite || suppliedUrl,
    title: String(chat.envelope.result.title || "Nitrous").slice(0, 128), botId,
    botUsername: typeof me.envelope.result.username === "string" ? me.envelope.result.username : null,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * At-most-once sending: reserve before HTTP, and never resend an uncertain attempt.
 * Telegram sendMessage has no caller-supplied idempotency key. An interrupted request may
 * already have posted, so unresolved/refused deliveries require explicit operator review.
 */
export async function sendNitrousTelegramEvent(input: {
  config: NitrousTelegramConfig; event: NitrousChannelEvent; store: NitrousTelegramDeliveryStore;
  fetcher?: Fetcher; now?: number;
}): Promise<NitrousTelegramResult> {
  const { config, event, store } = input;
  if (!config.enabled) return { ok: false, state: "disabled" };
  if (!config.token || !config.channelId) return { ok: false, state: "not_configured" };
  if (!config.verifiedAt || !Number.isFinite(Date.parse(config.verifiedAt))) return { ok: false, state: "unverified" };
  if (!validNitrousTelegramEvent(event)) return { ok: false, state: "invalid_event" };
  const now = input.now ?? Date.now();
  if (Date.parse(event.occurredAt) > now + 60_000) return { ok: false, state: "invalid_event", code: "future_event" };
  if ((event.kind === "setup" || event.kind === "triggered") && (Date.parse(event.expiresAt) <= now || now - Date.parse(event.occurredAt) > 300_000)) {
    return { ok: false, state: "expired" };
  }
  if (event.kind === "activated" && now - Date.parse(event.occurredAt) > 60_000) return { ok: false, state: "expired" };
  const key = nitrousTelegramEventKey(config.channelId, event);
  try { if (!await store.claim(key, event, config.channelId)) return { ok: false, state: "duplicate" }; }
  catch { return { ok: false, state: "store_unavailable" }; }
  const reply = await telegramCall(config.token, "sendMessage", {
    chat_id: config.channelId, text: formatNitrousTelegramEvent(event), parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  }, input.fetcher ?? fetch);
  const messageId = Number(reply.envelope?.result?.message_id);
  const result: NitrousTelegramDelivery = reply.envelope?.ok === true && Number.isSafeInteger(messageId) && messageId > 0
    ? { state: "sent", messageId }
    : reply.unknown
      ? { state: "unknown", code: "delivery_unknown" }
      : { state: "refused", code: `telegram_${Number(reply.envelope?.error_code || reply.status) || "refused"}` };
  try { await store.finish(key, result); }
  catch {
    // The durable reservation remains: an audit-write failure must never trigger a second post.
    return { ok: result.state === "sent", state: result.state, messageId: result.messageId, code: "delivery_record_pending" };
  }
  return { ok: result.state === "sent", ...result };
}

/** A connection test is not a market event, signal or trade. Recheck the exact channel and bot before sending. */
export async function sendNitrousTelegramTest(config: NitrousTelegramConfig, expectedBotId: number, fetcher: Fetcher = fetch): Promise<NitrousTelegramDelivery> {
  if (!config.enabled || !config.token || !config.channelId || !config.verifiedAt) return { state: "refused", code: "test_channel_not_ready" };
  const verified = await verifyNitrousTelegramChannel({ token: config.token, channelId: config.channelId }, fetcher);
  if (!verified.ok) return { state: "refused", code: verified.code };
  if (verified.channelId !== config.channelId || verified.botId !== expectedBotId) return { state: "refused", code: "test_destination_changed" };
  const reply = await telegramCall(config.token, "sendMessage", {
    chat_id: verified.channelId,
    text: "<b>⚡ ONE MISSION · NITROUS</b>\n\n<b>CONNECTION TEST</b>\n\nNitrous Telegram alerts are connected and working.\nThis is a test only — not a trade signal.\n\n<a href=\"https://weare1mission.com/portal/nitrous\">Open Nitrous</a>",
    parse_mode: "HTML", link_preview_options: { is_disabled: true },
  }, fetcher);
  const id = Number(reply.envelope?.result?.message_id);
  if (reply.envelope?.ok === true && Number.isSafeInteger(id) && id > 0) return { state: "sent", messageId: id };
  return reply.unknown ? { state: "unknown", code: "delivery_unknown" }
    : { state: "refused", code: `telegram_${Number(reply.envelope?.error_code || reply.status) || "refused"}` };
}

