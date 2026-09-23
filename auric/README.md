# AURIC — independent XAUUSD CFD automation for One Mission

Product identifier: `auric`. Route: `/auric`. API: `/api/auric/*`. Tables: `auric_*`.
Worker: Railway service `auric-engine` (`npm run auric-engine`). Strategy version: see `auric/config/defaults.ts`.

## Isolation map

AURIC is a clean-room package. `tests/auric-isolation.test.ts` fails the build if anything under `auric/`
imports GENX, FLOW, Command Center/ATLAS, OM AI Plays or Matty Pips code, or if any existing product file
imports from `auric/`.

| Concern | AURIC owns (new) | Shared interface consumed (read-only, unchanged) |
|---|---|---|
| Strategy | `auric/engine/*` | — |
| Broker | `auric/broker/tradelocker.ts` (own adapter, own token pair, own sessions in `auric_broker_sessions`) | `flow_broker_connections` is READ once, with explicit consent, to import credentials into `auric_broker_connections`; FLOW's refresh token is never used |
| Market data | `auric/market/*` (own Twelve Data client with its own budget, broker quotes as execution authority) | env `TWELVEDATA_API_KEY` |
| Execution | `auric/exec/*` + `auric_intents`, `auric_positions`, `auric_leases` | — |
| Credits | `auric_activate_session()` RPC | calls the existing `spend_credits_for()` RPC in the same transaction; wallet display uses `/api/credits` untouched |
| Auth | `/api/auric/*` handlers use `authedContext` / `createAdminClient` | `src/lib/supabase/*`, `profiles.role` |
| Nav | one additive link in `PortalNav` REG (`auric`) | `src/components/portal/PortalNav.tsx` (link only) |
| Design tokens | tailwind vars (`gold`, `navy`, `offwhite`, fonts) | `tailwind.config.ts` (no change) |

Nothing under `src/lib/flow`, `src/lib/genx*`, `command-center/`, `worker/`, `src/app/api/{flow,genx,command-center,om-*}` is modified.

## Account-level isolation

Software isolation does not isolate broker equity. Before a session can be activated the engine runs
`auric/exec/ownership.ts`:

1. Lists the broker account's open positions and pending orders.
2. If the same broker `account_id` is enabled in `flow_broker_accounts` (autotrade/genx_follower/manage_trades)
   or `cc_broker_accounts` (auto_trading) → the account is **shared**. AURIC then requires that the account be
   *hedging-capable* (verified by broker config) AND that no account-wide manager can touch AURIC positions.
   Because FLOW's `manageOpenPositions` manages every row in `flow_managed_positions` (only its own rows) and
   ATLAS reconciles `cc_positions` (its own rows), foreign positions are not modified by them — but *netting*
   accounts merge opposite sides. On a shared account AURIC therefore refuses activation and asks for a
   dedicated account/sub-account, unless the owner sets `allow_shared_account=true` on the account after
   reading the conflict explanation. Default: refuse.
3. AURIC positions are tagged with `strategyId = "AURIC:<intent_id>"` at the broker AND recorded in
   `auric_positions` with the broker position id. A position is AURIC-owned only if both agree; a comment
   string alone is never trusted.
4. AURIC never closes, modifies or cancels anything it does not own. Emergency close is scoped to AURIC ids.

## Process states
OBSERVING → SETUP_FORMING → TRIGGER_VALIDATED → RISK_CHECK → ORDER_SUBMITTED → POSITION_PROTECTED →
POSITION_MANAGED → TRADE_CLOSED, plus PAUSED. Every transition is written to `auric_events` by the worker
and the dashboard renders only what is recorded.
