# RAPID — XAUUSD Rapid analysis and execution (`matty_rapid_v1`)

Product identifier: `rapid`. Floor tab: **Rapid**. API: `/api/rapid/*`. Tables: `rapid_*`.
Worker: `npm run rapid-worker`. Strategy version: `matty_rapid_v1`, config `matty_rapid_v1.cfg.1`.

> **Status: NOT live-ready, by design.** The feature flag ships off, automation defaults off for
> every account, and the global control starts with entries paused. The replay evidence below is
> **negative-to-inconclusive**, which is a reason not to turn it on, not a detail to work around.

---

## 1. What changed

| Area | Path |
|---|---|
| Strategy configuration | `rapid/config/defaults.ts` |
| Decimal-safe arithmetic | `rapid/core/decimal.ts` |
| Types | `rapid/core/types.ts` |
| Broker session calendar | `rapid/market/session.ts` |
| Bars, ATR, aggregation | `rapid/market/bars.ts` |
| Quote intake, dedup, basis | `rapid/market/quotes.ts` |
| Twelve Data (context only) | `rapid/market/twelvedata.ts` |
| Swings, regime, protected swing | `rapid/engine/structure.ts` |
| Zone geometry, merge, lifecycle | `rapid/engine/zones.ts` |
| Range validation | `rapid/engine/range.ts` |
| Frozen tolerances | `rapid/engine/tolerances.ts` |
| Structural stops | `rapid/engine/stops.ts` |
| Targets and cost model | `rapid/engine/targets.ts` |
| Entry families | `rapid/engine/setups.ts` |
| Visit state machine | `rapid/engine/visits.ts` |
| Signal arbitration | `rapid/engine/arbitration.ts` |
| Management rules | `rapid/engine/manage.ts` |
| **The one decision core** | `rapid/engine/snapshot.ts` |
| Broker-aware sizing | `rapid/risk/sizing.ts` |
| Encrypted credentials | `rapid/broker/crypto.ts` |
| Rate-limited transport | `rapid/broker/http.ts` |
| TradeLocker operations | `rapid/broker/tradelocker.ts` |
| Token lifecycle | `rapid/broker/session.ts` |
| Broker port (interface) | `rapid/exec/port.ts` |
| Live port | `rapid/exec/tradelockerPort.ts` |
| Failure-injecting simulator | `rapid/exec/simulator.ts` |
| Leases with fencing | `rapid/exec/leases.ts` |
| Account-level isolation | `rapid/exec/ownership.ts` |
| Pre-submission gate | `rapid/exec/guards.ts` |
| Submission state machine | `rapid/exec/submit.ts` |
| Reconciliation | `rapid/exec/reconcile.ts` |
| Position management runner | `rapid/manage/runner.ts` |
| Worker | `rapid/worker/index.ts` |
| Replay harness | `rapid/research/{loader,backtest,run}.ts` |
| Schema + rollback | `supabase/migrations/20260925120000_rapid{,_down}.sql` |
| API | `src/app/api/rapid/{analyze,settings,connect,status,position}/route.ts` |
| Desk UI | `src/components/portal/rapid/RapidDesk.tsx` |
| Floor tab wiring | `src/components/portal/floor/FloorWorkspace.tsx`, `src/components/portal/PortalNav.tsx` |
| Phone app | `public/app/index.html` (`RapidScreen` + Floor tile) |
| Tests | `tests/rapid-{core,snapshot,execution,isolation}.test.ts` |

**Nothing under `src/lib/flow`, `src/lib/genx*`, `command-center/`, `auric/` or `worker/` was
modified.** `tests/rapid-isolation.test.ts` fails the build if that stops being true.

## 2. The three entry families, and exactly what they do

| | Trigger | Stop anchor | Target |
|---|---|---|---|
| **A. Range reaction** | Executable price inside the frozen approach band at a validated range boundary, on a fresh visit. No extra rejection candle. | The far edge of the boundary zone **and** the confirmed swing belonging to it — whichever is farther. | Toward the opposing boundary, capped at $15, never through nearer structure. |
| **B. Closed break and retest** | A completed 5m/15m candle closes beyond the zone by the break buffer, with a body ≥55% of range and a close in the directional outer 30%. That **arms** a retest; entry is the first qualifying quote afterwards. | Beyond the broken zone **and** the associated pullback base. | Same. |
| **C. Trend pullback** | Local confirmed uptrend/downtrend, a pullback into the newest eligible zone behind price, protected swing intact. | Beyond that zone **and** the protected higher low / lower high. | Same. |
| *D. Closed-break momentum* | **Off.** Behind `entry.momentumEnabled`, separately versioned, measured on its own. | | |

**Stops.** Cap $10 in gold price; a structurally correct stop wider than that **skips the setup**
rather than being compressed. `stopCeilingUsd: 15` is a hard operational ceiling that configuration
cannot exceed. A wider live spread pushes the stop **out** and the size **down** — never the reverse.

