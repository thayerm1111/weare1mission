# Cashtrap

Binary-options **signal provider** for USD/JPY, EUR/USD, XAU/USD and GBP/JPY on 5-minute candles.
It publishes CALL/PUT signals from a fixed indicator rule set and measures them against a reference
price feed. **It places no orders and talks to no broker.** It is a separate module: its own code
(`src/lib/cashtrap`, `src/components/cashtrap`, `src/app/api/cashtrap`, `src/app/api/cron/cashtrap`),
its own tables (`cashtrap_*`), its own lock. No other tool's logic or tables are touched.

Page: `/portal/cashtrap`. Admins always; active members only after visibility is switched to "members"
in the admin panel (the menu link then appears for them within a minute).

---

## 1. The rules — what was specified vs what is assumed

### Fixed (owner's screenshot settings — `SCREENSHOT_SETTINGS` in `config.ts`, not editable)

| Indicator | Setting |
|---|---|
| Bollinger Bands | length 20, SMA basis, source close, ×2 standard deviations (population, as TradingView), offset 0 |
| RSI | length 4 on close, levels 80/20; RSI-based MA = SMA(4), shown as a separate line, **never used in a condition**; divergence off; the "BB StdDev 2" field is inactive (it applies only when the MA type is Bollinger Bands) |
| Stochastic | ordinary Stochastic (not Stochastic RSI) 5/1/1 — with smoothing 1/1, %K and %D are the same line; levels 80/50/20; **no %K/%D crossover required** |
| DMI-Stochastic | DMIlength 10, Stolength 3 — calculation from the owner's own Pine source (section 2) |
| Timeframe | 5-minute candles; **completed candles only** for anything actionable |

### The setup (`engine.ts`)

An **exhaustion candle** is a completed candle where, at its close:

* **CALL (BUY)**: low below the lower band · RSI(4) < 20 · Stochastic %K < 20 · its range touches a valid **support** zone and it closes at or above that zone's lower edge.
* **PUT (SELL)**: high above the upper band · RSI(4) > 80 · %K > 80 · its range touches a valid **resistance** zone and it closes at or below that zone's upper edge.

The exhaustion candle **arms** a setup. A **fresh DMI B** (CALL) / **S** (PUT) on the exhaustion candle
or either of the next **2** completed candles **confirms** it → a CALL/PUT signal. RSI/Stochastic need
not stay extreme. No engulfing, crossover, trend filter or close-back-inside rule.

