# GENX execution reliability change

The GENX signal engine and its trigger thresholds are unchanged. This patch changes execution and management after a signal exists.

## Implemented

- Check the account's executable bid/ask after instrument resolution before submitting a protected entry. Reject a crossed bracket and reduce risk-sized quantity when the new entry requires it; preserve signal stop and target.
- Correlate new positions using the exact order ID in broker history. Never select an unfamiliar position by elimination.
- Treat missing order IDs and HTTP 5xx/408 as uncertain; suppress immediate bracket retry and retain the GENX claim for its existing duration.
- Reject malformed/error collection responses instead of treating them as empty accounts.
- Confirm BE/trailing stops through position data or an unambiguous linked working stop order. No acknowledgement-only confirmation.
- Reserve a partial close durably before dispatch, using a unique environment/account/position key. A slow fill, timeout, database outage, crash, or competing worker cannot cause this code to dispatch the same partial again.
- Use broker quantity to confirm partial completion. A position too small to split can trail after BE without inventing a partial.
- Use account/instrument/route-specific executable exit quotes, cached for at most one second per pass. Missing quotes leave the position waiting for broker data.
- Remove the whole-book prefetch barrier; existing connection lanes proceed independently.
- Disable automated Matty and independent Flow signal entries and ignore stored Send It bypass flags. GENX uses Flow for execution/management; existing Matty management remains active. This is backend retirement; navigation/history are retained.

## Validation

`node --import tsx --test tests/genx-execution.test.ts`: 14 tests passed.

`tsc --noEmit --incremental false`: passed.

The existing `scripts/engineChecks.ts` reports seven passes and one conservative-gate failure. The identical result was reproduced against untouched main at `6d3a3541c79aaf87e3a0ca1991594c3fcee993ef`. No engine change is included to make that test pass.

These are simulated broker responses, not evidence of live profitability, lower latency, or successful fills on every broker.

## Rollout gates

1. Validate real demo-account config/position/order payloads, BE read-back, partial-close settlement, and reconnect behavior. The existing TradeLocker client requires demo validation before live use. No real or demo order was placed by this change.
2. Apply `20260911230046_genx_execution_reliability.sql` before new application code. It is additive, service-role only, and contains no changes to account settings or positions. Missing migration prevents partial dispatch.
3. Drain old management processes during rollout: old workers do not honor the new partial reservations. Coordinate Railway and Vercel versions; do not enable two independent test managers against production credentials.
4. Confirm entry-to-submit, quote-fetch duration, management pass age, BE request-to-confirmation, partial pending age, broker 429 count, and ledger-write errors on demo before promoting. No faster polling or paid-plan change is assumed necessary.

## Operational limits requiring follow-up before broad live promotion

- Partial reservations deliberately never expire. A known rejection or crash before dispatch can miss a partial. Reconcile broker quantity and closing orders before manually deciding whether a reservation can be removed; there is no automatic delete/retry path.
- Partial reservation is not a complete cross-system transaction. Lease renewal/fencing, durable entry reconciliation beyond the existing claim TTL, and broker requests already in flight require further validation/hardening. Never describe this patch as exactly-once execution for every action.
- Quotes are snapshots at fetch time; existing outbound pacing can delay submission and market fills can slip. Broker metadata/currency sizing and minimum-lot risk floors are unchanged. Follower sizing retains its existing calculation; it receives the quote/bracket validity guard.
- Existing order-history coverage, orphan enrollment, TP repair, and outcome classification remain broader reconciliation risks. No performance or profit guarantee is made.
- Existing engine fixture mismatch is recorded above; strategy semantics remain the owner's current semantics.

## Rollback

Keep the additive reservation table and its records. Rolling back to old manager code while an operation is pending can re-enable duplicate partial dispatch. Pause new automated entries, reconcile all pending closes, and drain newer workers before considering an application rollback. Do not drop the table or delete reservations as a routine rollback step.
