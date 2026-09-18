# TEST PLAN

Today: 188 unit tests, all passing, covering sizing, gates, billing, styles, quant, range guard, member
controls and relay routing. That is the floor, not the ceiling.

## Levels

**1. Pure unit tests** — every engine function is pure and tested against fixtures built from real recorded
market situations, including the ones that lost money. A rule added because of an incident gets a test named
after that incident.

**2. Property tests** — sizing never exceeds the risk limit for any input; a stop never moves away from the
trade; partials never exceed the position; expectancy never reports a positive edge below break-even.

**3. Replay tests** — a historical session is replayed bar by bar with no lookahead. The engine's decisions
are compared against the recorded live decisions of that day. Divergence is a finding, not a failure.

**4. Broker integration (demo only)** — order create, partial close, full close, stop modify, take-profit
modify, order cancel, and every one verified by reading the broker's state back. Explicitly tested:
`order created ≠ filled`, `close sent ≠ flat`, `modify acknowledged ≠ applied`.

**5. Chaos** — API timeout mid-order, duplicate submission, worker killed between submit and confirm,
stale feed, feed divergence, rate-limit storm, database unavailable. Required outcome for every case:
**no duplicate position, no unprotected position, no silent state drift.**

**6. Isolation** — member A can never read or act on member B's connections, accounts or positions,
including through the member controls and every API route.

## Pre-production gate for execution changes

A change that can send a broker request ships only with: unit tests, a demo-account run of the affected path,
a reconciliation check afterwards, and a rollback commit identified. Live-money paths are never validated
for the first time on live money.
