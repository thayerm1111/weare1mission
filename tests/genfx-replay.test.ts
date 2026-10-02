import { test } from "node:test";
import assert from "node:assert/strict";
import { PAIRS } from "../src/lib/genfx/pairs";
import { replay, aggregate, runTrades, openTrade, manageBar, type Bar, type EnterEvent } from "../src/lib/genfx/replay";
import { inScanQuietWindow, inWeekendCloseWindow } from "../src/lib/flow/autoExec";
import { synthBars, MONDAY } from "./_genfx_fixture";

/*
 * The replay is what stands between "the engine has a record on gold" and "a member's account takes a
 * EUR/USD trade from it", so it gets held to its own promises: it never sees the future, it charges
 * costs, and every doubt inside a candle is settled against the trade.
 */
const E = PAIRS.EURUSD;
const M5 = 300_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({ t: MONDAY + i * M5, o, h, l, c });
const flat = (i: number, p: number): Bar => bar(i, p, p + 0.00002, p - 0.00002, p);
const ev = (i: number, side: "buy" | "sell", fill: number, stop: number, tp: number, extra: Partial<EnterEvent> = {}): EnterEvent => ({
  i, at: MONDAY + (i + 1) * M5, mode: "intraday", side, setup: "zone", entryLow: fill - 0.00003, entryHigh: fill + 0.00003, stop, tp, fill,
  intrabar: false, room: 0.0006, slope: null, choch: null, ...extra,
});
const LONG = { sizeEntry: 1.0840, stop: 1.0825, tp: 1.0870, stopPips: 15 };

test("timeframes are built from the 5-minute candles, on UTC boundaries, weeks from Monday", () => {
  const base = [bar(0, 1.08, 1.0803, 1.0799, 1.0802), bar(1, 1.0802, 1.0806, 1.0801, 1.0805), bar(2, 1.0805, 1.0807, 1.0798, 1.0799), bar(3, 1.0799, 1.0801, 1.0795, 1.0796)];
  const m15 = aggregate(base, "15min");
  assert.equal(m15.bars.length, 2);
  assert.deepEqual(m15.bars[0], { o: 1.08, h: 1.0807, l: 1.0798, c: 1.0799 });
  assert.equal(m15.end[0], MONDAY + 15 * 60_000);
  assert.equal(m15.rows[0].datetime, "2026-03-02 00:00:00");
  assert.deepEqual(m15.bars[1], { o: 1.0799, h: 1.0801, l: 1.0795, c: 1.0796 });
  const week = aggregate([bar(0, 1, 1, 1, 1), bar(288 * 6 + 287, 2, 2, 2, 2), bar(288 * 7, 3, 3, 3, 3)], "1week");
  assert.equal(week.bars.length, 2);                                   // Sunday 23:55 is still the first week
  assert.equal(week.rows[1].datetime, "2026-03-09 00:00:00");          // the next one starts on Monday
  assert.equal(new Date(MONDAY).getUTCDay(), 1);
});

test("a candle that holds both the stop and the target is a LOSS", () => {
  const o = openTrade(E, ev(0, "buy", 1.0840, 1.0825, 1.0870), LONG, 1);
  assert.deepEqual(manageBar(E, o, bar(1, 1.0842, 1.0872, 1.0824, 1.0850), true, false), { exit: 1.0825, how: "stop" });
  const s = openTrade(E, ev(0, "sell", 1.0840, 1.0855, 1.0810), { sizeEntry: 1.0840, stop: 1.0855, tp: 1.0810, stopPips: 15 }, 1);
  assert.deepEqual(manageBar(E, s, bar(1, 1.0838, 1.0856, 1.0808, 1.0830), false, false), { exit: 1.0855, how: "stop" });
});

