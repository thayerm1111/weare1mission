-- Dedicated, server-only Nitrous Telegram configuration and durable delivery claims.
-- Run with the Nitrous release migration. This does not enable or send any messages.
create table if not exists public.nitrous_telegram_settings (
  id smallint primary key check (id = 1),
  telegram_channel_id text,
  telegram_channel_url text,
  telegram_enabled boolean not null default false,
  telegram_verified_at timestamptz,
  telegram_channel_title text,
  telegram_bot_id bigint,
  telegram_last_error text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint nitrous_telegram_verified_before_enable check (
    not telegram_enabled or (telegram_channel_id is not null and telegram_verified_at is not null and telegram_bot_id is not null)
  )
);

create table if not exists public.nitrous_telegram_deliveries (
  event_key text primary key,
  setup_id text not null,
  event_kind text not null check (event_kind in ('setup','triggered','expired','invalidated','target_observed','stop_observed')),
  channel_id text not null,
  state text not null check (state in ('sending','sent','refused','unknown')),
  message_id bigint,
  error_code text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists nitrous_telegram_delivery_state_time on public.nitrous_telegram_deliveries (state, created_at desc);

alter table public.nitrous_telegram_settings enable row level security;
alter table public.nitrous_telegram_deliveries enable row level security;
revoke all on public.nitrous_telegram_settings from public, anon, authenticated;
revoke all on public.nitrous_telegram_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.nitrous_telegram_settings to service_role;
grant select, insert, update, delete on public.nitrous_telegram_deliveries to service_role;

insert into public.nitrous_telegram_settings (id) values (1) on conflict (id) do nothing;
