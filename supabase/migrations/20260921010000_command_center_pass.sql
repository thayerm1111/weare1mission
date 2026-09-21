-- Command Center access: 5 credits opens it for 30 minutes (owner 09-21). See src/lib/ccPass.ts.
insert into public.credit_tariffs (feature, cost) values ('command_center', 5)
  on conflict (feature) do update set cost = excluded.cost;
