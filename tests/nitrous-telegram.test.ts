import test from "node:test";
import assert from "node:assert/strict";
import {
  formatNitrousTelegramEvent, nitrousTelegramToken, normalizeNitrousChannelId, normalizeNitrousChannelUrl,
  sendNitrousTelegramEvent, sendNitrousTelegramTest, validNitrousTelegramEvent, verifyNitrousTelegramChannel,
  type NitrousTelegramConfig, type NitrousTelegramDelivery, type NitrousTelegramDeliveryStore, type NitrousTelegramEvent,
} from "../src/lib/nitrous-telegram";
import { nitrousTelegramPublicState, type NitrousTelegramSettingsRow } from "../src/lib/nitrous-telegram-store";

const NOW = Date.UTC(2026, 10, 25, 23, 0, 0);
const event = (over: Partial<NitrousTelegramEvent> = {}): NitrousTelegramEvent => ({
  setupId: "gold:trend_pullback:2026-11-25T23:00:00", kind: "setup", side: "buy", family: "trend_pullback", profile: "both",
  occurredAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 600_000).toISOString(),
  entryLow: 4200, entryHigh: 4201, stop: 4194, target: 4212, ...over,
});
const config: NitrousTelegramConfig = {
  token: "123:private-test-token", channelId: "-100123456789", channelUrl: "https://t.me/NitrousTest",
  enabled: true, verifiedAt: new Date(NOW).toISOString(),
};
class MemoryDeliveryStore implements NitrousTelegramDeliveryStore {
  records = new Map<string, NitrousTelegramDelivery | { state: "sending" }>();
  async claim(key: string) {
    if (this.records.has(key)) return false;
    this.records.set(key, { state: "sending" });
    return true;
  }
  async finish(key: string, result: NitrousTelegramDelivery) { this.records.set(key, result); }
}
const response = (result: unknown, status = 200) => Response.json(result, { status });

test("dedicated channel inputs reject arbitrary URLs, user chats and malformed usernames", () => {
  assert.equal(normalizeNitrousChannelId("@NitrousTest"), "@NitrousTest");
  assert.equal(normalizeNitrousChannelId("-100123456789"), "-100123456789");
  for (const input of ["123456789", "https://t.me/NitrousTest", "@a", "@<script>"]) assert.equal(normalizeNitrousChannelId(input), null);
  assert.equal(normalizeNitrousChannelUrl("https://t.me/NitrousTest"), "https://t.me/NitrousTest");
  assert.equal(normalizeNitrousChannelUrl("https://t.me/+abcdefghijk"), "https://t.me/+abcdefghijk");
  for (const input of ["javascript:alert(1)", "https://t.me.evil.example/NitrousTest", "https://evil.example/NitrousTest", "https://evil@t.me/NitrousTest", "https://t.me/NitrousTest?token=secret"]) assert.equal(normalizeNitrousChannelUrl(input), null);
});

test("bot token reuse is explicit but channel configuration has no existing-channel fallback", () => {
  assert.equal(nitrousTelegramToken({ NITROUS_TELEGRAM_BOT_TOKEN: "specific", TELEGRAM_BOT_TOKEN: "existing" }), "specific");
  assert.equal(nitrousTelegramToken({ TELEGRAM_BOT_TOKEN: "existing" }), "existing");
  assert.equal(nitrousTelegramToken({}), null);
});

test("public messages whitelist setup evidence and distinguish price observations from account profit", () => {
  const extra = { ...event({ kind: "target_observed" }), balance: 9000, email: "private@example.test", accountId: "broker-private", profit: 5555 };
  const text = formatNitrousTelegramEvent(extra);
  assert.match(text, /TARGET OBSERVED/);
  assert.match(text, /not realized account profit or loss/);
  assert.doesNotMatch(text, /9000|private@example|broker-private|5555/);
  assert.doesNotMatch(text, new RegExp(extra.setupId));
  assert.match(formatNitrousTelegramEvent(event({ kind: "triggered" })), /not confirmation of an account fill/);
});

test("invalid geometry and inherited object keys cannot produce a channel alert", async () => {
  assert.equal(validNitrousTelegramEvent(event({ family: "__proto__" as never })), false);
  assert.equal(validNitrousTelegramEvent(event({ stop: 4202 })), false);
  assert.equal(validNitrousTelegramEvent(event({ target: 4199 })), false);
  let calls = 0;
  const result = await sendNitrousTelegramEvent({ config, event: event({ stop: 4202 }), store: new MemoryDeliveryStore(), now: NOW, fetcher: async () => { calls++; return response({ ok: true }); } });
  assert.equal(result.state, "invalid_event"); assert.equal(calls, 0);
});

test("disabled, missing-channel and unverified integrations never call Telegram", async () => {
  let calls = 0;
  for (const [patch, expected] of [
    [{ enabled: false }, "disabled"], [{ channelId: null }, "not_configured"], [{ verifiedAt: null }, "unverified"],
  ] as const) {
    const result = await sendNitrousTelegramEvent({ config: { ...config, ...patch }, event: event(), store: new MemoryDeliveryStore(), now: NOW, fetcher: async () => { calls++; return response({ ok: true }); } });
    assert.equal(result.state, expected);
  }
  assert.equal(calls, 0);
});

test("simultaneous workers publish the same setup event only once", async () => {
  const store = new MemoryDeliveryStore();
  let calls = 0;
  const input = { config, event: event(), store, now: NOW, fetcher: (async (_url: unknown, init?: RequestInit) => {
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.chat_id, config.channelId);
    return response({ ok: true, result: { message_id: 84 } });
  }) as typeof fetch };
  const results = await Promise.all([sendNitrousTelegramEvent(input), sendNitrousTelegramEvent(input)]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((item) => item.state).sort(), ["duplicate", "sent"]);
  assert.equal([...store.records.values()][0].state, "sent");
});

