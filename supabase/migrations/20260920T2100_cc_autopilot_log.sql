-- THE BRAIN'S AUTONOMOUS DECISIONS, WRITTEN DOWN.
--
-- Every decision the Command Center autopilot makes lands here, whether it reached the broker or not.
-- That is the whole point of shadow mode: after a week of `CC_AUTOPILOT=shadow` this table answers
-- "would it have made money?" with rows rather than with an opinion, and it keeps answering it once
-- the mode is live.
--
-- It is written best-effort and read by nothing that gates a trade. A logging failure must never stop
-- an order, and must never cause one either.

create table if not exists public.cc_autopilot_log (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),

  user_id         uuid not null,
  account_row_id  uuid not null,
  acc_num         text,

  -- off | shadow | live, as it was at the moment of the decision.
  mode            text not null,
  -- true only when an order was actually sent. The daily cap counts these.
  acted           boolean not null default false,
  -- placed | shadow | refused | blocked | capped | error
  outcome         text not null,
  reason          text,

  side            text,
  style           text,
  entry           double precision,
  stop            double precision,
  target          double precision,
  -- Gold's price at the instant of the decision, so the call can be scored later.
  price_at        double precision
);

-- The two reads this table actually gets: the daily cap (per account, acted, today) and the
-- human question "what has it been doing?" (per user, newest first).
create index if not exists cc_autopilot_log_cap_idx
  on public.cc_autopilot_log (account_row_id, acted, created_at desc);
create index if not exists cc_autopilot_log_user_idx
  on public.cc_autopilot_log (user_id, created_at desc);

alter table public.cc_autopilot_log enable row level security;

-- A member may read what the autopilot did on their own accounts, and nothing else. Writes come from
-- the worker on the service role, which bypasses RLS.
drop policy if exists cc_autopilot_log_own_select on public.cc_autopilot_log;
create policy cc_autopilot_log_own_select
  on public.cc_autopilot_log for select
  using (auth.uid() = user_id);
