-- Pause billing on a plan (owner 11-02: "add a cancel button or a pause button for customers").
-- Stripe's pause_collection voids invoices while a subscription is paused and keeps the subscription
-- "active", so the member's row records when they paused and the end of the month they had paid for:
-- the plan is honoured up to paid_through and no further (src/lib/subscription.ts isActive).
-- Additive: two nullable columns; nothing existing changes meaning.
alter table public.user_subscriptions add column if not exists paused_at timestamptz;
alter table public.user_subscriptions add column if not exists paid_through timestamptz;
