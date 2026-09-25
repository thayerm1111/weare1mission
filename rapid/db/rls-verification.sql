-- Two members, one account each, then prove the Data API cannot cross the boundary.
create role anon nologin;
create role authenticated nologin;
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

insert into public.rapid_broker_connections (id, user_id, environment, server, email_masked, enc_refresh)
values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','demo','SRV','a***@x.com','SECRET-TOKEN-A'),
       ('bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','demo','SRV','b***@x.com','SECRET-TOKEN-B');

insert into public.rapid_accounts (id, user_id, connection_id, broker_account_id, acc_num, environment, server, risk_pct)
values ('aaaaaaaa-1111-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','ACC-A','1','demo','SRV',0.5),
       ('bbbbbbbb-1111-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000002','ACC-B','2','demo','SRV',0.5);

insert into public.rapid_positions (account_id, user_id, broker_position_id, side, strategy_version, config_version, management_version, management_enabled, risk_pct, entry, original_qty, current_qty, initial_stop)
values ('aaaaaaaa-1111-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','POS-A','buy','v','c','m',true,0.5,4316,0.1,0.1,4310),
       ('bbbbbbbb-1111-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','POS-B','sell','v','c','m',true,0.5,4316,0.1,0.1,4322);

-- Impersonate member A.
create or replace function auth.uid() returns uuid language sql stable as $f$ select current_setting('request.jwt.claim.sub', true)::uuid $f$;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '1. accounts visible to member A (expect 1):'
select count(*) from public.rapid_accounts;
\echo '2. positions visible to member A (expect 1, POS-A):'
select broker_position_id from public.rapid_positions;
\echo '3. encrypted credentials readable (expect 0 rows - deny all):'
select count(*) from public.rapid_broker_connections;
\echo '4. execution leases readable (expect 0):'
select count(*) from public.rapid_leases;
\echo '5. risk reservations readable (expect 0):'
select count(*) from public.rapid_risk_reservations;
