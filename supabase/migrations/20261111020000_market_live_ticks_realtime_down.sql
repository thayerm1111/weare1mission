-- Undo 20261111020000_market_live_ticks_realtime.sql: market_live_ticks goes back to server-only (row level
-- security on, no policies) and out of the Realtime publication. The screen falls back to polling
-- /api/command-center/tick, which it already does whenever Realtime is not delivering.
--
-- The table-level SELECT grant to `authenticated` is left as it was: it is Supabase's default for public tables,
-- and with row level security on and no policy it returns no rows.
drop policy if exists market_live_ticks_gold_read on public.market_live_ticks;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'market_live_ticks'
  ) then
    execute 'alter publication supabase_realtime drop table public.market_live_ticks';
  end if;
end $$;
