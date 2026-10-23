# One Mission FX Scalper

Live, fully automatic M1 scalping on **one TradeLocker account** (Genesis FX Markets) for **EURUSD,
USDJPY, AUDUSD, USDCAD, GBPUSD, GBPJPY and EURJPY**. Owner spec 10-23 (target raised to 10 pips the
same day). Built for live trading: no demo phase, no paper trading, no backtest and no trial. Nothing is
sent to the broker until the account is connected **and** the owner presses **START LIVE**.

| Part | Where |
|---|---|
| Pairs, settings and their limits | `src/lib/fxscalper/pairs.ts`, `settings.ts` |
| Indicators and the entry rules | `src/lib/fxscalper/indicators.ts`, `strategy.ts` |
| Order plan: target, stop, costs, size | `src/lib/fxscalper/plan.ts`, `money.ts` |
| Account rules and the books | `src/lib/fxscalper/risk.ts`, `clock.ts` |
| TradeLocker: request scheduler, operations, symbol discovery | `src/lib/fxscalper/tl/{transport,api,discover}.ts` |
| Credential encryption | `src/lib/fxscalper/crypto.ts` |
| Worker (Railway service) | `fxscalper/worker/{index,bot,trading,snapshot,db}.ts` |
| Database (+ rollback) | `supabase/migrations/20261023200000_fx_scalper{,_down}.sql` |
| Dashboard (admins only) | `/portal/fx-scalper` — `src/app/portal/fx-scalper`, `src/components/fx-scalper` |
| API (admins only) | `src/app/api/fx-scalper/{status,connect,account,settings,control,payouts}` |
| Deployment | `fxscalper/railway.json` (`npm run fx-scalper`) |

---

## 1. What it trades, exactly

Deterministic: arithmetic on the broker's own completed candles and quotes. No model decides an entry
or an exit.

**Candles.** The broker's 1-minute bars (`/trade/history`, INFO route), completed only, from the
instrument's documented `barSource` (BID on Genesis). 5-minute candles are built from the same
1-minute bars, so both timeframes have one source; an EMA only needs closes, and a 5-minute close is
the close of its last 1-minute bar, so the 5-minute EMAs equal the broker's. About five days of history
is loaded at start to settle the EMAs (initialisation, not a backtest).

**BUY** on the close of a 1-minute candle when all hold (SELL is the mirror):

1. M5 EMA20 > EMA50 (latest completed 5-minute candle)
2. M5 EMA20 > its value 3 completed 5-minute candles earlier
3. M1 EMA50 > EMA100
4. one of the last 3 completed 1-minute candles' high–low range met the EMA50–EMA100 band
5. slow %K crosses up through 20 (previous ≤ 20, now > 20) — Stochastic (5,3,3): raw %K over the 5 most
   recent candles (the signal candle included), slow %K = SMA3 of raw %K, %D = SMA3 of slow %K; a flat
   5-candle window (high = low) gives no value and so no signal
6. slow %K > %D
7. the signal candle closes above its open and above M1 EMA50

The candles behind rules 4–6 must be consecutive minutes (a feed gap or a reopening market → no
signal). ATR(14) is Wilder's. All of these parameters are editable defaults.

**Entry.** A market order (IOC) on the first eligible quote after the close, with the stop and target
attached as absolute prices. The signal expires 10 seconds after the candle closes; if the candle or a
fresh quote cannot be had in time, there is no trade. Skipped if the signal-source price (the bid, for
BID candles) has already moved more than 1 pip past the signal close in the trade's direction. One
entry intent per signal candle, ever; a pair trades again only after its previous trade is confirmed
closed **and** a new candle signals.

**Target (10 executable pips).** A buy closes when the executable **bid** is 10 pips above the actual
fill; a sell when the **ask** is 10 pips below. The broker-side take-profit is placed with the order
(from the quote it was priced on, rounded away from the entry to the tick) and **moved onto the real
fill** once the order fills, then verified on the broker. Measured on executable prices, so the spread
is already in it and is not deducted again; commission and charges are separate. An optional, clearly
labelled "after fees" mode widens the distance by the round-trip charges per lot. If the broker will not
take the exact target, the worker closes at fill ± 10 pips itself (checked every 250 ms against the
executable bid/ask); a broker target left **nearer** than that is removed so it cannot cut the trade
short (if the broker refuses even the removal, it stays and the journal says so — closing the trade
instead would only book its costs as a certain loss).

**Stop.** `max(3 pips, 0.5 × M1 ATR14, 2 × current spread)`, rounded out to the tick. Wider than the
pair's maximum (5 pips by default; never raised automatically) → no trade. After the fill the stop can
only **tighten**: a worse fill brings it up to the planned distance; a better fill leaves it where it
is rather than widening it.

