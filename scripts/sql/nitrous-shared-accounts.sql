-- Owner policy: members may use their own TradeLocker accounts across One Mission tools.
-- This changes connection eligibility only; no account is armed and no broker order is sent.
alter table public.nitrous_accounts alter column allow_shared_account set default true;
update public.nitrous_accounts set allow_shared_account=true, updated_at=now()
where allow_shared_account=false;
