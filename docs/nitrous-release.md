# Nitrous / Slow Drip

Member page: `/portal/nitrous`. The OM OS dock and home account summary link to it.

## Execution boundary

The new worker is `npm run nitrous-worker`. `NITROUS_WORKER=1` selects only the
`nitrous_*` tables and RPCs. The existing Rapid worker and its controls are unchanged.
Shared broker transport, deterministic structure code and sizing helpers are reused;
request-local `withNitrousDb` isolates their persistence. Nitrous has its own submission,
close dispatch, reconciliation and risk controls. Members can connect their own account
alongside the other tools currently on OM OS. Nitrous does not query retired product
registries or adopt positions from tags alone.

Connecting or reconnecting never activates automation. A member selects a real or demo
TradeLocker account, chooses a mode and supported risk preset, reviews the dollar risk,
then explicitly activates that account. Pausing stops new entries while previously owned
positions retain their saved management plan and broker-native stop/target.

## Version 1 behavior

- Gold only, with trend pullbacks and completed break/retest plans aligned with 1H/15M.
- Completed reference candles show the public plan; the account's own broker quote
  controls price, spread and final eligibility. Stale reference/H1 data blocks entries.
- Targets need at least $6 of current gold-price room and cap at $15, subject to opposing
  structure and modeled reward/risk. These are proposed parameters, not a proven edge.
- Slow Drip: 0.5% or 1% per trade; 3% daily loss allowance; up to 10 completed entries/day.
- Nitrous: 3% or 5% per trade; 15% daily loss allowance; up to 100 completed entries/day.
- The daily budget uses UTC days, survives reconnects and pauses, and cannot increase
  during a day. Profits do not replenish loss allowance. Risk limits are estimates;
  slippage, gaps and broker fees can increase actual loss.
- One owned position or unresolved intent per account. One entry per structure-zone
  version, side and UTC day; a 120-second cooldown after closure. No averaging down.
- Broker minimum size may exceed a small account's selected budget; that trade is skipped.
- Margin requires actual broker leverage, contract size, free margin and matching account/
  profit currency. A 20% equity reserve is retained. No guessed FX conversion or leverage.
- Sizing includes a $10/lot round-trip commission provision and adverse tick allowances;
  it is not a verified fee quote. Net P&L is shown only when broker net/fees are verified.
- Optional management moves a confirmed stop to entry plus the modeled fee allowance
  after the larger of $3 or the original stop distance has been gained. It does not widen
  a stop, average down, or place partial profit exits in this release.
- Manual and protection closes share a durable dispatch claim. Acknowledgement is not
  closure. Ambiguous entry/close results require broker reconciliation, not blind retry.
- Trading decisions are deterministic. No language model has authority to place an order.

## Results and alerts

Wins and losses come from exact broker opening/closing fill evidence. Calculated gross
P&L is labeled separately from broker-verified net. Unknown outcomes remain unresolved.
The public Telegram lifecycle is reference-market observation, never customer execution
or realized P&L. Same-candle stop/target ambiguity does not become a win.

Frozen public plans survive restarts in `nitrous_public_state`. Unused candle snapshots
expire after two days; snapshots referenced by execution intents remain available.

Telegram setup is documented in `docs/nitrous-telegram.md`. Channel creation requires a
Telegram user account; the bot can verify/post once an owner adds it as an administrator.

## Infrastructure and rollout

For a new installation, apply `scripts/sql/nitrous-schema.sql`,
`scripts/sql/nitrous-telegram.sql`, and `scripts/sql/nitrous-runtime-state.sql`.
The first migration starts global
control off and Telegram disabled, with no accounts copied or armed. All Nitrous tables
and functions are server-only; member routes enforce authenticated ownership.

Railway service `nitrous-worker` runs one replica from the release commit. Required
variables: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FLOW_ENC_KEY`,
`TWELVEDATA_API_KEY`; optional `NITROUS_TELEGRAM_BOT_TOKEN` or `TELEGRAM_BOT_TOKEN`.
Secrets stay in provider configuration. The website uses its existing Vercel project.

Verify fresh `nitrous-watchdog` and persisted reference candles, then make global
`nitrous_control.mode='live'` and `entries_paused=false` available to member activation.
Do not arm a member or place a live trade as a release test.

Run `npm run test:nitrous`, existing Rapid isolation/regression tests, the prebuild suite,
TypeScript, production build, and desktop/mobile UI checks. Broker mutations in tests
are simulated. A release check is not evidence of strategy profitability or a verified
live fill on every broker/server.

## Optional Nitrous add-on

Nitrous and Slow Drip share one **$19.99 USD/month** add-on. Platform administrators
grant complimentary access from **Approve Members → Grant Nitrous**. Removing a
complimentary grant does not create a charge; the member can opt into checkout.
An existing paid Nitrous subscription stops renewing before a complimentary grant
is saved. Suite, FLOW Pass, voice subscriptions, and credits remain independent.

Apply `scripts/sql/nitrous-addon.sql` and then
`scripts/sql/nitrous-addon-enforcement.sql`, followed by
`scripts/sql/nitrous-shared-accounts.sql`, before publishing the add-on release.
The migration grants no member access. Both the website and the dedicated Nitrous
worker must use the new release; the worker watchdog reports `addonEnforced: true`.

Paid access requires a verified paid invoice for the exact Nitrous subscription.
The checkout return URL cannot unlock access. Cancellation keeps access through
the verified paid period. Access expiry or removal blocks new entries and pauses
automation; a member must explicitly activate again after access is restored.
Account status, pause, refresh, and owned-position close controls remain available,
and existing positions continue their saved protection and management.

Reconciliation runs through `/api/cron/nitrous-addons-sync` every five minutes.
The administrator, billing, permission, and worker dispatch tests use mocked
providers; deployment validation does not purchase a subscription or place a trade.

## Accounts shared with current OM OS tools

Connecting or activating Nitrous is not blocked by a connection to another One Mission
tool. Accounts remain tied to their verified TradeLocker login and their owning member.
Linking another account does not activate it. New and existing Nitrous accounts support
sharing, with current broker equity and free margin still used for sizing.

Before a new order, Nitrous saves the existing broker position IDs with the intent. A
fill mapped to a pre-existing position is kept unresolved and is never adopted, amended,
or closed by Nitrous, even if the broker changed its tag. This guard also survives worker
restarts. FLOW and Atlas recovery exclude Nitrous-tagged positions; Atlas matches the
tag on the actual candidate row. Shared balance, margin and broker netting behavior are
not independent accounts. No broker-specific shared-account live fill was placed during
release testing.