**Time exit.** 120 seconds after the first fill the worker requests closure whatever the P&L, and keeps
requesting (after confirming the position is still open) until the broker confirms the position is
gone. It is requested at 120 s; it is not a guaranteed maximum (a broker or network delay adds to it).
The stop or the time exit can close a trade before it reaches 10 pips; neither is ever delayed to wait
for the target. Full closes only: no partials, no grid, no averaging, no martingale or recovery sizing.

## 2. Costs

The broker's API does not report commission, so the owner enters the account's **commission per 1.0
lot per side** and any **other charges per lot (round trip)**, and confirms them. Until both are entered
and confirmed, **no entries** (commission is never assumed to be zero).

Before each entry: spread + round-trip commission + other charges + slippage allowance, all in pips,
must be ≤ the pair's limit (**1.5 pips** by default) — a screening rule, not a promise of profit. The
slippage allowance starts at 0.3 pip and rises automatically to the average adverse entry slippage of
the last 20 fills when that is worse.

> With $3 per lot per side (≈ $6 round trip), commission alone is 0.6 pip on USD-quoted pairs and
> about 0.9 pip on yen pairs, so with the 0.3-pip allowance the 1.5-pip limit leaves room for a spread
> of about 0.6 pip on EURUSD/GBPUSD/AUDUSD and about 0.3 pip on USDJPY/GBPJPY/EURJPY/USDCAD.

Results are booked from actual fills: gross from the fill and exit prices (spread and slippage are in
them), then commission and charges once, at the configured rates. Pre-entry, the plan records the
spread, round-trip commission, other charges, slippage allowance, estimated net at target, estimated
cash loss at the stop and the margin estimate.

## 3. Risk limits (defaults, shown before START LIVE, editable)

| | |
|---|---|
| Risk per trade | 0.10% of risk capital |
| Open risk, all bot trades | 0.30% |
| Bot positions at once | 3 (and one per pair) |
| Lots per trade | 0.10 |
| Gross notional | 5 × risk capital — **every** position on the account counts, the owner's own included |
| Daily loss | 1% of the day's starting risk capital (17:00 → 17:00 New York) |
| Loss streak | 3 net losses in a row → no new entries for 15 minutes from the last |
| Currency exposure | at most 2 bot positions the same way in one currency |
| Margin reserve | after the trade, free margin ≥ 50% of equity |
| Excluded capital | promotional credit / payouts left in the account are not risk capital |

Size = the smallest of the risk budget, the room under the open-risk cap, the lot cap, the broker's
maximum, the notional room and the margin room, **rounded down** to the lot step. If the broker's
minimum lot does not fit, there is no trade. The cash at risk counts the stop, the slippage allowance
and both sides' charges. Risk is reserved in the database, atomically, before the order is sent.

The daily loss is the bot's realized net since 17:00 New York plus what its open trades would realize
now; deposits and withdrawals are not in it. At the limit: no new entries, the bot's positions are
closed, and entries resume at the next 17:00 New York.

No new entries (open positions are still managed) 16:55–17:10 New York (rollover), after 16:45 on
Friday, on Saturday, and until 10 minutes after the Sunday 17:00 reopen — editable. A pair that already
has a position the bot did not open is sat out (on an account that nets, the bot's order would change
that position). The broker's quote carries no timestamp; a quote that has not changed for a minute is
treated as delayed.

## 4. TradeLocker

Official REST API (public-api.tradelocker.com, "Trading API" v2.11), cross-checked with the official
Python SDK (0.56.x). Hosts are fixed: `https://live.tradelocker.com/backend-api`.

* `accountId` goes in the path, `accNum` in the `accNum` header; quotes/candles use the INFO route,
  orders the TRADE route; an order id is not a position id.
* **Quantity is in lots.** The place-order reference page calls `qty` "units", but the same
  documentation gives min/max lot "in lots", lot size "in units", sizes a close in "lots" and computes
  order capital as "Qty × Lot size × Price"; the official SDK checks qty against 0.01; every order this
  repository has placed on this broker used lots. As a live check, the first bot position that moves 2+
  pips is compared with the broker's own P&L: units instead of lots would be off by 100,000×, and the
  bot would stop at once (emergency stop).
* Rate limits are read from `/trade/config` (`rateLimits`) per route type and never exceeded (the
  published count over a window stretched by 15% + 50 ms). One scheduler serves every call, protective
  work first (closing, stop/target, verification), then entries, signal candles, reconciliation, and
  dashboard reads last; a 429 pauses the route for Retry-After, an edge block (1015) pauses everything.