test("a trade entered inside a candle can be stopped by that candle but not paid by it", () => {
  const paid = openTrade(E, ev(0, "buy", 1.0840, 1.0825, 1.0870, { intrabar: true }), LONG, 1);
  assert.equal(manageBar(E, paid, bar(0, 1.0850, 1.0875, 1.0838, 1.0872), true, true), null);       // ran to the target: not credited
  const hit = openTrade(E, ev(0, "buy", 1.0840, 1.0825, 1.0870, { intrabar: true }), LONG, 1);
  assert.deepEqual(manageBar(E, hit, bar(0, 1.0850, 1.0852, 1.0822, 1.0830), true, true), { exit: 1.0825, how: "stop" });
});

test("a candle that opens beyond the stop fills at the open, not at the stop", () => {
  const o = openTrade(E, ev(0, "buy", 1.0840, 1.0825, 1.0870), LONG, 1);
  assert.deepEqual(manageBar(E, o, bar(1, 1.0811, 1.0816, 1.0806, 1.0812), true, false), { exit: 1.0811, how: "stop" });   // the Sunday gap
  const s = openTrade(E, ev(0, "sell", 1.0840, 1.0855, 1.0810), { sizeEntry: 1.0840, stop: 1.0855, tp: 1.0810, stopPips: 15 }, 1);
  assert.deepEqual(manageBar(E, s, bar(1, 1.0868, 1.0870, 1.0861, 1.0863), true, false), { exit: 1.0868, how: "stop" });
});

test("the manager's break-even for a currency pair: trigger at the nearer of halfway and +1R, lock at +5 pips plus the spread pad", () => {
  // Entry 1.0840, stop 15 pips, target 30. Halfway and +1R are both 1.0855. Lock = +5 +3 = 1.0848.
  const o = openTrade(E, ev(0, "buy", 1.0840, 1.0825, 1.0870), LONG, 1);
  assert.ok(Math.abs(o.beTrigger - 1.0855) < 1e-9 && Math.abs(o.bePx - 1.0848) < 1e-9);
  assert.equal(manageBar(E, o, bar(1, 1.0842, 1.0854, 1.0839, 1.0852), true, false), null);
  assert.equal(o.be, false);                                           // a pip short of the trigger
  assert.equal(manageBar(E, o, bar(2, 1.0852, 1.0856, 1.0850, 1.0853), true, false), null);
  assert.equal(o.be, true);
  assert.ok(Math.abs(o.cur - 1.0848) < 1e-9);                          // the stop is now in profit
  const out = manageBar(E, o, bar(3, 1.0853, 1.0854, 1.0847, 1.0849), true, false);
  assert.deepEqual(out, { exit: o.bePx, how: "breakeven" });
  // The trigger candle itself closing back through the lock is an exit at the lock.
  const p = openTrade(E, ev(0, "buy", 1.0840, 1.0825, 1.0870), LONG, 1);
  assert.deepEqual(manageBar(E, p, bar(1, 1.0842, 1.0857, 1.0841, 1.0846), true, false), { exit: p.bePx, how: "breakeven" });
  // A tight stop: +1R is 6 pips, but the trigger never sits closer than 8, and price must clear the lock by 2.
  const t = openTrade(E, ev(0, "buy", 1.0840, 1.0834, 1.0852), { sizeEntry: 1.0840, stop: 1.0834, tp: 1.0852, stopPips: 6 }, 1);
  assert.ok(Math.abs(t.beTrigger - 1.0848) < 1e-9);
  assert.equal(manageBar(E, t, bar(1, 1.0842, 1.08495, 1.0841, 1.0849), true, false), null);
  assert.equal(t.be, false);                                           // 9.5 pips: past the trigger, not 2 pips past the lock
  // Left alone, none of this happens: the same candles leave the stop where it was.
  const raw = openTrade(E, ev(0, "buy", 1.0840, 1.0825, 1.0870), LONG, 1);
  assert.equal(manageBar(E, raw, bar(2, 1.0852, 1.0856, 1.0850, 1.0853), false, false), null);
  assert.equal(raw.be, false);
  assert.equal(raw.cur, 1.0825);
});

