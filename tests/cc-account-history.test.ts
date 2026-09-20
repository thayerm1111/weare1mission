/**
 * THE LIMITS THAT WERE NEVER CONNECTED.
 *
 * The validator built its account state out of hardcoded zeros, so six risk limits — daily loss,
 * drawdown, weekly loss, consecutive losses, session count, cooldown — were all comparing against a
 * constant 0 and could never fire. The only real restraint was a fixed count of entries per day, which
 * treats four winners exactly like four losers.
 *
 * These tests assert the limits now fire on real numbers. If any of them starts passing trivially
 * again, the brakes are disconnected and the count cap is not there any more to stand in for them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkAccountLimits, DEFAULT_LIMITS, type AccountState } from "../command-center/core/risk";
import { dayPnlPct, weekPnlPct, summarise, UNREADABLE, type TradingHistory } from "../command-center/engines/accountHistory";

const EQUITY = 435_041;

const history = (over: Partial<TradingHistory> = {}): TradingHistory => ({
  readable: true, dayPnl: 0, weekPnl: 0, dayPeakEquity: EQUITY,
  consecutiveLosses: 0, tradesToday: 0, lastTradeAtMs: null, ...over,
});

const stateFrom = (h: TradingHistory, equity = EQUITY, over: Partial<AccountState> = {}): AccountState => ({
  equity,
  openRiskPct: 0,
  dayPnlPct: dayPnlPct(h, equity),
  dayPeakEquity: h.dayPeakEquity,
  weekPnlPct: weekPnlPct(h, equity),
  consecutiveLosses: h.consecutiveLosses,
  tradesThisSession: h.tradesToday,
  openPositions: 0,
  lastTradeAtMs: h.lastTradeAtMs,
  ...over,
});

const gate = (s: AccountState) => checkAccountLimits(s, DEFAULT_LIMITS, Date.now(), { spread: 0.2, stopPips: 80, newTradeRiskPct: 0.5 });

test("a quiet account is allowed to trade", () => {
  assert.equal(gate(stateFrom(history())).ok, true);
});

test("the daily loss limit fires on a real losing day", () => {
  // Down 3.1% of where the day started. The limit is 3%.
  const start = EQUITY / (1 - 0.031);
  const dayPnl = EQUITY - start;
  const g = gate(stateFrom(history({ dayPnl, dayPeakEquity: start })));
  assert.equal(g.ok, false, "a 3.1% losing day must stop trading");
  assert.match(g.reason, /daily loss/i);
  assert.equal(g.hard, true, "a loss limit is not something confidence may override");
});

test("the daily loss limit does NOT fire on a winning day of the same size", () => {
  // The asymmetry is the whole point: a count cap could not tell these two apart.
  const g = gate(stateFrom(history({ dayPnl: 13_000, dayPeakEquity: EQUITY })));
  assert.equal(g.ok, true);
});

test("the drawdown limit fires after giving back a run-up", () => {
  // Up to 460k during the day, now back at 435k — 5.4% off the peak against a 4% limit.
  const g = gate(stateFrom(history({ dayPnl: 5_000, dayPeakEquity: 460_000 })));
  assert.equal(g.ok, false, "a green day can still be a drawdown stop");
  assert.match(g.reason, /drawdown/i);
});

test("four losses in a row stops the account", () => {
  const g = gate(stateFrom(history({ consecutiveLosses: 4 })));
  assert.equal(g.ok, false);
  assert.match(g.reason, /in a row/i);
  // Three is still allowed — the limit is a stop, not a discouragement.
  assert.equal(gate(stateFrom(history({ consecutiveLosses: 3 }))).ok, true);
});

test("the cooldown fires right after an entry and clears later", () => {
  const justNow = history({ lastTradeAtMs: Date.now() - 30_000 });
  const g = gate(stateFrom(justNow));
  assert.equal(g.ok, false, "30 seconds after an entry is inside the 3-minute cooldown");
  assert.match(g.reason, /cooldown/i);

  const earlier = history({ lastTradeAtMs: Date.now() - 10 * 60_000 });
  assert.equal(gate(stateFrom(earlier)).ok, true, "ten minutes later it may trade again");
});

test("an already-open position blocks another", () => {
  assert.equal(gate(stateFrom(history(), EQUITY, { openPositions: 1 })).ok, false);
});

test("percentages are measured against where the day started, not where it ended", () => {
  /*
   * Dividing by current equity understates a loss: down 10k on a 435k account is 2.30% of what is left
   * but 2.25% of what there was. Small here, and the direction matters — the denominator must be the
   * starting figure so the limit means what it says.
   */
  const h = history({ dayPnl: -10_000 });
  const pct = dayPnlPct(h, EQUITY);
  assert.ok(pct < 0);
  assert.equal(pct, +((-10_000 / (EQUITY + 10_000)) * 100).toFixed(3));
});

