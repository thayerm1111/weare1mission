-- GEN FX — orders known by their label, and two rules moved into the database (10-03).
--
-- Additive, and already applied to project pguzevnkmpwfuzcjbcbx as `genfx_order_labels`.
--
-- The second review of the order path found that a fill was being recognised by pair, side and size
-- alone — so a member's own trade of the same size could be taken for GEN FX's. Every GEN FX order now
-- carries a label (the broker's strategyId) and is recognised by it or by its order id, never by size
-- (src/lib/genfx/fills.ts). The row remembers the label, how many full looks have found no trace of the
-- order, when its cancel was confirmed, when it is next due a look, and how often the stop on a
-- late-adopted position has failed to confirm.
set local lock_timeout = '5s';

alter table public.genfx_fills add column if not exists tag text;
alter table public.genfx_fills add column if not exists clean integer not null default 0;
alter table public.genfx_fills add column if not exists cancelled_at timestamptz;
alter table public.genfx_fills add column if not exists next_check_at timestamptz not null default now();
alter table public.genfx_fills add column if not exists protect_tries integer not null default 0;

-- The books pass takes rows by when they are next due, so a row that cannot be settled backs off
-- without crowding out a fresh one.
create index if not exists genfx_fills_due_idx on public.genfx_fills (next_check_at)
  where status in ('reserved', 'sending', 'placed', 'uncertain', 'cancelled');

-- ONE UNSETTLED GEN FX ORDER PER ACCOUNT, PAIR AND SIDE. Placement checks before it claims; this makes
-- the claim itself fail if another call got there between the check and the write.
create unique index if not exists genfx_fills_one_unsettled on public.genfx_fills (account_id, pair, side)
  where status in ('reserved', 'sending', 'placed', 'uncertain', 'cancelled');

-- ONE GEN FX LEDGER ROW PER BROKER POSITION. The ledger has no unique key on (account, position) — it
-- holds 188 duplicated pairs from before — so this one is partial: it binds GEN FX's rows only and
-- leaves every other row, and every other writer, exactly as it was.
create unique index if not exists flow_managed_positions_genfx_position_uidx on public.flow_managed_positions (account_id, position_id)
  where strategy_version = 'genfx-1.0' and position_id is not null;

comment on column public.genfx_fills.tag is 'The label sent with the order (TradeLocker strategyId). GEN FX recognises its own orders and positions by this, never by size.';
