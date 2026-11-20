-- THE FLOOR — the selected account's Balance and Equity as the broker reports them (owner 11-20:
-- "display the selected connected account's balance and equity").
--
-- flow_broker_accounts.balance is written when an account is connected and almost never again, its
-- updated_at moves whenever a setting is saved, and equity has never been stored there. So the reading
-- The Floor shows gets a table of its own: what the broker said about ONE account, and WHEN it said it.
-- One row per member's account per environment (Live and Demo are never the same row), replaced by each
-- new reading.
--
-- Display only: nothing on a trading path reads or writes this table, and it is deliberately NOT a set
-- of columns on flow_broker_accounts — the executor, the trade manager and sizing read that table, and
-- showing a number must not be able to touch a row a trade depends on.
-- Server-side only: row level security is on with no policies, so only the service role reads or writes
-- (the authenticated route reads it for the signed-in member's own account).
--
-- Additive and reversible (20261120150000_floor_account_state_down.sql). The code runs without it:
-- it then keeps each reading in memory only (src/lib/floor/accountState.ts).
create table if not exists public.floor_account_state (
  user_id     uuid not null references auth.users(id) on delete cascade,
  environment text not null check (environment in ('live', 'demo')),
  account_id  text not null,
  balance     numeric,
  equity      numeric,
  open_pl     numeric,                       -- the broker's open profit and loss on the whole account
  positions   integer,                       -- positions the broker holds open on the account
  read_at     timestamptz not null,          -- when the broker gave these figures
  primary key (user_id, environment, account_id)
);

alter table public.floor_account_state enable row level security;
-- No policies: service role only.
