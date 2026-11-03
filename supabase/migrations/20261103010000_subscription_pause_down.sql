alter table public.user_subscriptions drop column if exists paid_through;
alter table public.user_subscriptions drop column if exists paused_at;
