-- PROFIT GUARD (owner 09-17): opt-in, per account. When gold's structure flips against an open trade
-- that is already >= 1R and >= 50 pips in profit, the trade manager snaps the stop just behind the
-- market instead of leaving it 0.6R behind the peak. Default false — nobody's exits change until the
-- member turns it on.
alter table public.flow_broker_accounts add column if not exists profit_guard boolean not null default false;