**Targets.** `min($15, distance to the next meaningful obstacle − buffer)`, skipped below $5. A $7
structural target is a $7 trade with a full exit at $7, and no $10 partial is promised.

**Management ON.** Breakeven at `max($3, 0.5 × stop distance, 0.35 × ATR at fill)`, a 50% partial at
$10 **only when the target is strictly beyond $10**, then a trail behind newer confirmed structure,
plus a change-of-character exit: a completed candle closing beyond the protected swing by the break
buffer with a body ≥55%. Protection only ever tightens. **Management OFF** keeps the broker's
original SL/TP and disables everything discretionary; risk checks and reconciliation keep running.

## 3. Confirmed rules versus proposed numbers

**From the method, implemented as stated:** the five-timeframe read; range trades at validated
boundaries; break-and-retest entered on the return without a second confirmation candle; trend
continuation into fresh structure to the left; stops beyond the invalidating structure; targets to
the next meaningful opposing level; support and resistance swapping roles; a level producing more
trades on genuinely new visits.

**Every number is a proposed default, not a validated one.** Pivot ±2 bars, ATR 14, the 0.15 ATR
merge tolerance, two reactions per boundary in 48 bars, the $10 stop cap, the $5–$15 target band, the
1.0 net reward/risk floor, the 0.25/0.5/1/2% risk presets, the $0.80 spread ceiling, the 2-second
feed-age and signal-age ceilings, the 3% session loss ceiling, the breakeven and partial triggers.

**Deviations from the specification, and why:**
- **Planning price.** Setups are priced from the zone's near edge — where the fill is expected —
  not from the current mid. Pricing a range fade from mid-range made every one of them look like
  0.8 R:R and filtered the engine into doing nothing. Caught by the rejection funnel.
- **A fourth TradeLocker client.** The clean-room rule forced Rapid to have its own transport, so
  this repository now has four (FLOW, Command Center, AURIC, Rapid), each with a private rate budget
  against one shared broker edge limit. Rapid's is the only one that reads the broker's published
  `/trade/config` limits and honours `Retry-After`. **They should be unified.**
- **Market orders, IOC.** FLOW uses resting GTC limits because its route rejects limit+IOC. Rapid
  sends `type: market, validity: IOC` with absolute SL/TP attached, which `matty-pips` already does
  successfully against the same broker.
- **Credits.** Not wired. Rapid charges nothing and touches no existing billing.

## 4. Tests actually run

```
npx tsc --noEmit -p tsconfig.json     # 0 errors
npx tsx --test tests/*.test.ts        # 844 tests, 835 pass, 9 fail
npx next build                        # compiles; all five /api/rapid routes present
```

The 9 failures are the **pre-existing baseline** (8 in `cc-trade`, 1 in `horizon`) and are unrelated
to this work; they failed identically before it (the suite was 741 tests before Rapid). Rapid adds
**103 passing tests**:

| File | Tests | Covers |
|---|---|---|
| `rapid-core` | 49 | decimal safety, session/DST, quote identity and lateness, pivot known-at, plateau determinism, zone merge and expiry, range validation, tolerances, stop anchors and the cap, target precedence, visit re-arming, arbitration, management triggers, change-of-character, sizing and overfill |
| `rapid-snapshot` | 9 | end-to-end determinism, warmup blocking, stale feed, closed market, no-leakage, the flagged family staying off, scenario self-consistency |
| `rapid-execution` | 21 | the pre-submission gate, cancelled-at-the-last-instant, timeout-that-filled, order-id≠position-id, protection verification, unprotected-close, unconfirmed emergency close, vanished position, tag bounds |
| `rapid-isolation` | 9 | clean room both ways, `rapid_*`-only writes, migration scope, RLS on every table, automation off by default, frozen config, **no LLM in the decision path** |
| `rapid-broker-semantics` | 15 | omitted leg vs explicit null on amendment, delayed close, the `{s:"error"}`-inside-200 envelope, columnar rows, protective priority, published rate limits and `Retry-After`, ambiguous gold blocking, named-not-defaulted contract metadata, credential encryption and tampering, foreign positions |

**Database, against a real PostgreSQL 16** (`rapid/db/README.md` has the transcript): migration
applies, re-applies idempotently, rolls back to zero; RLS on all 20 tables; a member cannot read
another member's account or position, cannot read encrypted credentials **even their own**, cannot
flip another member's automation, cannot edit their own recorded fill price, and cannot forge an
intent. Lease fencing: a stale worker's extend **and** its order intent are both refused, the same
economic visit dedupes, a second concurrent intent is refused, and an automation change after the
decision invalidates it.

> A bug this found: the refusal paths originally used `RETURN QUERY` without `RETURN`. In plpgsql
> that appends a row and **keeps executing**, so the "stale lease" guard reported its refusal and
> then created the order anyway. Every guard now ends in an explicit `RETURN`.

## 5. Broker readiness and measured latency

