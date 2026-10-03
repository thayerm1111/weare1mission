-- GEN FX — settling every order, and the commissioning hold (10-02 / 10-03).
--
-- Two additions, both additive, both already applied to project pguzevnkmpwfuzcjbcbx:
--   genfx_fills_settle    2026-10-02  the two columns and the index below
--   genfx_control_hold    2026-10-02  the guard at the bottom
--
-- 1. genfx_fills learns to say how far an order got and how many times it has been looked at.
--    status now runs  reserved → sending → placed → managed
--                                       ↘ uncertain / cancelled → managed | void
--    (src/lib/genfx/fills.ts). Everything that is not `managed` or `void` is unsettled, and an
--    unsettled row blocks a new GEN FX entry on the same account, pair and side — hence the index.
set local lock_timeout = '5s';
alter table public.genfx_fills
  add column if not exists checks integer not null default 0,   -- looks the settle pass has taken at this row
  add column if not exists note text;                           -- why it was written off, or why it is still held
create index if not exists genfx_fills_unsettled_idx on public.genfx_fills (account_id, pair)
  where status in ('reserved', 'sending', 'placed', 'uncertain', 'cancelled');

-- 2. THE COMMISSIONING HOLD. GEN FX's first version went live as a read tool while its order path was
--    still being reviewed. This makes "not yet" a fact of the database rather than a convention:
--    auto-trade, credits and Telegram cannot be switched on — from the owner panel, from SQL, from
--    anywhere — until the control row says the order path has been released:
--
--        update public.genfx_control set config = config || '{"released": true}'::jsonb where id = 1;
--
--    After that it never fires again. It is left in place on purpose: a fresh database built from
--    these migrations starts held, the same way production did.
create or replace function public.genfx_control_guard() returns trigger
language plpgsql set search_path to 'public' as $$
begin
  if (new.auto_enabled or new.billing_enabled or new.telegram_enabled)
     and coalesce(new.config->>'released', '') <> 'true' then
    raise exception 'GEN FX auto-trade, credits and Telegram are on hold until the order-path fixes are deployed';
  end if;
  return new;
end;
$$;
create or replace trigger genfx_control_guard before insert or update on public.genfx_control
  for each row execute function public.genfx_control_guard();
