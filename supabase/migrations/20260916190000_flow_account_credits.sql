-- FLOW billing per connected account (owner 09-16: "everyone has to use a credit to use flow and when
-- it's watching it pulls credits" — per account, Suite subscribers included). Additive only.
alter table public.flow_broker_accounts add column if not exists flow_last_credit_at timestamptz;
alter table public.flow_broker_accounts add column if not exists flow_credit_paused boolean not null default false;