test("uncertain delivery is retained and never blindly retried, with no token in errors", async () => {
  const store = new MemoryDeliveryStore();
  let calls = 0;
  const input = { config, event: event(), store, now: NOW, fetcher: (async () => { calls++; throw new Error(`Network error at https://api.telegram.org/bot${config.token}/sendMessage`); }) as typeof fetch };
  const first = await sendNitrousTelegramEvent(input);
  assert.equal(first.state, "unknown");
  assert.doesNotMatch(JSON.stringify(first), /private-test-token/);
  assert.equal((await sendNitrousTelegramEvent(input)).state, "duplicate");
  assert.equal(calls, 1);
});

test("a failed durable claim prevents sending; a failed completion write does not cause duplicate delivery", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return response({ ok: true, result: { message_id: 1 } }); }) as typeof fetch;
  const result = await sendNitrousTelegramEvent({ config, event: event(), now: NOW, fetcher, store: { claim: async () => { throw new Error("database unavailable"); }, finish: async () => {} } });
  assert.equal(result.state, "store_unavailable"); assert.equal(calls, 0);
  const store = new MemoryDeliveryStore(); store.finish = async () => { throw new Error("audit write failed"); };
  const first = await sendNitrousTelegramEvent({ config, event: event(), now: NOW, fetcher, store });
  assert.equal(first.state, "sent"); assert.equal(first.code, "delivery_record_pending");
  assert.equal((await sendNitrousTelegramEvent({ config, event: event(), now: NOW, fetcher, store })).state, "duplicate");
  assert.equal(calls, 1);
});

test("expired, delayed and future new setups cannot be broadcast as current", async () => {
  const fetcher = (async () => { throw new Error("must not send"); }) as typeof fetch;
  const send = (value: NitrousTelegramEvent) => sendNitrousTelegramEvent({ config, event: value, now: NOW, fetcher, store: new MemoryDeliveryStore() });
  assert.equal((await send(event({ expiresAt: new Date(NOW).toISOString() }))).state, "expired");
  assert.equal((await send(event({ occurredAt: new Date(NOW - 301_000).toISOString() }))).state, "expired");
  assert.equal((await send(event({ occurredAt: new Date(NOW + 61_000).toISOString() }))).state, "invalid_event");
});

test("channel verification is read-only, requires Post Messages permission and derives the canonical public URL", async () => {
  const methods: string[] = [];
  let postAllowed = true;
  const fetcher = (async (input: string | URL | Request) => {
    const method = String(input).split("/").pop()!; methods.push(method);
    if (method === "getMe") return response({ ok: true, result: { id: 123, username: "PlatformBot" } });
    if (method === "getChat") return response({ ok: true, result: { id: -100123456789, type: "channel", title: "Nitrous", username: "NitrousTest" } });
    if (method === "getChatMember") return response({ ok: true, result: { status: "administrator", can_post_messages: postAllowed } });
    throw new Error("mutation must not be called");
  }) as typeof fetch;
  const result = await verifyNitrousTelegramChannel({ token: config.token, channelId: "@NitrousTest", channelUrl: "https://t.me/UnrelatedChannel" }, fetcher);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.channelUrl, "https://t.me/NitrousTest");
  assert.deepEqual(methods.sort(), ["getChat", "getChatMember", "getMe"]);
  postAllowed = false;
  const denied = await verifyNitrousTelegramChannel({ token: config.token, channelId: "@NitrousTest" }, fetcher);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "post_permission_required");
});

test("public status never presents an unverified, paused or errored channel as ready", () => {
  const row: NitrousTelegramSettingsRow = {
    id: 1, telegram_channel_id: "-100123456789", telegram_channel_url: "https://t.me/NitrousTest",
    telegram_enabled: true, telegram_verified_at: new Date(NOW).toISOString(), telegram_channel_title: "Nitrous",
    telegram_bot_id: 123, telegram_last_error: null, updated_at: new Date(NOW).toISOString(),
  };
  assert.equal(nitrousTelegramPublicState(row, true).status, "ready");
  for (const [over, token, status] of [
    [{ telegram_verified_at: null }, true, "pending"], [{ telegram_enabled: false }, true, "paused"],
    [{ telegram_last_error: "telegram_403" }, true, "error"], [{}, false, "pending"],
  ] as const) {
    const state = nitrousTelegramPublicState({ ...row, ...over }, token);
    assert.equal(state.status, status); assert.equal(state.url, null);
  }
});

test("connection test verifies the exact channel and bot and sends no fake trade signal", async () => {
  const posts: unknown[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split("/").pop();
    if (method === "getMe") return response({ ok: true, result: { id: 123 } });
    if (method === "getChat") return response({ ok: true, result: { id: -100123456789, type: "channel", title: "Nitrous" } });
    if (method === "getChatMember") return response({ ok: true, result: { status: "administrator", can_post_messages: true } });
    posts.push(JSON.parse(String(init?.body)));
    return response({ ok: true, result: { message_id: 42 } });
  }) as typeof fetch;
  assert.equal((await sendNitrousTelegramTest(config, 999, fetcher)).state, "refused");
  assert.equal(posts.length, 0);
  assert.deepEqual(await sendNitrousTelegramTest(config, 123, fetcher), { state: "sent", messageId: 42 });
  assert.equal(posts.length, 1);
  assert.match(JSON.stringify(posts), /CONNECTION TEST/);
  assert.match(JSON.stringify(posts), /not a trade signal/);
  assert.doesNotMatch(JSON.stringify(posts), /Entry zone|Stop:|Target:/);
});
