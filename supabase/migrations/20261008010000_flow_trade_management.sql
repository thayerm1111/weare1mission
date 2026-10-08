-- FLOW TRADE MANAGEMENT — the member picks it (owner 10-08: "Let's change from AI PIPs to picking
-- breakeven, AI management (follow price and taking partials), giving the customer the opportunity to
-- tweak how they want the AI to trade").
--
--   Break-even    be_enabled + gold_be_pips (both already here): off, or 20/30/40/50 gold pips.
--   Follow price  trail_mode (new): off / tight / normal / loose.
--   Partials      partial_pct (new): 0 / 25 / 50 — banked halfway to the trade's target.
--
-- Every account starts EXACTLY where it is today (owner: "exactly what they have today"). AI Pips
-- (manage_trades) on meant break-even at the account's own pips, the reversal snap and the trail, and
-- no partials; off meant nothing was touched. So:
--   manage_trades on  → be_enabled true,  trail_mode 'normal', partial_pct 0
--   manage_trades off → be_enabled false, trail_mode 'off',    partial_pct 0
-- gold_be_pips is left exactly as it is. be_enabled is rewritten because 27 AI-Pips-on accounts still
-- carry a false from before 09-22, when it stopped being read — the manager reads it again from now.
-- Only rows that have never been on the new settings (trail_mode null) are touched — and every change a
-- member saves writes trail_mode — so running this again can never undo a member's choice.
--
-- ORDER: applied after 20261008005900_flow_partial_record.sql, and after the code that reads these
-- columns is live on the site AND the worker. Until then that code reads the old columns (a missing
-- column is the one read failure it answers with fewer columns), so nothing a member does in between is
-- lost: this backfill runs over it.
--
-- manage_trades becomes the SUMMARY of the three for every row on these settings (trail_mode set): on
-- while break-even or a partial is on. A trigger keeps it so on every write — two saves landing together,
-- a script, a hand edit — because the screens' card buttons, the RAPID ownership check and the trade
-- labels still read it. To stop all management of an account: be_enabled = false, partial_pct = 0.
--
-- A 5-second lock wait at most: the table is read on every pass of the trade manager, so the change
-- gives up rather than hold those reads (run it again).

set lock_timeout = '5s';

alter table public.flow_broker_accounts
  add column if not exists trail_mode text,
  add column if not exists partial_pct smallint;

alter table public.flow_broker_accounts drop constraint if exists flow_broker_accounts_trail_mode_check;
alter table public.flow_broker_accounts add constraint flow_broker_accounts_trail_mode_check
  check (trail_mode is null or trail_mode in ('off', 'tight', 'normal', 'loose'));

alter table public.flow_broker_accounts drop constraint if exists flow_broker_accounts_partial_pct_check;
alter table public.flow_broker_accounts add constraint flow_broker_accounts_partial_pct_check
  check (partial_pct is null or partial_pct in (0, 25, 50));

update public.flow_broker_accounts set
  be_enabled = (manage_trades is distinct from false),
  trail_mode = case when manage_trades is false then 'off' else 'normal' end,
  partial_pct = 0
where trail_mode is null;

create or replace function public.flow_accounts_derive_manage()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.trail_mode is not null then
    new.manage_trades := (new.be_enabled is distinct from false) or coalesce(new.partial_pct, 0) > 0;
  end if;
  return new;
end;
$$;

drop trigger if exists flow_accounts_derive_manage on public.flow_broker_accounts;
create trigger flow_accounts_derive_manage
  before insert or update on public.flow_broker_accounts
  for each row execute function public.flow_accounts_derive_manage();

comment on column public.flow_broker_accounts.manage_trades is
  'For a row with trail_mode set: derived (trigger flow_accounts_derive_manage) — true while be_enabled or partial_pct > 0. To stop all management of an account set be_enabled = false and partial_pct = 0. For a row with trail_mode null: the AI Pips switch of 09-22.';

reset lock_timeout;
