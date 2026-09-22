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
import { checkAccountLimits, DEFAULT_LIMITS, FLOW_GOLD_LIMITS, COOLDOWN_BY_STYLE, type AccountState } from "../command-center/core/risk";
import { dayPnlPct, weekPnlPct, summarise, UNREADABLE, type TradingHistory } from "../command-center/engines/accountHistory";
import { inWeekendCloseWindow } from "../command-center/core/sessions";

const EQUITY = 435_041;

const history = (over: Partial<TradingHistory> = {}): TradingHistory => ({
  readable: true, dayPnl: 0, weekPnl: 0, dayPeakEquity: EQUITY,
  consecutiveLosses: 0, tradesToday: 0, lastTradeAtMs: null, entriesLastHour: 0, lastLossAtMs: null, ...over,
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
  entriesLastHour: h.entriesLastHour,
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

/* ── the policy that is actually live: FLOW's, not a separate set ───────── */

const flowGate = (s: AccountState, style: keyof typeof COOLDOWN_BY_STYLE = "quick") =>
  checkAccountLimits(
    s,
    { ...FLOW_GOLD_LIMITS, cooldownMs: COOLDOWN_BY_STYLE[style] },
    Date.now(),
    { spread: 0.2, stopPips: 80, newTradeRiskPct: 0.5 },
  );

test("FLOW's gold policy runs no daily loss limit", () => {
  // Down 8% on the day. The desk does not stop gold for this, and neither does this.
  const start = EQUITY / (1 - 0.08);
  const g = flowGate(stateFrom(history({ dayPnl: EQUITY - start, dayPeakEquity: start })));
  assert.equal(g.ok, true, "FLOW enforces no daily loss limit on gold, so nor does the Command Center");
});

test("FLOW's gold policy runs no drawdown or weekly limit", () => {
  const g = flowGate(stateFrom(history({ dayPnl: 5_000, dayPeakEquity: 600_000, weekPnl: -60_000 })));
  assert.equal(g.ok, true);
});

test("FLOW's gold policy runs no consecutive-loss breaker", () => {
  /*
   * Gold is exempt from FLOW's breaker by the owner's decision of 2026-09-16 — forex keeps it. Ten in
   * a row would not pause gold on the desk, so it does not pause it here either.
   */
  const g = flowGate(stateFrom(history({ consecutiveLosses: 10 })));
  assert.equal(g.ok, true);
});

test("a null limit is skipped, and is NOT the same as a zero one", () => {
  /*
   * The trap this replaced. `dayPnlPct <= -Math.abs(0)` is true for any loss at all, so a limit
   * "switched off" by setting it to zero would stop the account on its first losing cent — the exact
   * opposite of off. Null is checked for and skipped; zero still means zero.
   */
  const losing = stateFrom(history({ dayPnl: -1 }));
  assert.equal(checkAccountLimits(losing, { ...FLOW_GOLD_LIMITS, maxDailyLossPct: null }, Date.now(), { spread: 0.2, stopPips: 80 }).ok, true);
  assert.equal(checkAccountLimits(losing, { ...FLOW_GOLD_LIMITS, maxDailyLossPct: 0 }, Date.now(), { spread: 0.2, stopPips: 80 }).ok, false);
});

test("the cooldown is FLOW's ninety minutes for a quick trade, not three", () => {
  // Twenty minutes after an entry: fine under the old 3-minute rule, blocked under the desk's.
  const twentyMin = stateFrom(history({ lastTradeAtMs: Date.now() - 20 * 60_000 }));
  const g = flowGate(twentyMin, "quick");
  assert.equal(g.ok, false, "90 minutes is the brake that does the work now");
  assert.match(g.reason, /cooldown/i);

  const twoHours = stateFrom(history({ lastTradeAtMs: Date.now() - 120 * 60_000 }));
  assert.equal(flowGate(twoHours, "quick").ok, true);
});

test("each style carries FLOW's own cooldown", () => {
  const threeHoursAgo = stateFrom(history({ lastTradeAtMs: Date.now() - 3 * 3600_000 }));
  assert.equal(flowGate(threeHoursAgo, "quick").ok, true, "quick is 90 minutes — cleared");
  assert.equal(flowGate(threeHoursAgo, "hold").ok, true, "hold is 180 minutes — just cleared");
  assert.equal(flowGate(threeHoursAgo, "swing").ok, false, "swing is 480 minutes — still cooling");
  assert.equal(COOLDOWN_BY_STYLE.quick, 90 * 60_000);
  assert.equal(COOLDOWN_BY_STYLE.hold, 180 * 60_000);
  assert.equal(COOLDOWN_BY_STYLE.swing, 480 * 60_000);
});

test("the hourly entry budget matches FLOW's default of ten", () => {
  assert.equal(FLOW_GOLD_LIMITS.maxEntriesPerHour, 10);
  const busy = stateFrom(history(), EQUITY, { entriesLastHour: 10, lastTradeAtMs: null });
  const g = flowGate(busy);
  assert.equal(g.ok, false);
  assert.match(g.reason, /last hour/i);
  assert.equal(flowGate(stateFrom(history(), EQUITY, { entriesLastHour: 9 })).ok, true);
});

test("one position at a time still holds", () => {
  // The rule that makes a 90-minute cooldown on a single symbol into a real ceiling.
  assert.equal(FLOW_GOLD_LIMITS.maxOpenPositions, 1);
  assert.equal(flowGate(stateFrom(history(), EQUITY, { openPositions: 1 })).ok, false);
});

test("summarise counts entries in the last rolling hour", () => {
  const s = summarise({
    equityNow: 100_000,
    openedAtMs: [NOW - 90 * 60_000, NOW - 30 * 60_000, NOW - 5 * 60_000],
    closed: [], now: NOW,
  });
  assert.equal(s.entriesLastHour, 2, "the 90-minute-old entry has aged out of the hour");
  assert.equal(s.tradesToday, 3);
});

test("the Friday close window stops automation, not a member", () => {
  // 4:45pm New York on a Friday — inside the half hour FLOW stops opening on every automated path.
  assert.equal(inWeekendCloseWindow(new Date("2026-09-25T20:45:00Z")), true);
  // 3:45pm New York the same day is still an ordinary trading hour.
  assert.equal(inWeekendCloseWindow(new Date("2026-09-25T19:45:00Z")), false);
  // Thursday at the same clock time is not the weekly close.
  assert.equal(inWeekendCloseWindow(new Date("2026-09-24T20:45:00Z")), false);
});