test("after break-even the stop trails, and a target is a target either way", () => {
  const o = openTrade(E, ev(0, "buy", 1.0840, 1.0825, 1.0870), LONG, 1);
  manageBar(E, o, bar(1, 1.0842, 1.0856, 1.0841, 1.0855), true, false);
  assert.equal(o.be, true);
  // A push to 1.0862 that holds: the stop ratchets up behind it (a quarter of R behind the best, here).
  assert.equal(manageBar(E, o, bar(2, 1.0855, 1.0862, 1.0854, 1.0861), true, false), null);
  assert.ok(o.cur > o.bePx && o.cur < 1.0862, String(o.cur));
  const before = o.cur;
  // It never moves back.
  assert.equal(manageBar(E, o, bar(3, 1.0861, 1.08615, 1.08595, 1.0860), true, false), null);
  assert.ok(o.cur >= before);
  // A pullback through it closes the trade in profit.
  const x = manageBar(E, o, bar(4, 1.0860, 1.0860, 1.0850, 1.0851), true, false);
  assert.ok(x && x.how === "trail" && x.exit > o.entry);
  const t = openTrade(E, ev(0, "buy", 1.0840, 1.0825, 1.0870), LONG, 1);
  assert.deepEqual(manageBar(E, t, bar(1, 1.0842, 1.0871, 1.0841, 1.0869), true, false), { exit: 1.0870, how: "target" });
  assert.deepEqual(manageBar(E, openTrade(E, ev(0, "buy", 1.0840, 1.0825, 1.0870), LONG, 1), bar(1, 1.0842, 1.0871, 1.0841, 1.0869), false, false), { exit: 1.0870, how: "target" });
});

test("every trade pays its cost, exactly", () => {
  const base = [flat(0, 1.0840), bar(1, 1.0840, 1.0872, 1.0838, 1.0870), flat(2, 1.0870), bar(3, 1.0870, 1.0871, 1.0854, 1.0856), flat(4, 1.0856)];
  const events = [ev(0, "buy", 1.0840, 1.0825, 1.0870), ev(2, "sell", 1.0870, 1.0885, 1.0840)];
  const free = runTrades(E, base, events, false, 0, 10), paid = runTrades(E, base, events, false, 1.4, 10);
  assert.equal(free.trades.length, 2);
  assert.deepEqual(free.trades.map((t) => [t.how, t.pips]), [["target", 30], ["open", 14]]);
  assert.deepEqual(paid.trades.map((t) => [t.how, t.pips]), [["target", 28.6], ["open", 12.6]]);
  assert.equal(paid.trades[0].r, 1.91);                                // 28.6 pips on a 15-pip stop
  // A stop-out costs the stop AND the spread.
  const lose = runTrades(E, [flat(0, 1.0840), bar(1, 1.0840, 1.0841, 1.0824, 1.0826)], [ev(0, "buy", 1.0840, 1.0825, 1.0870)], true, 1, 10);
  assert.deepEqual(lose.trades.map((t) => [t.how, t.pips, t.r]), [["stop", -16, -1.07]]);
});

test("one trade per pair per side; the other side may be open at the same time", () => {
  const base = Array.from({ length: 6 }, (_, i) => flat(i, 1.0840));
  const out = runTrades(E, base, [ev(0, "buy", 1.0840, 1.0825, 1.0870), ev(1, "buy", 1.0840, 1.0826, 1.0871), ev(2, "sell", 1.0840, 1.0855, 1.0810), ev(3, "sell", 1.0840, 1.0856, 1.0811)], true, 1, 10);
  assert.deepEqual(out.placement, { calls: 4, placed: 2, skipped: { one_open: 2 } });
  assert.deepEqual(out.trades.map((t) => t.side).sort(), ["buy", "sell"]);
  assert.ok(out.trades.every((t) => t.how === "open"));
});