* There is no public price stream: quotes are polled (each pair every ~5 s for the dashboard; an entry
  always fetches a fresh one). Quote latency and request latencies are on the dashboard.
* **An acknowledgement is not a fill; a close request is not a confirmed closure.** The entry intent is
  written before the order is sent. An order that times out or gets a 5xx is **uncertain**: never
  re-sent, settled from the broker's records by its order id and its label (`strategyId`, `OMFX-…` —
  identification only; the API has no idempotency). No trace after 90 s → recorded as not placed (a
  position carrying its label would still be found and managed).
* Stop and target are verified on the broker after every fill (3 attempts to set them). No acceptable
  stop → the position is closed, new entries pause, and the dashboard shows the alarm until the owner
  resumes.
* Close-all (owner, emergency stop, daily loss limit) is recorded before anything else is attempted and
  blocks new entries, START and Resume until no bot position is left; a failed pause write cannot stop
  it.
* Credentials: typed into the dashboard, sent to this site's server only, exchanged with TradeLocker
  for tokens; tokens (and, only with "stay connected", the email and password for unattended re-sign-in)
  are stored AES-256-GCM encrypted with a key outside the database. Never in the browser, logs, the
  journal or source control.

## 5. Payouts

Unknown terms count as **zero**. The owner enters the Genesis agreement's terms (rate per eligible lot,
per side or per round turn, any minimum hold) and records what the broker actually confirms or pays —
by statement import (CSV) or by hand. There is no compensation API and none is invented. Results show
net trading P&L, closed lots, eligible lots, estimated / broker-confirmed / paid compensation,
reversals, and the combined figure — compensation never turns a losing trade into a winning one. The
bot never trades for volume: every order comes from a signal.

## 6. Setting it up

1. **Database**: apply `supabase/migrations/20261023200000_fx_scalper.sql` (additive; its own tables).
2. **Worker**: a separate Railway service from this repository, config path `fxscalper/railway.json`
   (start command `npm run fx-scalper`, one replica, restart always). Variables — the same values the
   web app uses: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FLOW_ENC_KEY` (or a dedicated
   `FX_SCALPER_ENC_KEY` set identically on the web app). Optional `TL_DEVELOPER_API_KEY`.
3. **Dashboard** (`/portal/fx-scalper`, the owner's account only): Account → connect TradeLocker LIVE (server, email,
   password) → pick the account. The worker discovers the seven pairs within seconds. "Stay connected"
   is on by default (the email and password are kept encrypted so the worker can sign in again by itself
   if the broker ends the session); untick it to keep only the session tokens.
4. **Settings**: enter the commission and confirm the costs; review the limits.
5. **START LIVE**: review the summary and confirm. From then on qualifying signals are traded without
   asking. **Pause** stops new entries (open positions are still managed), **Stop** stops the bot,
   **Close all bot positions** closes only the bot's, **Emergency stop** stops and closes every bot
   position and cancels the bot's working orders. **Close EVERY position on the account** (Account tab,
   typed confirmation) closes everything, including the owner's own and other tools' positions.

## 7. Restart and recovery

Kill it, redeploy it, or let it crash: open positions keep their broker-side stop and target. A new
process waits for the lease (only one worker can command the account; a stale worker's trade writes
are refused by its fence), takes over any owner command (close all, emergency stop) the previous worker
left unfinished, reloads the books, asks the broker about every trade that was in flight,
adopts bot-labelled positions its books missed (or closes ones it has no record of), closes anything
whose 120-second exit passed while it was away, and only then allows new entries. START LIVE persists
across restarts. If the database is unreachable for more than ~14 s the worker stops writing to the
broker until its lease is confirmed again (two workers commanding one account is worse than a delayed
time exit; the broker-side stop and target still protect).

## 8. Still needed from the broker / the owner

* The account's **commission and charges** (per lot, per side or round turn). Required before START.
* The **Genesis partner agreement** terms for payout tracking (public pages could not be read).
* Whether Genesis allows **automated scalping / sub-2-minute holds** on this account type and under the
  partner agreement (client agreement not publicly readable) — the owner's call to confirm.
* Whether the account **nets or hedges** positions (not exposed by the API). The bot sits out any pair
  with a position it did not open, so it is safe either way.
* Optional: a **TradeLocker Developer Program key** (`TL_DEVELOPER_API_KEY`) for less restrictive rate
  limits.
* The broker's **minimum stop distance** is not published by the API; a refused stop is journalled.
