# EXECUTION ARCHITECTURE

## The chain

```
DECISION ─► RISK ─► ACCOUNT RULES ─► EXECUTION VALIDATOR ─► BROKER ─► CONFIRMATION ─► POSITION MONITOR
```

Each arrow is a persisted row, not a function return. If the process dies between two arrows, the next pass
resumes from the database, not from memory.

## The state machine

| State | Meaning | Exit paths |
| --- | --- | --- |
| ANALYZING | Snapshot being evaluated | SETUP_FORMING, none |
| SETUP_FORMING | A strategy sees a setup that has not triggered | ARMED, INVALIDATED |
| ARMED | Trigger conditions live; waiting on the confirming close | ENTRY_REQUESTED, INVALIDATED |
| ENTRY_REQUESTED | Decision created; risk not yet cleared | ORDER_SUBMITTED, REJECTED |
| ORDER_SUBMITTED | Request sent to the broker | ORDER_ACKNOWLEDGED, ERROR, UNKNOWN |
| ORDER_ACKNOWLEDGED | Broker returned an order id | FILLED, CANCELED, UNKNOWN |
| FILLED | Position id resolved | OPEN |
| OPEN | Managed, full risk | PROTECTED, PARTIAL_TAKEN, EXIT_REQUESTED |
| PROTECTED | Stop at or beyond break-even | PARTIAL_TAKEN, RUNNER, EXIT_REQUESTED |
| PARTIAL_TAKEN | Size reduced, profit banked | RUNNER, EXIT_REQUESTED |
| RUNNER | Remainder on a structural trail | EXIT_REQUESTED, CLOSED |
| EXIT_REQUESTED | Close sent | CLOSED, UNKNOWN |
| CLOSED | Broker-confirmed flat; outcome booked | terminal |
| CANCELED | Pending order pulled before fill | terminal |
| INVALIDATED | Setup died before entry | terminal |
| ERROR | Broker rejected with a definite answer | terminal after review |
| UNKNOWN | Timeout or ambiguous response | RECONCILIATION only |

**UNKNOWN is the important state.** It is never resolved by retrying the original request. It is resolved by
reading the broker's orders, positions and history and deciding what actually happened.

## Idempotency

Every action carries an id chain: `userId · accountId · decisionId · executionId`. Before any order:

1. A durable claim row is inserted (`flow_place_claims`, unique on account + signal). A second attempt
   finds the row and stops.
2. Partial closes reserve in `flow_partial_operations` (primary key: environment + account + position) —
   one lifetime partial per position, so a retry, a second worker and a member tap cannot stack.
3. After any timeout, reconciliation runs **before** a retry is even considered.

The rule, stated plainly: *a missed action is recoverable; a duplicated action is not.* Every ambiguous case
resolves toward doing nothing.

## The Execution Validator

Checks, in order, and every failure is logged with a member-readable reason:

account connected · authentication valid · account enabled · auto-trading on · entry permission ·
symbol correct · market open · feed fresh · feeds agree · spread inside limit · position size valid ·
margin sufficient · risk per trade inside limit · total open risk inside limit · daily loss limit ·
open-position limit · duplicate protection · cooldown · news lockout · strategy allowed for this mode ·
decision still fresh · market has not moved materially since the decision

The last check matters more than it looks: a decision priced at 4348 that reaches the validator when gold is
at 4356 is no longer that decision. It is rejected, not chased. (This is the guard that failed on 09-18.)

## Broker transport

- One scheduler per exit (`relay → host`), token-bucket rate budget, adaptive on 1015 responses.
- Four priorities: **critical** (orders, stop moves, closes) → **auth** → **normal** reads → **background**
  (warm-up, readiness). During a fan-out, orders jump every queue.
- A relay that is unreachable falls back to a direct call rather than dropping a member's order.
- A broker "200 OK" carrying `s: "error"` is a **rejection**, never a success. This is enforced in
  `tradelocker.ts` for create, modify and close.

## What a confirmation means

`order created` ≠ `position filled`. `close sent` ≠ `flat`. `stop modified` ≠ `stop moved`. Every mutating
call is followed by a read-back where the broker exposes one, and the recorded state is the broker's answer,
not ours. Where a read-back is impossible, the state is marked unverified and shown that way.
