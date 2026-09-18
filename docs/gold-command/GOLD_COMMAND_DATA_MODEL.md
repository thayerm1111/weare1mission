# DATA MODEL

Existing tables are reused wherever they already carry the right meaning. New tables are added only where
the specification needs state that has nowhere to live today.

## Existing (reused as-is)

| Table | Rows (09-18) | Role |
| --- | --- | --- |
| `flow_broker_connections` | 263 | Encrypted broker logins, per user |
| `flow_broker_accounts` | 433 | Accounts, automation flags, risk %, styles, profit guard |
| `flow_managed_positions` | 8,368 | The position ledger: entry, stops, qty, outcome, result |
| `flow_trade_log` | 48,496 | Flight recorder: every phase of every trade |
| `flow_auto_events` | 18,437 | Fan-out decisions and visible skip reasons |
| `flow_partial_operations` | 176 | Lifetime partial reservation per position |
| `flow_place_claims` | 136 | Durable placement claim (duplicate protection) |
| `genx_alerts` | 536 | Setup lifecycle: forming → entered → resolved |
| `genx_signals` | 1,707 | Full engine read per analysis (the member-facing history) |
| `genx_candle_archive` | 869,148 | 1-minute gold, Sep 2024 → today |
| `genx_style_setups` | new | Rapid / Structure / Swing shadow record with grading |
| `flow_billing_events` | new | One charge per member per event (setup / trade) |
| `user_credits`, `credit_transactions` | 483 / 24,201 | Credit balances and ledger |

## New tables required by this specification

```sql
-- One row per trade, carrying the reason it was taken and what would kill it.
trade_theses(id, position_id, user_id, account_id, strategy, mode, direction,
             reason, expected, invalidation, follow_through_window_s,
             entry_regime, entry_structure, entry_pressure, entry_volatility,
             snapshot_version, model_version, strategy_version, created_at)

-- The execution state machine, persisted. Never inferred from logs afterwards.
execution_states(id, decision_id, execution_id, user_id, account_id, state, prev_state,
                 reason, broker_order_id, broker_position_id, at)

-- Continuous position health with attributable causes.
position_health(id, position_id, at, score, prev_score, drivers jsonb, note)

-- What the market looked like when a decision was made (replay + no-leak guarantee).
market_snapshots(id, at, snapshot_version, price, bid, ask, spread, feed_health,
                 timeframes jsonb, structure jsonb, levels jsonb, pressure jsonb,
                 regime text, session text, news jsonb, cross_market jsonb)

-- Account guard rails, including prop-firm constraint objects.
risk_profiles(user_id, account_id, risk_pct, max_open_risk_pct, max_daily_loss_pct,
              max_daily_dd_pct, max_weekly_loss_pct, max_consecutive_losses,
              max_trades_per_session, max_open_positions, cooldown_s, spread_limit,
              news_lockout_s, min_equity, updated_by, updated_at)
account_constraints(user_id, account_id, kind, rules jsonb, source, updated_at)

-- Granular permissions, independently switchable.
account_permissions(user_id, account_id, allow_entries, allow_close, allow_partial,
                    allow_stop_move, allow_break_even, allow_tp_move, allow_trailing,
                    allow_choch_exit, allow_pending, allow_scale_in, allow_scale_out,
                    updated_at)

-- What the trader taught, in their own words, never discarded.
trader_lessons(id, user_id, original_text, structured jsonb, kind, timeframes text[],
               strategies text[], regimes text[], sessions text[], modes text[],
               priority int, active bool, expires_at, version, created_at)

-- Outcome evaluation beyond win/loss.
trade_evaluations(position_id, entry_quality, stop_quality, be_timing, partial_value,
                  exit_quality, mfe_pips, mae_pips, realized_r, after_exit_pips,
                  management_verdict, notes, evaluated_at)

-- Immutable audit of every automated action.
audit_events(id, at, user_id, account_id, actor, action, reason, price,
             snapshot_version, model_version, strategy_version,
             risk_before jsonb, risk_after jsonb, api_result jsonb, final_state)
```

## Rules

- **RLS on every table.** A member reads only their own rows; the service role is the only writer for
  execution paths.
- **Append-only where it matters.** `audit_events`, `flow_trade_log`, `execution_states` are never updated
  in place, only appended.
- **Versioned everything.** Any row that influenced a trade records `snapshot_version`, `model_version`
  and `strategy_version`, so an outcome can always be traced to the exact logic that produced it.
- **Retention.** Tick-level data is aggregated after 7 days; snapshots after 90; trade rows are kept
  indefinitely. Trade history is never deleted — a stats reset moves a cursor, it does not erase.
