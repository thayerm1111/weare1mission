-- THE GOLD TICK, PUSHED TO THE SCREEN (owner 11-11: "Implement actual streaming quotes when supported …
-- Handle provider rate limits and efficient server-side fan-out").
--
-- The worker holds ONE Twelve Data WebSocket and upserts the newest XAU/USD tick into market_live_ticks about
-- once a second (worker/priceStream.ts). Until now only the server could read that row (row level security
-- on, no policies), so the Command Center screen saw a price up to five seconds old between polls.
--
-- This lets the browser HEAR the row change through Supabase Realtime (postgres_changes), so one provider
-- connection fans out to every viewer with no extra provider calls (src/components/command-center/hud/
-- useLiveFeed.ts). Realtime applies row level security to every change it sends, so the policy below is what
-- a member's session can receive:
--   * SELECT only, for signed-in members (`authenticated`). Nobody gains insert, update or delete: the worker
--     keeps writing with the service role, which row security does not apply to. `anon` gets nothing.
--   * The gold row only (symbol = 'XAU/USD'). Any other symbol the stream might publish later stays server-only.
--   * The row holds a public market price and its timestamps — no member data. The Command Center pass is
--     still enforced where the screen gets its data (/api/command-center/live and /tick), and the screen only
--     subscribes once /tick has answered for this member.
--
-- Default replica identity is enough: an UPDATE event carries the full new row, which is all the screen reads.
-- Idempotent: safe to run twice.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.market_live_ticks';
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- Supabase grants table privileges to `authenticated` by default; said explicitly so Realtime delivery does not
-- depend on project defaults. Row security (below) still decides which rows.
grant select on table public.market_live_ticks to authenticated;

drop policy if exists market_live_ticks_gold_read on public.market_live_ticks;
create policy market_live_ticks_gold_read on public.market_live_ticks
  for select to authenticated
  using (symbol = 'XAU/USD');