**Not measured against a live account.** No TradeLocker credentials were available in this
environment, so no connection test, no contract discovery against a real account, and no latency
figures. The adapter is fully implemented, not stubbed, and is exercised end to end against
`rapid/exec/simulator.ts`, which reproduces the failure modes a demo account will not: a submit that
times out after the exchange accepted it, an amendment rejected inside an HTTP 200, a delayed close,
a vanished position.

**Before this can be called broker-ready:** verify the developer-key header spelling
(`tl-developer-api-key` vs `developer-api-key` — the docs disagree), confirm `market`+`IOC` with
absolute SL/TP is accepted on the intended route, confirm contract size and lot step per account,
and measure feed age and round-trip latency on the real feed against the 2-second ceilings.

## 6. How a member operates it

1. **Analyze** — read-only, safe with automation off, shows the level map, the structure per
   timeframe, at most one long and one short scenario, and the snapshot's age. Pressing it cannot
   arm anything.
2. **Risk per trade** — 0.25 / 0.5 / 1 / 2% of equity, clamped server-side.
3. **Trade Management ON/OFF** — off leaves the broker's original stop and target in place.
4. **Automation ON/OFF** — per account, authenticated, defaults off, and refused with a named list of
   blockers until the account is genuinely ready.
5. **Close Rapid Position** — a separate control. It says *requested*, not *closed*, until the broker
   confirms.

**What OFF does during an open trade:** Automation OFF stops new entries and cancels unfilled Rapid
entry orders. It does **not** close the position and does **not** remove protection; management
continues under the version pinned at fill. Closing the browser does nothing either way — the
server holds the permission, not the tab.

## 7. Remaining limitations, and the smallest next step

**Limitations**
- The replay evidence is negative-to-inconclusive (section below). No edge has been demonstrated.
- Evaluated on 5-minute OHLC, so intrabar touch order and same-bar management are unverifiable.
  Ambiguous bars are resolved adversely and counted.
- The spread is assumed, not measured from the account that would trade it.
- No live broker validation, no measured latency, no load test.
- Four TradeLocker clients share one broker rate limit and cannot see each other.
- The economic-calendar pause is implemented but off: no verified source is wired, and inventing
  event times would be worse than not having the feature.
- Credits and entitlements are not wired.

**The smallest concrete next step:** run `rapid/research/run.ts` over the **full 879k-bar archive**
(`rapid/research/loader.ts` carries the extraction SQL) rather than the 26,605-bar sample, with the
breakeven trigger as the first thing under examination — see below.

---

## Replay evidence

Full report: **`rapid/research/RESULTS.md`**. Raw output: `rapid/research/replay-2026-09-25.log`.

**290 trades over 26,605 closed M5 bars (~92 trading days, Oct 2024 → Aug 2026), five windows,
chronologically split.** Net +18.44R, expectancy **+0.064R per trade, 95% CI −0.125 to +0.252**.
Dev −0.043R, validation **−0.229R**, holdout +0.333R.

**INCONCLUSIVE.** The interval spans zero, the validation period was the worst of the three, and
290 trades is too few for the uncertainty to mean anything. No edge has been demonstrated.

Two findings worth acting on:

- **The breakeven trigger is the biggest single drag.** Disabling it while keeping the trail and the
  structural exit takes expectancy from +0.096R to +0.180R. It fires at $3 while the median
  favourable excursion is $2.80–$5.01, so it pulls the stop to entry at roughly the point where half
  these trades make their high.
- **`range_reaction` produced 4 trades in 92 days.** The range validator is strict enough that the
  family Matthew described first is effectively not running.

A look-ahead bug in the harness itself (filling on the bar whose close produced the signal) inflated
one window to a 45% win rate and a 5.7 profit factor before it was found. Every number above is
post-fix.

## Configuration

Environment variables (names only, no values):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | database |
| `RAPID_ENC_KEY` | credential encryption; falls back to `FLOW_ENC_KEY` |
| `TWELVEDATA_API_KEY` | analytical context bars |
| `TL_DEVELOPER_API_KEY` | TradeLocker multi-user developer key |
| `RAPID_LEASE_TTL_MS`, `RAPID_ANALYSIS_MS`, `RAPID_ACCOUNT_MS`, `RAPID_WATCHDOG_MS`, `RAPID_BAR_REFRESH_MS`, `RAPID_PROTECTION_DEADLINE_MS` | worker cadences |
| `RAPID_TL_MIN_SPACING_MS`, `RAPID_TL_TIMEOUT_MS` | transport budget floor and timeout |
| `RAPID_MAX_RISK_PCT` | operator risk ceiling (default 2) |
| `RAPID_TOKEN_REUSE_MS` | access-token reuse window |

**Deployment.** A separate Railway service running `npm run rapid-worker`, auto-sleep disabled,
restart policy always. It is deliberately NOT added to the existing worker: a slow pass in one must
not be able to starve the other.

**Rollout order.** Core and fixtures → replay → paper/demo on a dedicated account → controlled
production. `liveEnabled` stays false and `rapid_control.mode` stays `off` until the acceptance
evidence exists. Nobody is migrated into this, and no account is armed by a deploy.