test("unreadable history is not a zero day", () => {
  /*
   * The failure that matters most. UNREADABLE must never look like a clean slate to the caller — the
   * validator refuses on `readable === false` before it ever reaches these limits, because an account
   * whose losses cannot be read is the last one that should be allowed another trade.
   */
  assert.equal(UNREADABLE.readable, false);
  const asState = stateFrom(UNREADABLE as TradingHistory);
  assert.equal(gate(asState).ok, true, "the numbers alone look innocent, which is exactly why the readable flag is the gate");
});

/* ── the arithmetic itself, without a database ──────────────────────────── */

const DAY = 24 * 3600_000;
// A fixed mid-day instant so "today" and "earlier this week" are unambiguous.
const NOW = Date.UTC(2026, 8, 23, 15, 0, 0);
const todayAt = (h: number) => Date.UTC(2026, 8, 23, h, 0, 0);

test("summarise separates today from the rest of the week", () => {
  const s = summarise({
    equityNow: 100_000,
    openedAtMs: [NOW - 2 * DAY, todayAt(9), todayAt(12)],
    closed: [
      { at: NOW - 2 * DAY, pnl: -1_000 },   // earlier in the week
      { at: todayAt(9), pnl: 500 },
      { at: todayAt(12), pnl: -300 },
    ],
    now: NOW,
  });
  assert.equal(s.dayPnl, 200, "today is +500 -300");
  assert.equal(s.weekPnl, -800, "the week includes the earlier loser");
  assert.equal(s.tradesToday, 2, "only today's two opens count");
  assert.equal(s.lastTradeAtMs, todayAt(12));
});

test("the day's peak is the high-water mark of the equity curve, not the close", () => {
  /*
   * Up 5,000 then down 4,000: the account ends the day +1,000 but touched +5,000 on the way. A
   * drawdown rule that used the closing figure would see no drawdown at all, which is precisely the
   * day a trader most needs it to fire.
   */
  const s = summarise({
    equityNow: 101_000,
    openedAtMs: [todayAt(9), todayAt(11)],
    closed: [{ at: todayAt(9), pnl: 5_000 }, { at: todayAt(11), pnl: -4_000 }],
    now: NOW,
  });
  assert.equal(s.dayPnl, 1_000);
  assert.equal(s.dayPeakEquity, 105_000, "started at 100k, peaked at 105k");
  // 3.81% off the peak — visible to the 4% limit, invisible to anything using the closing number.
  assert.ok((105_000 - 101_000) / 105_000 > 0.038);
});

test("a losing streak is counted from the most recent trade and broken by a winner", () => {
  const losses = summarise({
    equityNow: 100_000, openedAtMs: [],
    closed: [{ at: todayAt(9), pnl: -100 }, { at: todayAt(10), pnl: -100 }, { at: todayAt(11), pnl: -100 }],
    now: NOW,
  });
  assert.equal(losses.consecutiveLosses, 3);

  const broken = summarise({
    equityNow: 100_000, openedAtMs: [],
    closed: [{ at: todayAt(9), pnl: -100 }, { at: todayAt(10), pnl: -100 }, { at: todayAt(11), pnl: 50 }],
    now: NOW,
  });
  assert.equal(broken.consecutiveLosses, 0, "the most recent trade won, so there is no streak");
});

test("out-of-order rows are sorted before the streak is counted", () => {
  // The database returns rows in whatever order it likes. A streak read off an unsorted array is fiction.
  const s = summarise({
    equityNow: 100_000, openedAtMs: [],
    closed: [{ at: todayAt(11), pnl: 50 }, { at: todayAt(9), pnl: -100 }, { at: todayAt(10), pnl: -100 }],
    now: NOW,
  });
  assert.equal(s.consecutiveLosses, 0, "the latest trade by time is the winner at 11:00");
});

test("an account that has not traded reports a clean, readable slate", () => {
  const s = summarise({ equityNow: 100_000, openedAtMs: [], closed: [], now: NOW });
  assert.equal(s.readable, true);
  assert.equal(s.dayPnl, 0);
  assert.equal(s.dayPeakEquity, 100_000);
  assert.equal(s.lastTradeAtMs, null);
  assert.equal(s.consecutiveLosses, 0);
});