test("the guards run in the replay as they do live: a tight stop, a chased price, three losses", () => {
  const base = Array.from({ length: 40 }, (_, i) => flat(i, 1.0840));
  const tight = runTrades(E, base, [ev(0, "buy", 1.0840, 1.0833, 1.0858)], true, 1, 10);
  assert.deepEqual(tight.placement, { calls: 1, placed: 0, skipped: { stop_too_tight: 1 } });
  assert.equal(runTrades(E, base, [ev(0, "buy", 1.0840, 1.0833, 1.0858)], true, 1, 6).placement.placed, 1);      // the setting is honoured
  const chased = runTrades(E, base, [ev(0, "buy", 1.0862, 1.0825, 1.0870, { entryLow: 1.0839, entryHigh: 1.0841 })], true, 1, 10);
  assert.deepEqual(chased.placement.skipped, { chased: 1 });
  // Three stop-outs, then a fourth call inside the pause is refused by the desk breaker.
  const losing: Bar[] = [];
  const events: EnterEvent[] = [];
  for (let k = 0; k < 3; k++) { losing.push(flat(k * 2, 1.0840), bar(k * 2 + 1, 1.0840, 1.0841, 1.0822, 1.0840)); events.push(ev(k * 2, "buy", 1.0840, 1.0825 - k * 0.0001, 1.0870)); }
  losing.push(flat(6, 1.0840), flat(7, 1.0840));
  events.push(ev(6, "buy", 1.0840, 1.0821, 1.0875));
  const br = runTrades(E, losing, events, true, 1, 10);
  assert.equal(br.trades.filter((t) => t.how === "stop").length, 3);
  assert.deepEqual(br.placement, { calls: 4, placed: 3, skipped: { desk_breaker: 1 } });
});

test("the whole pipeline over a market: it never sees the future", async () => {
  const base = synthBars({ seed: 7, start: MONDAY, bars: 1500, price: 1.085, pip: E.pip, dec: E.dec, volPips: 2.2 });
  const params = { modes: ["quick", "intraday"] as ("quick" | "intraday")[], warmupBars: 700, minStopPips: 4, keepEvents: true };
  const cutIdx = 1180, cut = base[cutIdx].t + M5;
  const full = await replay(E, base, params);
  const part = await replay(E, base.slice(0, cutIdx + 1), params);

  // Every call the truncated run made, the full run made identically — same moment, same levels, same fill.
  const before = (full.events ?? []).filter((e) => e.i <= cutIdx);
  assert.ok((part.events ?? []).length > 15, `the sample must contain calls (saw ${(part.events ?? []).length})`);
  assert.deepEqual(part.events, before);
  // And every trade that had closed by then closed the same way. (Trades still open at the cut are marked
  // "open" at the last price in the short run, so they are not comparable; a trade the long run opened
  // after one of those closed is not in the short run at all.)
  const settled = (ts: typeof full.trades) => ts.filter((t) => t.how !== "open" && t.closedAt <= cut);
  const stillOpen = part.trades.filter((t) => t.how === "open");
  const firstOpenAt = stillOpen.length ? Math.min(...stillOpen.map((t) => t.openedAt)) : Infinity;
  assert.deepEqual(settled(part.trades).filter((t) => t.openedAt < firstOpenAt), settled(full.trades).filter((t) => t.openedAt < firstOpenAt));
  assert.ok(settled(part.trades).length > 0, "the sample must contain closed trades");

  // The books add up, and nothing was called while the desk is shut.
  for (const out of [full, part]) {
    const skipped = Object.values(out.placement.skipped).reduce((a, b) => a + b, 0);
    assert.equal(out.placement.calls, (out.events ?? []).length);
    assert.equal(out.placement.placed + skipped, out.placement.calls);
    assert.equal(out.managed.all.n, out.placement.placed);
    for (const e of out.events ?? []) { const d = new Date(e.at); assert.ok(!inScanQuietWindow(d) && !inWeekendCloseWindow(d), d.toISOString()); }
    assert.equal(out.costPips, 1);
    assert.equal(out.minStopPips, 4);
    assert.ok(out.ranges["5min"].pips > 0.5 && out.ranges["5min"].pips < 20);
    assert.ok(Math.abs(out.ranges["5min"].units - out.ranges["5min"].pips) < 0.06);   // EUR/USD: one pip is one unit
  }
  assert.equal(full.steps, base.length - 700);
  // The same input gives the same output.
  assert.deepEqual(await replay(E, base.slice(0, cutIdx + 1), params), part);
});
