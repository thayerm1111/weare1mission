# Nitrous Telegram channel

## Owner setup

1. In the owner's Telegram account, create a channel named **One Mission · Nitrous**. Suggested description: “Gold setups and progress from One Mission. Slow Drip and Nitrous. Setup observations are separate from individual account fills and returns.”
2. Open `/portal/nitrous` as a platform administrator and expand **Channel settings**. The form reads the configured bot's public username without sending a message.
3. Add that bot to the channel as an administrator with **Post Messages** enabled.
4. Enter the public `@channel_username`, or the channel's `-100…` ID and its private invite link. Select whether new alerts should be enabled and choose **Verify and save**.

The check calls `getMe`, `getChat`, and `getChatMember`. It does not send a probe to members. Public-channel links are derived from Telegram's returned username. For a private channel, an invite link is optional; the channel can receive alerts without a public join link.

Telegram channel creation is a user-only operation, not a Bot API method. Official reference: https://core.telegram.org/method/channels.createChannel . The bot can be added to an existing channel and given posting rights; it cannot create the channel for its owner.

## Server configuration

- Use `NITROUS_TELEGRAM_BOT_TOKEN` for a dedicated bot, or reuse `TELEGRAM_BOT_TOKEN` if the same platform bot is intentionally administering the new channel.
- Store bot secrets only in server environment variables. Never paste them into the channel form or make them `NEXT_PUBLIC_` variables.
- Channel settings live in the server-only `nitrous_telegram_settings` table. There is **no fallback** to `TELEGRAM_CHANNEL_ID` or any existing GENX/FLOW channel.
- Apply `scripts/sql/nitrous-telegram.sql` with the Nitrous release. The default row has alerts **disabled** and no channel assigned. The SQL creates no messages and performs no broker action.
- The Next.js server and Nitrous worker must use the intended bot credentials. An operator verifies the channel before enabling alerts.

## Worker integration

Import `publishNitrousTelegramEvent` from `src/lib/nitrous-telegram-store.ts`. Pass a service-role Supabase client and a validated event:

```ts
await publishNitrousTelegramEvent(db, {
  setupId: setup.id,
  kind: "setup", // setup | triggered | expired | invalidated | target_observed | stop_observed
  side: "buy",
  family: "trend_pullback", // trend_pullback | break_retest | range_reaction
  profile: "both", // slow_drip | nitrous | both
  occurredAt: new Date().toISOString(),
  expiresAt: setup.expiresAt,
  entryLow: setup.entryLow,
  entryHigh: setup.entryHigh,
  stop: setup.stop,
  target: setup.target,
});
```

Emit this once per original setup lifecycle transition, not once per customer copy. Use the immutable setup ID and original levels. `target_observed` and `stop_observed` are allowed only after the outcome engine establishes entry-first chronological evidence; the Telegram adapter does not perform trade grading. Do not infer an outcome from a disappearing position or a live quote alone.

Public posts include no member email, user ID, broker account ID, balance, order ID, position size, or account profit. A triggered setup is explicitly distinguished from a broker fill. Price observations are explicitly distinguished from realized account returns. Private account notifications, if added later, need a separate user-authorized destination.

## Delivery behavior

Before `sendMessage`, the worker inserts a unique claim keyed by channel, immutable setup ID, and event kind. Concurrent workers and repeated scans cannot send a second copy. If the HTTP request times out, Telegram may have already accepted it; the attempt is retained as `unknown` and never automatically retried. If the final audit write fails after a successful post, the original claim remains and still prevents duplicates.

Known 400/401/403 refusals mark channel status as needing attention. An operator must re-verify the bot/channel. The status endpoint never returns tokens or raw request errors. The Telegram UI never substitutes a fake channel link when setup is incomplete.

No stored trade or account consent is modified by configuring Telegram. Alert delivery is independent of trade execution. Delivery failure must not interrupt management of an existing position.

## Verification

Run `node --import tsx --test tests/nitrous-telegram.test.ts`. Tests use an in-memory durable-claim model and a mocked Telegram transport. They cover concurrent duplicates, uncertain network outcomes, unavailable storage, minimum public fields, invalid URLs, channel permissions, and truthful public status. They do not send Telegram messages or place trades.
