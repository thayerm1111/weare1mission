# COMMAND CENTER XAUUSD — SYSTEM ARCHITECTURE

The product is **Command Center Xauusd**. The intelligence engine inside it is **The BRAIN**.
One instrument: XAUUSD. Everything below exists to observe it, understand it, act on it under authority,
manage what is open, and learn from what happened.

## The spine

```
TradeLocker ─┐
Twelve Data ─┼─► INGESTION (Railway) ─► NORMALISATION ─► MARKET EVENT BUS
News/Macro  ─┘                                                  │
                                                                ▼
        CANDLE · FEATURE · STRUCTURE · REGIME · PRESSURE · SESSION · LEVELS · CROSS-MARKET · NEWS
                                                                │
                                                                ▼
                                                      ┌── MARKET SNAPSHOT ──┐
                                                      │  (the only input    │
                                                      │   The BRAIN reads)  │
                                                      └──────────┬──────────┘
                                                                 ▼
                                    STRATEGY ENGINE ─► TRADE OPPORTUNITY ─► THE BRAIN
                                                                 │
                                                                 ▼
                                                           RISK ENGINE
                                                                 │
                                                                 ▼
                                                      EXECUTION AUTHORISATION
                                                                 │
                                                                 ▼
                                                     TRADELOCKER EXECUTION
                                                                 │
                                                                 ▼
                                                   POSITION RECONCILIATION
                                                                 │
                                                                 ▼
    LIVE POSITION BRAIN ─► CHoCH · PROFIT GUARD · PARTIALS · BREAK-EVEN · EXIT ENGINE
                                                                 │
                                                                 ▼
                                          OUTCOME ENGINE ─► LEARNING ENGINE ─► versioned intelligence
```

**The inviolable rule:** The BRAIN never calls the broker. It produces a *decision object*. The Risk Engine
and the Execution Validator decide whether that object becomes an order. A language model that hallucinates
"BUY" produces, at worst, a rejected decision row — never a position.

## Where each part runs

| Layer | Runs on | Why |
| --- | --- | --- |
| Ingestion, engines, execution, position management, learning | **Railway** (`weare1mission` worker) | Must keep running with every browser closed. Holds DB locks so Vercel crons never double-act. |
| Broker egress | **Railway** relay pool (`relay-eu`, `relay-b`, + worker's own IP) | TradeLocker rate-limits by IP; each exit carries its own budget, chosen by account hash. |
| Application, API routes, auth | **Vercel** (Next.js) | Member-facing UI and the cron fallback that takes over if the worker dies. |
| State, intelligence, audit | **Supabase / Postgres** | Single source of truth, RLS per user. |
| Source of truth for code | **GitHub** | Every production execution change traceable to a commit. |

## Service inventory (existing, reused)

- `manageLoop` (350 ms) — position management across the whole open book.
- `watchLoop` (1 s) — armed setups checked against fresh confirmation reads.
- `pdLoop` — previous-day high/low break→retest→continuation.
- `genx3Loop` — the v3 engine, currently off by control flag.
- `styleShadowLoop` (60 s) — Rapid / Structure / Swing recorded and graded without placing.
- `billingLoop` — credit events + readiness check.
- `backfillLoop` — walks the 1-minute archive backwards.
- `streamLoop` — Twelve Data WebSocket ticks into the in-memory tick store.

## Module boundaries

**Ingestion may not** compute strategy. **Strategy may not** call the broker. **The BRAIN may not** write to
any table other than its own conversation and decision rows. **The Position Manager may not** open new
positions. Each boundary is enforced by module ownership, not convention: the only file permitted to call
`createOrder` is `src/lib/flow/executor.ts`.

## Data flow contracts

1. **Tick → Bar.** One normaliser owns the mapping. Every bar records which feed produced it.
2. **Bar → Features.** Pure functions, no I/O, unit-tested. Same code runs live, in shadow and in replay.
3. **Features → Snapshot.** One versioned object (`snapshot_version`), the only thing the BRAIN and the
   strategy engine read. A model can never see data the snapshot did not carry — this is what makes replay
   honest and backtests non-leaky.
4. **Snapshot → Opportunity → Decision → Authorisation → Order.** Each step writes a row before the next
   begins. Nothing in this chain is ever inferred later from logs.

## Multi-user isolation

Every table carries `user_id` and RLS. Broker credentials are encrypted at rest (`flow/crypto.ts`) and never
leave the server. A member's automation permissions are read fresh from the database on every fan-out — a
cached permission is never trusted.

## Failure posture

The system is designed to **fail closed on data and open on billing**: stale or divergent market data blocks
new entries; a billing or logging fault never blocks protection of an open position. Positions always carry a
broker-side stop and take-profit, so a total platform outage leaves every trade protected by the broker.
