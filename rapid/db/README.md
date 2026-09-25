# Rapid schema verification

The migration is `supabase/migrations/20260925120000_rapid.sql`, rollback `..._rapid_down.sql`.

It has been exercised against a real PostgreSQL 16 cluster rather than eyeballed:

```bash
PGBIN=/usr/lib/postgresql/16/bin
initdb -D data -U claude -A trust
pg_ctl -D data -o '-k . -p 5455 -c listen_addresses=' start
# stubs: create schema auth; auth.users(id uuid); auth.uid(); create publication supabase_realtime;
psql -f supabase/migrations/20260925120000_rapid.sql      # applies clean
psql -f supabase/migrations/20260925120000_rapid.sql      # idempotent: re-applies clean
psql -f rapid/db/rls-verification.sql                     # read isolation
psql -f rapid/db/rls-verification-writes.sql              # write isolation
psql -f supabase/migrations/20260925120000_rapid_down.sql # rolls back to zero rapid_ tables
```

Results recorded on 2026-09-25:

| Check | Result |
|---|---|
| 20 `rapid_*` tables created | pass |
| Every one has `rowsecurity = true` | pass |
| Re-apply is idempotent | pass |
| Rollback leaves 0 `rapid_*` tables | pass |
| Member A sees only their own account | pass (1 of 2) |
| Member A sees only their own position | pass (POS-A only) |
| Encrypted broker credentials readable by their owner | **no rows** — deny-all, as intended |
| Execution leases / risk reservations readable by a member | **no rows** |
| Member A updates member B's `automation_enabled` | `UPDATE 0` |
| Member A edits their own recorded fill price | `UPDATE 0` |
| Member A inserts a forged order intent | rejected by RLS policy |

## Lease fencing and intent idempotency

`rapid/db/lease-and-intent-verification.sql`, run against the same cluster:

| Check | Result |
|---|---|
| Worker A acquires a free lease | fence 1, acquired |
| Worker B attempts while A holds it | refused |
| A re-acquires its own lease | same fence — no spurious handover |
| Lease expires, B takes over | **fence advances to 2** |
| Stale worker A extends with fence 1 | refused |
| Stale worker A creates an order intent with fence 1 | refused |
| Owner B creates the intent with fence 2 | created |
| The same economic visit submitted again | refused (dedupe on `intent_key`) |
| A different visit while one is live | refused (one Rapid position per account) |
| Automation switched off after the decision | refused (`automation_version` mismatch) |
| Risk reservations written | exactly 1, amount 50 |

**A bug this found.** The first version of these functions used `RETURN QUERY` for the refusal
paths. In plpgsql `RETURN QUERY` appends rows and *keeps executing* — so the "stale lease" guard
reported its refusal and then went on to create the order anyway. Every guard now ends in an
explicit `RETURN`, and the test above is what proves it.
