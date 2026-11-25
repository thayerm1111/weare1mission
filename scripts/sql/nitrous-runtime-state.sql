-- Keep the frozen public plans in one durable row, not copied into every candle snapshot.
create table if not exists public.nitrous_public_state (
  id smallint primary key default 1 check(id=1),
  setups jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.nitrous_public_state enable row level security;
revoke all on public.nitrous_public_state from public,anon,authenticated;
grant select,insert,update,delete on public.nitrous_public_state to service_role;

create index if not exists nitrous_intent_snapshot on public.nitrous_intents(snapshot_id);
create or replace function public.nitrous_prune_context()
returns bigint language plpgsql security definer set search_path=public as $$
declare removed bigint;
begin
  -- Execution evidence stays attached to its intent indefinitely. Only unused chart context ages out.
  delete from public.nitrous_snapshots s
   where s.created_at<now()-interval '2 days'
     and not exists(select 1 from public.nitrous_intents i where i.snapshot_id=s.snapshot_id);
  get diagnostics removed=row_count;
  return removed;
end $$;
revoke all on function public.nitrous_prune_context() from public,anon,authenticated;
grant execute on function public.nitrous_prune_context() to service_role;
