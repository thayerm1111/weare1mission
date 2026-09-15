-- Floor stats from REAL trades (owner 09-15): every GENX trade fired to an account records
-- how that account was set to manage it, at the moment it fired, so the Floor can show what
-- each management style actually produced on real accounts.
--
--   be_on    — manager on, break-even on (default)
--   be_off   — manager on, break-even toggle off
--   play_out — manager off (manage_trades=false): original stop/target left to play out
--
-- "Self manage" is not a setting: it is any trade the member closed by hand, read from
-- outcome = 'manual' when the trade resolves.
--
-- Additive only. Existing rows keep manage_style NULL, so the Floor's real-trade record
-- starts fresh from this migration. The trigger never blocks an insert.

alter table public.flow_managed_positions add column if not exists manage_style text;

create or replace function public.flow_positions_snapshot_manage_style()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_manage boolean;
  v_be     boolean;
begin
  if new.manage_style is null then
    begin
      select manage_trades, be_enabled into v_manage, v_be
        from public.flow_broker_accounts
       where account_id = new.account_id
       limit 1;
      new.manage_style := case
        when v_manage is false then 'play_out'
        when v_be is false     then 'be_off'
        else 'be_on'
      end;
    exception when others then
      new.manage_style := null;  -- never block a trade record over a stats label
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists flow_positions_manage_style on public.flow_managed_positions;
create trigger flow_positions_manage_style
  before insert on public.flow_managed_positions
  for each row execute function public.flow_positions_snapshot_manage_style();

create index if not exists flow_managed_positions_gold_style_idx
  on public.flow_managed_positions (symbol, created_at desc)
  where manage_style is not null;
