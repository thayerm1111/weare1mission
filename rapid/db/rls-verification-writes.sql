set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
\echo '6. member A tries to flip member B automation ON:'
update public.rapid_accounts set automation_enabled = true where broker_account_id = 'ACC-B';
\echo '7. member A tries to edit their OWN fill price:'
update public.rapid_positions set entry = 1 where broker_position_id = 'POS-A';
\echo '8. member A tries to insert an order intent directly:'
insert into public.rapid_intents (intent_key, account_id, user_id, visit_id, setup_id, strategy_version, config_version, management_version, family, side, planned_entry, planned_stop, planned_target, qty, risk_pct)
values ('forged','aaaaaaaa-1111-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','v','s','v','c','m','range_reaction','buy',4316,4310,4326,99,0.5);
