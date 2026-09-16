-- Transition logging must run AFTER the row exists (FK to genx3_setups). The guard stays BEFORE.
create or replace function public.genx3_setup_guard() returns trigger language plpgsql as $$
declare ord_from int; ord_to int;
begin
  if tg_op = 'UPDATE' then
    if new.setup_id <> old.setup_id or new.setup_key <> old.setup_key or new.strategy_version <> old.strategy_version
       or new.side <> old.side or new.setup_type <> old.setup_type then
      raise exception 'genx3_setups identity fields are immutable';
    end if;
    if new.state = old.state then return new; end if;
    if old.state in ('PUBLISHED','EXPIRED','INVALIDATED','REJECTED_BY_FLOW') and not (old.state = 'PUBLISHED' and new.state = 'REJECTED_BY_FLOW') then
      raise exception 'genx3 setup % is terminal (%), cannot move to %', old.setup_id, old.state, new.state;
    end if;
    ord_from := array_position(array['WAIT','WATCHING','APPROACHING','ARMED','TRIGGERED','PUBLISHED'], old.state);
    ord_to   := array_position(array['WAIT','WATCHING','APPROACHING','ARMED','TRIGGERED','PUBLISHED'], new.state);
    if new.state = 'PUBLISHED' and old.state <> 'TRIGGERED' then
      raise exception 'genx3 setup can only be PUBLISHED from TRIGGERED (was %)', old.state;
    end if;
    if ord_to is not null and ord_from is not null and ord_to <= ord_from then
      raise exception 'genx3 setup cannot move backwards % -> %', old.state, new.state;
    end if;
    new.state_at := now();
  end if;
  return new;
end $$;

create or replace function public.genx3_setup_log() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.state <> old.state then
    insert into public.genx3_setup_transitions (setup_id, from_state, to_state, snapshot_id, reason)
    values (new.setup_id, case when tg_op = 'UPDATE' then old.state end, new.state, new.snapshot_id, new.detail->>'transition_reason');
  end if;
  return null;
end $$;
drop trigger if exists genx3_setup_log on public.genx3_setups;
create trigger genx3_setup_log after insert or update on public.genx3_setups for each row execute function public.genx3_setup_log();
