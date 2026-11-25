-- Server-only queue for explicitly requested Telegram connection tests.
create table if not exists public.nitrous_telegram_tests (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null,
  bot_id bigint not null,
  state text not null default 'queued' check (state in ('queued','sending','sent','refused','unknown')),
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  resolved_at timestamptz,
  message_id bigint,
  error_code text
);
create index if not exists nitrous_telegram_tests_queue on public.nitrous_telegram_tests (state, requested_at);
alter table public.nitrous_telegram_tests enable row level security;
revoke all on public.nitrous_telegram_tests from public, anon, authenticated;
grant select, insert, update on public.nitrous_telegram_tests to service_role;
