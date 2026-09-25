\set ON_ERROR_STOP on
insert into auth.users (id) values ('33333333-3333-3333-3333-333333333333') on conflict do nothing;
insert into public.rapid_broker_connections (id, user_id, environment, server, email_masked)
values ('cccccccc-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','demo','SRV','c***@x.com') on conflict do nothing;
insert into public.rapid_accounts (id, user_id, connection_id, broker_account_id, acc_num, environment, server, automation_enabled, automation_version)
values ('cccccccc-1111-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','cccccccc-0000-0000-0000-000000000003','ACC-C','3','demo','SRV',true,7) on conflict do nothing;

\echo '=== worker-A acquires (expect fence 1, acquired t) ==='
select * from rapid_acquire_lease('cccccccc-1111-0000-0000-000000000003','worker-A',15000);
\echo '=== worker-B tries while A holds it (expect acquired f) ==='
select * from rapid_acquire_lease('cccccccc-1111-0000-0000-000000000003','worker-B',15000);
\echo '=== A re-acquires: same fence, no spurious handover ==='
select * from rapid_acquire_lease('cccccccc-1111-0000-0000-000000000003','worker-A',15000);
\echo '=== the lease expires, B takes over: fence MUST advance ==='
update public.rapid_leases set expires_at = now() - interval '1 second' where account_id='cccccccc-1111-0000-0000-000000000003';
select * from rapid_acquire_lease('cccccccc-1111-0000-0000-000000000003','worker-B',15000);
\echo '=== stale worker-A tries to extend with fence 1 (expect f) ==='
select rapid_extend_lease('cccccccc-1111-0000-0000-000000000003','worker-A',1,15000);
\echo '=== current owner B extends with fence 2 (expect t) ==='
select rapid_extend_lease('cccccccc-1111-0000-0000-000000000003','worker-B',2,15000);

\echo '=== stale worker-A tries to create an intent with fence 1 (expect refused) ==='
select created, reason from rapid_reserve_intent('k1','cccccccc-1111-0000-0000-000000000003','33333333-3333-3333-3333-333333333333',null,'v1','s1',null,'matty_rapid_v1','c','m','range_reaction','buy',4316,4310,4326,0.1,0.5,50,4315.9,4316.1,80,0.2,7,1,'RAPID:k1');
\echo '=== owner B creates the intent with fence 2 (expect created) ==='
select created, reason from rapid_reserve_intent('k1','cccccccc-1111-0000-0000-000000000003','33333333-3333-3333-3333-333333333333',null,'v1','s1',null,'matty_rapid_v1','c','m','range_reaction','buy',4316,4310,4326,0.1,0.5,50,4315.9,4316.1,80,0.2,7,2,'RAPID:k1');
\echo '=== the SAME economic visit again (expect not created, dedupe) ==='
select created, reason from rapid_reserve_intent('k1','cccccccc-1111-0000-0000-000000000003','33333333-3333-3333-3333-333333333333',null,'v1','s1',null,'matty_rapid_v1','c','m','range_reaction','buy',4316,4310,4326,0.1,0.5,50,4315.9,4316.1,80,0.2,7,2,'RAPID:k1');
\echo '=== a DIFFERENT visit while one is live (expect refused: one position per account) ==='
select created, reason from rapid_reserve_intent('k2','cccccccc-1111-0000-0000-000000000003','33333333-3333-3333-3333-333333333333',null,'v2','s2',null,'matty_rapid_v1','c','m','break_retest','buy',4316,4310,4326,0.1,0.5,50,4315.9,4316.1,80,0.2,7,2,'RAPID:k2');
\echo '=== automation switched off after the decision (version bumped) ==='
update public.rapid_intents set state='closed' where intent_key='k1';
update public.rapid_accounts set automation_version = 8 where id='cccccccc-1111-0000-0000-000000000003';
select created, reason from rapid_reserve_intent('k3','cccccccc-1111-0000-0000-000000000003','33333333-3333-3333-3333-333333333333',null,'v3','s3',null,'matty_rapid_v1','c','m','break_retest','buy',4316,4310,4326,0.1,0.5,50,4315.9,4316.1,80,0.2,7,2,'RAPID:k3');
\echo '=== risk reservation recorded exactly once ==='
select count(*) as reservations, sum(amount) as held from public.rapid_risk_reservations;