Cancelled by: an opposite DMI event · a close through the zone (BUY: below support's lower edge;
SELL: above resistance's upper edge) · an opposite exhaustion · invalid/stale data · a market closure
between candles. Expires when the DMI window ends without the event. Ambiguity → **WAIT** with the
reason (both directions qualifying on one candle — impossible with RSI < 20 vs > 80, guarded anyway —
or a feed sending both B and S for one candle).

One armed setup per symbol; after a setup arms, that direction must **reset** before another
exhaustion can arm; while a published signal is running (entry window + expiry), a new confirmation on
that symbol is recorded but **not published**. Also recorded but not published (and blocking nothing):
a confirmation decided more than 60 s after its candle closed (the runner was down — a late signal is
never sent), and one whose publication or expiry would fall while the market is closed.

"5/5 conditions met" = agreement of related indicators (band, RSI, Stochastic, zone, DMI). It is
confluence, **not** a probability, and is never turned into one.

### Assumptions (configurable in the admin panel; every one is shown on the dashboard as an assumption)

| Assumption | Default | Origin |
|---|---|---|
| Confirm only after the 5-minute candle closes | on (V1 supports only this) | owner's listed default |
| Band excursion | wick outside the band (alternative: close) | owner's listed default |
| DMI window | exhaustion candle + next 2 | owner's listed default |
| Zone confirmation required | yes | owner's listed default |
| Expiry | 300 s **duration** from the accepted reference entry — provisional, for simulation | owner's listed default |
| Entry window | reference entry within 10 s of publication, else MISSED | owner's listed default |
| Automatic zones | 2/2 swings, 200-candle window, half-width 0.15 × ATR(14) frozen at creation, invalidated by a close beyond, no flip | owner's listed default |
| Swing definition | strictly higher than the 2 before, at least as high as the 2 after (mirror for lows) | implementation |
| Zone timing | width from ATR at the candle that confirms the swing; usable from the next candle's open | implementation |
| Several zones qualify | the one whose centre is nearest the candle's extreme (then newest) | implementation |
| Manual zones | used from when marked; invalidated by a close beyond, like automatic zones; a break is remembered (engine state + the stored zone), so it holds after the breaking candle leaves the window | implementation |
| Reset rule | band excursion, RSI extreme and Stochastic extreme of that direction **all** cleared on a completed candle | implementation |
| One active signal per symbol | yes | owner's listed default |
| Settlement quote tolerance | within 5 s after expiry, else UNRESOLVED | implementation |
| Tie rule | recorded as a tie, paid as a refund | **broker setting needed** |
| Payout rate | not set → payouts not computed | **broker setting needed** |
| Data | 250-candle warmup, 500-candle calculation window, no unexpected gap in the last 12 candles, each candle decided 90 s after it closes (the feed finishes a 5-minute candle ~60–80 s after the close — see section 5), published only if decided within 150 s of the close | implementation |
| Closed market | no publication when the market is closed at publication or would be at expiry; an expiry inside a closure is unresolved | implementation |
| Outside DMI events | count only if received after their candle closed and by the time it is decided | implementation |

Every decision and signal stores `strategy_version` (`cashtrap-1.0.0`) and `config_version` (hash of the
fixed settings + assumptions in force), so each record says which rules produced it.

---

## 2. DMI-Stochastic

Implemented from the owner's pasted source (Pine v3, "DMI Stochastic Extreme", `dmi.ts`), exactly —
including its non-textbook parts: Wilder's MA seeded at **zero** (`nz(wwma[1])`, not `ta.rma`), v3's
`tr` (na on the first bar), na comparisons false, division by zero → no value. Over the 500-candle window
the zero seed has faded to ~1e-12, so values match a chart that started years earlier.

**B/S events.** The pasted version draws **no markers** (its signal plots are commented out). The only
events it computes are `crossUp` (DMI-Stoch[1] < 10 and DMI-Stoch > 10) and `crossDown` (DMI-Stoch[1] > 90
and DMI-Stoch < 90); the commented plots label crossUp as long. So **B = crossUp, S = crossDown**, at the
close of the candle where the cross is computed. **If the B/S markers on the owner's chart come from
other lines, that version of the script is needed.**

Modes (admin panel):

* `calculation` (default) — computed from the candles with the source above.
* `event-feed` — timestamped B/S events posted from outside (e.g. TradingView alerts on the owner's own
  indicator). Confirmations stay off until the feed is marked **verified**.
* `off` — setups can arm; CALL/PUT can never be confirmed; the dashboard shows "DMI source required".

### Event-feed contract

```
POST /api/cashtrap/dmi?key=<CASHTRAP_DMI_FEED_SECRET>
{ "symbol": "EURUSD" | "FX:EURUSD" | "EUR/USD", "signal": "B" | "S",
  "time": "<the 5-minute candle's OPEN time, ISO-8601 or epoch ms>",
  "source": "tradingview-alert", "version": "<indicator version>" }
```

TradingView alert message: `{"symbol":"{{ticker}}","signal":"B","time":"{{time}}","source":"tradingview-alert","version":"v3"}`
(`{{time}}` is the bar's open time, UTC). Creating such alerts needs a version of the script with
`alertcondition()` for B and S — the pasted version has none. Only the four symbols are accepted — never
a substitute. An event is used only for the candle it names and only if it arrived by the time that
candle is decided (90 s after its close, or `data.dmiGraceMs` if that were longer); a later event does
not count.

---

## 3. Signals, timing and outcomes (`signals.ts`)

| Field | Meaning |
|---|---|
| `setup_candle_t` | open time of the exhaustion candle |
| `confirmation_t` / `confirmed_at` | open / close time of the candle carrying the DMI event — the confirmation exists at its close |
| `published_at` | when the runner recorded the signal (always ≥ `confirmed_at`; ~90 s after the close, once the feed's candle is final) |
| `entry_window_start` → `entry_deadline` | publication → publication + 10 s |
| `reference_price`, `reference_at` | **first quote received at or after publication**, inside the window; never the candle's close, never backdated. None in time → **MISSED** (never a late entry) |
| `expiry_at` | duration mode: reference entry + 300 s. Fixed mode: the first contract boundary at least N s after entry |
| `settlement_price`, `settlement_at` | first quote at/after expiry, accepted within 5 s |

Outcome: CALL wins if settlement > entry; PUT wins if settlement < entry; equal (at the instrument's
precision) = **tie** (paid per the tie rule); no settlement quote = **unresolved** — never an invented
win or loss. Payout (`+r` win, `−1` loss) is computed only when a payout rate is configured.

Record types are kept apart everywhere: **reference-feed** (live, against TwelveData), **simulated**
(replay), **broker-verified** (needs the broker's own entry/settlement records — none exist; no broker is connected).

---

## 4. Live runner

* `GET /api/cron/cashtrap` — Vercel cron every minute (the crons start 10–30 s late and unevenly).
  One runner at a time holds `cashtrap_lock`. A run lasts at least until 4 s past the next minute (so
  an expiry on a minute boundary is settled on time), then hands over as soon as the next run is
  waiting — never while one of its own settlements is due within 15 s — and at the latest 56 s past
  the next minute. The waiting run marks itself every second, so there is no moment with nobody
  running; a runner that dies loses the lock within 30 s. It decides each closed candle **90 s after it
  closes** (when the feed's candle is final — section 5), in order, once; a market whose newest candle could not be decided (feed late, failing or
  rate-limited) is tried again every 5 s; publishes confirmed signals and takes the reference entry
  immediately; settles each signal at its exact expiry (timers); refreshes prices every 10 s; writes
  the market cards (`cashtrap_snapshots`). If the settings cannot be read, the run does nothing (the
  defaults are never used in their place).
* Replays: after its live work, a runner with time left runs the next queued replay (also
  `GET /api/cron/cashtrap-jobs`, every 5 minutes). A replay gives the event loop a turn every 25 candles,
  so it never delays a live settlement timer.
* Auth: `Authorization: Bearer <CRON_SECRET>` (Vercel) or `<CASHTRAP_CRON_KEY>`.
* Restarts: engine state, decisions, setups, signals and alerts are all stored; a new process continues
  where the last stopped. A candle is decided once (state + unique key); a setup publishes at most one
  signal (unique key); an alert is raised once per key.
* After downtime: the runner asks the feed for enough candles to fill the gap; up to 24 missed candles
  are decided in order (older ones are skipped, and a setup armed across the outage is recorded as
  cancelled); a confirmation decided more than 60 s after its candle closed is recorded but **not
  published** (a late signal is never sent).
* First start: decides only the newest closed candle onward (no back-publishing).
* Closed markets are not polled once enough history is stored. Hours (New York time): FX closed
  Fri 17:00 → Sun 17:00 (17:00–17:10 rollover tolerated); gold closed Fri 17:00 → Sun 18:00 and
  17:00–18:00 Mon–Thu. Holidays are not in this model: on a day the feed has no candles the cards show
  DATA UNAVAILABLE and the runner keeps asking (about 12 extra feed calls a minute per market).
* Switch it off: admin panel → "Live runner" (setting `live_enabled`). The cron then exits at once.
* Cost: TwelveData ≈ 28 credits/minute while markets are open (4 quotes every 10 s, plus each run's
  candle read per market for the "developing" status, plus retries when the feed is late), through the
  shared governor (`MD_MINUTE_LIMIT`). One Vercel function is running at all times while the runner is on.

---

## 5. Market data (`data.ts`, `symbols.ts`)

| Cashtrap | TwelveData | Precision |
|---|---|---|
| USDJPY | USD/JPY | 3 |
| EURUSD | EUR/USD | 5 |
| XAUUSD | XAU/USD | 2 |
| GBPJPY | GBP/JPY | 3 |

Candles: `time_series` 5min, timezone UTC, fresh (no cache); rows are checked (5-minute boundary,
possible prices, conflicting duplicates refused) and sorted; the forming candle is never decided.
A stored candle that later comes back different is updated and **logged** in `cashtrap_data_corrections`;
decisions already made are not rewritten. DATA UNAVAILABLE when: market closed, feed behind or not
answering, rate-limited, warmup too short, or an unexpected gap in the last 12 candles.

**Closed-market candles.** TwelveData also sends candles while the markets are closed — its 8-week
history (10-22) had a candle for every Saturday slot, with small real moves, and for gold's daily
17:00–18:00 New York break. A normal chart (e.g. TradingView with an OANDA or FX feed) has none, and
they would distort every indicator for hours after each weekend, so Cashtrap drops them before storing,
when loading, and in replay (`tradingCandles`), using the trading hours below.

Quotes: TwelveData `price` has **no timestamp**, so a quote is timestamped when it is **received**.

**Feed timing (measured live 10-22).** TwelveData builds its 5-minute candles from 1-minute bars that
arrive about a minute late: at 01:42:12 UTC the forming gold candle held only the 01:40 minute. A candle
read 8–20 s after its close was therefore unfinished — every one was revised ~80 s after the close
(never later), and one revision moved GBP/JPY's close from 211.732 to 211.740, which had cancelled a
live setup. So Cashtrap decides each candle 90 s after its close (`data.feedSettleMs`) and publishes
then. The `price` quote is current (a gold quote at 01:43:52 sat outside the whole 01:42 minute's range),
so entries and settlements are not delayed. A real-time candle source (the broker's, or a tick stream)
would let signals go out within seconds of the close; none is connected.

**Limitation:** TwelveData is a general spot feed. It is **not** any binary broker's price stream; a
broker's quotes — especially synthetic/"OTC" instruments — can differ. Nothing is silently substituted.

---

## 6. Replay / backtest (`replay.ts`, `jobs.ts`, `report.ts`)

Queue from the admin panel (all four markets, 1–12 weeks; the API also takes payouts and the
development fraction). The runner fetches TwelveData 5-minute history and runs the **live engine's own
`step()`** candle by candle — no lookahead, no tuning; manual zones apply only from when they were marked. Outcomes use the **bar-open proxy**: entry = open of the candle after confirmation, settlement
= open of the candle at expiry. That assumes zero publication delay (optimistic) and a general feed —
every report says so; records are **simulated**.

Report per symbol, never pooled: chronological development / out-of-sample split (default 70/30),
setups armed/confirmed/cancelled/expired, signals, signals per trading day, missed, wins, losses, ties,
unresolved, win rate excluding ties, longest losing streak, net units and per-signal result at each
payout, and the **break-even win rate 1/(1+r)** (80% payout → 55.56%). A win rate above 50% is not
profitability.

---

## 7. Alerts

In-app: one alert per event, ever (`cashtrap_alerts.dedupe_key` unique): armed, signal, entry, missed,
outcome. Each member chooses which kinds they see (bell menu).

Other channels: a webhook (`alerts.ts`) — `POST` JSON to `CASHTRAP_ALERT_WEBHOOK_URL` with header
`x-cashtrap-secret: CASHTRAP_ALERT_WEBHOOK_SECRET`; kinds from `CASHTRAP_ALERT_WEBHOOK_KINDS`
(default `signal,entry,missed,outcome`). Off unless both URL and secret are set. Each delivery is
reserved in `cashtrap_alert_deliveries` (unique alert/channel/recipient) **before** sending: never sent
twice, failures recorded and not retried, old alerts never re-sent late. Credentials stay server-side.

---

## 8. Environment variables

| Variable | Needed for | Status |
|---|---|---|
| `TWELVEDATA_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` | runner | already set (shared) |
| `CASHTRAP_CRON_KEY` | calling the runner by hand | optional |
| `CASHTRAP_DMI_FEED_SECRET` | DMI event-feed mode | optional — only for event-feed |
| `CASHTRAP_ALERT_WEBHOOK_URL`, `CASHTRAP_ALERT_WEBHOOK_SECRET`, `CASHTRAP_ALERT_WEBHOOK_KINDS` | webhook alerts | optional |

---

## 9. Still needed from the owner (nothing is invented in their place)

1. **DMI B/S markers** — confirm B = crossUp through 10 and S = crossDown through 90, or provide the
   version of the script that draws the B/S markers on the chart.
2. **Broker contract** — which broker; expiry type (duration vs fixed clock time) and allowed expiries;
   minimum time to expiry; what a tie pays; payout per instrument; whether its instruments are real
   market or OTC/synthetic. Until then: expiry 300 s duration (provisional), tie = refund (assumed),
   payout not set, nothing labelled broker-compatible.
3. **A faster candle source** *(optional)* — with TwelveData, signals go out ~90 s after the candle
   closes (section 5). Your broker's own price/candle stream, or a tick stream, would cut that to seconds.
4. *(Optional)* TradingView parity — see below.

---

## 10. Tests and verification

`npx tsx --test tests/cashtrap-*.test.ts`

* `cashtrap-indicators` — BB/SMA/population stdev, RSI (TradingView's RMA), Stochastic, ATR, the DMI
  port checked against an independent bar-by-bar transcription of the Pine source, strict crossings,
  window convergence.
* `cashtrap-zones` — swings confirm only after their right-hand candles close, frozen width,
  invalidation by close, no flip, manual zones never back-applied.
* `cashtrap-engine` — arming (not a signal), confirmation on the exhaustion candle and on either of
  the next two (too late on the third), opposite DMI / close through the zone / opposite exhaustion /
  missing data / market closure cancellations, no DMI → never confirms, resets, suppression while a
  signal runs, a DMI event used only once known (and only if it came after its candle closed), a
  candle decided once, calculated confirmations sit on real DMI crossings, **no repainting** (later
  candles never change an earlier decision), late or closed-market confirmations not published and
  blocking nothing, a manual zone's break remembered beyond the window.
* `cashtrap-signals` — entry window, never backdated, MISSED, duration vs fixed expiry, win/loss/tie/
  unresolved, payout, break-even 1/(1+r), the chronological development / out-of-sample split.
* `cashtrap-service` — **live and replay identical to the bit**, restart continuity, duplicate passes,
  corrections logged, developing candles never decided, late confirmations not published, the lock,
  the DMI grace period, a failed feed retried in time, gaps filled after downtime, an expiry in a
  closed market unresolved, setups armed across an outage closed on record, the hand-over between runs.
* `cashtrap-adapters` — feed parsing/duplicates/order, market hours vs gaps, freshness, DMI ingest, config validation.
* `cashtrap-alerts` — one alert per event, one delivery per channel, failures not retried.

### Verify against TradingView (optional)

On TradingView, open a 5-minute chart of a symbol with Bollinger Bands (20, 2), RSI (4) and Stochastic
(5, 1, 1) and the DMI-Stochastic script, then *Export chart data* to
`tests/fixtures/cashtrap/tradingview/<SYMBOL>.csv`. Columns used (case-insensitive): `close`, `high`,
`low`, `basis`, `upper`, `lower`, `rsi`, `%k`, and the DMI-Stochastic plot as `stochastic`. The parity
test compares every value from row 300 on. The chart's price source (e.g. FX:, OANDA:) is not TwelveData,
so live B/S events can differ near the 10/90 levels even when the calculation matches.
