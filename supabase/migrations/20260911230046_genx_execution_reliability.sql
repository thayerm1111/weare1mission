-- One lifetime partial-close reservation per broker position, shared by all workers.
-- Apply before deploying consumers. No automatic expiry: delayed broker requests can
-- execute after a timeout. A rejected/pending operation requires broker reconciliation.
create table public.flow_partial_operations (
  environment text not null check (environment in ('demo', 'live')),
  account_id text not null,
  position_id text not null,
  before_qty numeric not null check (before_qty > 0),
  requested_qty numeric not null check (requested_qty > 0 and requested_qty < before_qty),
  created_at timestamptz not null default now(),
  primary key (environment, account_id, position_id)
);
alter table public.flow_partial_operations enable row level security;
revoke all on public.flow_partial_operations from public, anon, authenticated;
grant select, insert on public.flow_partial_operations to service_role;
comment on table public.flow_partial_operations is 'Durable partial-close reservations; existence prevents redispatch even after a crash. Never delete without broker reconciliation.';
