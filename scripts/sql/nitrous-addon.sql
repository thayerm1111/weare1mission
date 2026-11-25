-- Separate Nitrous add-on: complimentary admin grants or verified $19.99/month billing.
-- All state is server-only. This migration grants no member access and changes no billing.
create table if not exists public.nitrous_addon_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default false,
  granted_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create table if not exists public.nitrous_addon_subscriptions (
  stripe_subscription_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text,
  status text not null,
  current_period_end timestamptz,
  paid_through timestamptz,
  cancel_at_period_end boolean not null default false,
  billing_paused boolean not null default false,
  reconciliation_attempted_at timestamptz,
  checked_at timestamptz not null default now()
);
create index if not exists nitrous_addon_subscriptions_user on public.nitrous_addon_subscriptions(user_id, checked_at desc);
create index if not exists nitrous_addon_subscriptions_due on public.nitrous_addon_subscriptions(checked_at) where status not in ('canceled','incomplete_expired');
create table if not exists public.nitrous_addon_checkouts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  attempt_id uuid not null unique,
  stripe_session_id text unique,
  status text not null check (status in ('creating','open','complete','expired')),
  expires_at timestamptz not null,
  return_origin text not null,
  customer_email text,
  updated_at timestamptz not null default now()
);
create table if not exists public.nitrous_addon_billing_locks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  owner uuid not null,
  expires_at timestamptz not null
);
create table if not exists public.nitrous_addon_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('admin_granted','admin_revoked')),
  at timestamptz not null default now()
);
alter table public.nitrous_addon_grants enable row level security;
alter table public.nitrous_addon_subscriptions enable row level security;
alter table public.nitrous_addon_checkouts enable row level security;
alter table public.nitrous_addon_billing_locks enable row level security;
alter table public.nitrous_addon_events enable row level security;
revoke all on public.nitrous_addon_grants, public.nitrous_addon_subscriptions, public.nitrous_addon_checkouts,
  public.nitrous_addon_billing_locks, public.nitrous_addon_events from public, anon, authenticated;
grant select, insert, update, delete on public.nitrous_addon_grants, public.nitrous_addon_subscriptions,
  public.nitrous_addon_checkouts, public.nitrous_addon_billing_locks, public.nitrous_addon_events to service_role;
grant usage, select on sequence public.nitrous_addon_events_id_seq to service_role;

create or replace function public.nitrous_has_addon_access(p_user uuid)
returns boolean language sql stable security invoker set search_path = public as $$
  select exists(select 1 from public.nitrous_addon_grants where user_id=p_user and active)
    or exists(select 1 from public.nitrous_addon_subscriptions where user_id=p_user
      and status='active' and not billing_paused and paid_through>now());
$$;

create or replace function public.nitrous_acquire_addon_billing_lock(p_user uuid, p_owner uuid)
returns boolean language plpgsql security invoker set search_path = public as $$
begin
  insert into public.nitrous_addon_billing_locks(user_id,owner,expires_at)
    values(p_user,p_owner,now()+interval '120 seconds')
    on conflict(user_id) do update set owner=excluded.owner,expires_at=excluded.expires_at
    where nitrous_addon_billing_locks.expires_at<now();
  return found;
end;
$$;
create or replace function public.nitrous_release_addon_billing_lock(p_user uuid,p_owner uuid)
returns void language sql security invoker set search_path = public as $$
  delete from public.nitrous_addon_billing_locks where user_id=p_user and owner=p_owner;
$$;

-- A slower, earlier Stripe read cannot overwrite a newer reconciliation result.
create or replace function public.nitrous_store_addon_subscription(p_row jsonb)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if exists(select 1 from public.nitrous_addon_subscriptions where stripe_subscription_id=p_row->>'stripe_subscription_id'
    and user_id<>(p_row->>'user_id')::uuid) then raise exception 'subscription_owner_mismatch'; end if;
  insert into public.nitrous_addon_subscriptions(stripe_subscription_id,user_id,stripe_customer_id,status,
    current_period_end,paid_through,cancel_at_period_end,billing_paused,checked_at)
  values(p_row->>'stripe_subscription_id',(p_row->>'user_id')::uuid,p_row->>'stripe_customer_id',p_row->>'status',
    (p_row->>'current_period_end')::timestamptz,(p_row->>'paid_through')::timestamptz,
    (p_row->>'cancel_at_period_end')::boolean,(p_row->>'billing_paused')::boolean,(p_row->>'checked_at')::timestamptz)
  on conflict(stripe_subscription_id) do update set
    stripe_customer_id=excluded.stripe_customer_id,status=excluded.status,current_period_end=excluded.current_period_end,
    paid_through=greatest(nitrous_addon_subscriptions.paid_through,excluded.paid_through),
    cancel_at_period_end=excluded.cancel_at_period_end,billing_paused=excluded.billing_paused,checked_at=excluded.checked_at
  where excluded.checked_at>=nitrous_addon_subscriptions.checked_at;
end;
$$;

create or replace function public.nitrous_set_addon_grant(p_user uuid,p_enabled boolean,p_actor uuid,p_lock_owner uuid)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin') then raise exception 'admin_required'; end if;
  if not exists(select 1 from public.nitrous_addon_billing_locks where user_id=p_user and owner=p_lock_owner and expires_at>now())
    then raise exception 'billing_lock_expired'; end if;
  insert into public.nitrous_addon_grants(user_id,active,granted_by,updated_at)
    values(p_user,p_enabled,p_actor,now()) on conflict(user_id) do update
    set active=excluded.active,granted_by=excluded.granted_by,updated_at=excluded.updated_at;
  insert into public.nitrous_addon_events(user_id,actor_id,action)
    values(p_user,p_actor,case when p_enabled then 'admin_granted' else 'admin_revoked' end);
  if not p_enabled and not public.nitrous_has_addon_access(p_user) then
    update public.nitrous_accounts set automation_enabled=false,automation_version=automation_version+1,
      execution_block_reason='Nitrous add-on access is required for new entries.',updated_at=now()
      where user_id=p_user and automation_enabled;
  end if;
end;
$$;

revoke all on function public.nitrous_has_addon_access(uuid), public.nitrous_acquire_addon_billing_lock(uuid,uuid),
  public.nitrous_release_addon_billing_lock(uuid,uuid), public.nitrous_store_addon_subscription(jsonb),
  public.nitrous_set_addon_grant(uuid,boolean,uuid,uuid) from public, anon, authenticated;
grant execute on function public.nitrous_has_addon_access(uuid), public.nitrous_acquire_addon_billing_lock(uuid,uuid),
  public.nitrous_release_addon_billing_lock(uuid,uuid), public.nitrous_store_addon_subscription(jsonb),
  public.nitrous_set_addon_grant(uuid,boolean,uuid,uuid) to service_role;
