import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAIRS } from "../src/lib/genfx/pairs";
import { replay, aggregate, runTrades, openTrade, manageBar, bucketStart, zoneOffsetMs, type Bar, type EnterEvent } from "../src/lib/genfx/replay";
import { zoneError, rankZones, chooseZone, sameClockOver, seasonWindows, ZONE_CANDIDATES } from "../src/lib/genfx/history";
import { noiseRoom } from "../src/lib/genfx/guards";
import { gradeCandle, sameSetupZone, GRADE_EXPIRY_MS } from "../src/lib/genfx/decide";
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

  // A setup entered INSIDE candle i is judged on the market as it stood when that candle began: the
  // noise room it was given comes from the twelve candles before it, never from the candle itself.
  const evs = full.events ?? [];
  const inside = evs.filter((e) => e.intrabar), atClose = evs.filter((e) => !e.intrabar);
  assert.ok(inside.length > 3 && atClose.length > 3, `${inside.length} entered inside a candle, ${atClose.length} at a close`);
  for (const e of inside) assert.equal(e.room, noiseRoom(E, base.slice(e.i - 12, e.i)), `inside candle ${e.i}`);
  for (const e of atClose) assert.equal(e.room, noiseRoom(E, base.slice(e.i - 11, e.i + 1)), `at the close of candle ${e.i}`);
  // Every call carries what gold's trend gate would have said about it (reported, never applied).
  assert.ok(evs.every((e) => e.trend === null || e.trend === "with" || e.trend === "against" || e.trend === "mixed"));
  // All three runs are over the same calls; the run that settles every doubt against the trade is not the better one.
  assert.equal(full.managedLow.all.n + Object.values(runTrades(E, base, evs, "managedLow", 1, 4).placement.skipped).reduce((a, b) => a + b, 0), evs.length);
  // (Which of the two totals is lower is not a law — a trade that survives a candle can end worse later — so it is not asserted.)
  assert.equal(full.zone, "UTC");
});

test("no lookahead on any horizon, on the feed's own clock: Quick, Intraday and Swing, with 4-hour and daily candles cut on Sydney time", async () => {
  // Thirteen weeks of market: eleven for Swing to have its ten weekly candles, then two that are tested.
  const base = synthBars({ seed: 5, start: MONDAY, bars: 18_400, price: 1.085, pip: E.pip, dec: E.dec, volPips: 2.2 });
  const params = { warmupBars: 15_900, minStopPips: 4, keepEvents: true, zone: "Australia/Sydney" };
  const cutIdx = 17_700;
  const full = await replay(E, base, params);
  const part = await replay(E, base.slice(0, cutIdx + 1), params);
  const before = (full.events ?? []).filter((e) => e.i <= cutIdx);
  assert.deepEqual(part.events, before);
  // The sample has to contain what it claims to test: calls on every horizon, of both kinds.
  const count = (pred: (e: EnterEvent) => boolean) => before.filter(pred).length;
  for (const mode of ["quick", "intraday", "swing"] as const) assert.ok(count((e) => e.mode === mode) > 0, `no ${mode} calls in the sample`);
  assert.ok(count((e) => e.setup === "scanner") > 5 && count((e) => e.setup === "zone") > 5);
  assert.equal(full.zone, "Australia/Sydney");
  // A new setup is acted on the moment it is recorded, as it is live — not a candle later. So some calls
  // are confirmed on the very candle they were first seen on; every call says when it was first seen
  // and what turned it into an entry.
  const evs = full.events ?? [];
  assert.ok(evs.every((e) => typeof e.calledAt === "number" && e.calledAt <= e.at && ["touch", "ready", "confirm", "pullback"].includes(String(e.via))));
  assert.ok(evs.some((e) => e.via === "confirm" && e.calledAt === e.at), "no call was confirmed on the candle it was recorded on");
  assert.ok(evs.filter((e) => e.via === "ready").every((e) => e.calledAt === e.at));
  assert.ok(evs.filter((e) => e.via === "touch").every((e) => e.setup === "zone" && e.intrabar && (e.calledAt as number) < e.at));
  // A setup that was already dead when first seen is not a call: none of those is recorded, and they are counted.
  assert.ok(full.scanner.notYet > 0 && full.scanner.recorded > 0, JSON.stringify(full.scanner));
  assert.ok(full.scanner.recorded >= evs.filter((e) => e.setup === "scanner").length);
  // ONE PAGE SETUP, ONE CALL. No page setup is entered while another on the same horizon and side, a
  // touch away, is still running. Each call's end is worked out here independently, by the paper rule.
  const endOf = (e: EnterEvent): number => {
    const enterMs = e.intrabar ? base[e.i].t + 1 : e.at;
    for (let j = e.i; j < base.length; j++) {
      if (base[j].t >= enterMs + GRADE_EXPIRY_MS[e.mode]) return base[j].t;
      if (gradeCandle({ side: e.side, stop: e.stop, tp1: e.tp, enterMs }, { t: base[j].t, h: base[j].h, l: base[j].l }, M5)) return base[j].t + M5;
    }
    return Infinity;
  };
  const zones = evs.filter((e) => e.setup === "zone");
  let near = 0;
  for (let a = 0; a < zones.length; a++) for (let b2 = a + 1; b2 < zones.length; b2++) {
    const x = zones[a], y = zones[b2];
    if (x.mode !== y.mode || x.side !== y.side || !sameSetupZone(E, { side: x.side, entry_low: x.entryLow, entry_high: x.entryHigh }, { side: y.side, entry_low: y.entryLow, entry_high: y.entryHigh })) continue;
    near++;
    // The later one was registered at the scan before its touch; the earlier one had to be over by then.
    assert.ok(endOf(x) <= y.at, `two page setups running at once: ${new Date(x.at).toISOString()} and ${new Date(y.at).toISOString()} (${x.mode} ${x.side})`);
  }
  assert.ok(near > 0, "the sample has no page setups close enough to test the rule");
  // Every entry made on a candle's RANGE reaching a price says whether the candle went through it or only
  // just reached it: every page setup, and an armed setup's pull-back taken inside a candle. (The second
  // version tagged page setups only, so the pull-backs — a touch like any other — were not in the split.)
  const inside = (e: EnterEvent) => e.setup === "zone" || (e.via === "pullback" && e.intrabar);
  assert.ok(evs.filter(inside).every((e) => e.touch === "through" || e.touch === "bare"));
  assert.ok(evs.filter((e) => !inside(e)).every((e) => e.touch === undefined));
  assert.ok(evs.some((e) => e.via === "pullback" && e.intrabar), "the sample has no armed pull-back taken inside a candle");
  const sum = (t: Record<string, { n: number }>) => Object.values(t).reduce((n, x) => n + x.n, 0);
  for (const run of [full.managed, full.managedLow, full.raw]) {
    // What turned each call into a trade is carried onto the trade: the split by it accounts for every trade.
    assert.equal(sum(run.byVia), run.all.n);
    assert.deepEqual(Object.keys(run.byVia).filter((k) => !["touch", "ready", "confirm", "pullback"].includes(k)), []);
    assert.equal(run.byVia.touch?.n ?? 0, run.bySetup.zone?.n ?? 0);
    // Page setups: fresh or stale, and first / after a win / after a loss — each split accounts for every page trade.
    assert.equal(sum(run.byShown), run.bySetup.zone?.n ?? 0);
    assert.equal(sum(run.byAfter), run.bySetup.zone?.n ?? 0);
    assert.ok(sum(run.byTouch) >= (run.bySetup.zone?.n ?? 0) && sum(run.byTouch) <= run.all.n);
  }
  assert.ok(zones.every((e) => (e.shown === "fresh" || e.shown === "stale") && ["first", "win", "loss"].includes(String(e.after))));
  assert.ok(evs.filter((e) => e.setup === "scanner").every((e) => e.shown === undefined && e.after === undefined));
  // "Fresh" means the page showed that level at the scan just before the entry candle; it is checked here
  // from the events alone: a stale entry is one made on a level registered at least two candles earlier
  // that the scans in between had stopped showing — so it can never be the candle right after it was first shown.
  assert.ok(zones.filter((e) => e.shown === "stale").every((e) => e.at - (e.calledAt as number) > M5));
  assert.ok(zones.some((e) => e.shown === "fresh"));
  // "After a loss": some earlier page call, same horizon and side, the same setup, ended as a loss within the hour before.
  for (const e of zones.filter((x) => x.after === "loss").slice(0, 25)) {
    const earlier = zones.filter((x) => x !== e && x.at < e.at && x.mode === e.mode && x.side === e.side && sameSetupZone(E, { side: x.side, entry_low: x.entryLow, entry_high: x.entryHigh }, { side: e.side, entry_low: e.entryLow, entry_high: e.entryHigh }));
    assert.ok(earlier.some((x) => { const end = endOf(x); return end <= e.at && e.at - end <= 3_600_000; }), `no earlier call ended in the hour before ${new Date(e.at).toISOString()}`);
  }
  // Nothing is entered inside a candle that BEGAN in the quiet window (the watch was not looking), and nothing
  // at a candle's close once the window has begun. (A candle that began before it and ends as it opens was
  // still being watched: an entry inside that one is allowed — the second version dropped it.)
  const quietAt = (t: number) => inWeekendCloseWindow(new Date(t)) || inScanQuietWindow(new Date(t));
  assert.ok(evs.every((e) => (e.intrabar ? !quietAt(base[e.i].t) : !quietAt(e.at))));
  // Each run reports its own placement: the three place slightly different numbers of trades.
  assert.deepEqual(full.placements.managed, full.placement);
  for (const k of ["managed", "managedLow", "raw"] as const) assert.equal(full.placements[k].placed, full[k].all.n);
  assert.equal(full.placements.raw.calls, evs.length);
});

test("the managed result is two numbers: a stop moved inside a candle is given the benefit of the doubt, or none", () => {
  const mk = () => openTrade(E, ev(0, "buy", 1.0840, 1.0825, 1.0870), LONG, 1);       // lock 1.0848, break-even needs 1.0855
  // Break-even fires (high 1.0856) and the same candle trades back to 1.0846 but closes above the lock.
  const dip = bar(1, 1.0842, 1.0856, 1.0846, 1.0853);
  const hi = mk(), lo = mk();
  assert.equal(manageBar(E, hi, dip, "managed", false), null);                       // the low came first: still in, stop at the lock
  assert.ok(hi.be && Math.abs(hi.cur - 1.0848) < 1e-9);
  assert.deepEqual(manageBar(E, lo, dip, "managedLow", false), { exit: lo.bePx, how: "breakeven" });   // the low came after: out at the lock
  // No dip through the lock: both carry on, and the against-the-trade run holds the stop the manager
  // would have reached at the candle's best price rather than one worked out from its close.
  const clean = bar(1, 1.0859, 1.0862, 1.08585, 1.0861);
  const h2 = mk(), l2 = mk();
  assert.equal(manageBar(E, h2, clean, "managed", false), null);
  assert.equal(manageBar(E, l2, clean, "managedLow", false), null);
  assert.ok(Math.abs(h2.cur - 1.0848) < 1e-9, String(h2.cur));                       // break-even this candle; the trail starts on the next look
  assert.ok(Math.abs(l2.cur - 1.085825) < 1e-9, String(l2.cur));                     // best 1.0862 less a quarter of R (3.75 pips)
  // The same candle with a low a pip deeper has traded through that stop: out, for the run that gives no
  // benefit of the doubt — and out at the candle's LOW, not at the stop for its high. The worst order
  // the candle allows is: up just far enough to lift the stop to 1.0857, then down to it.
  assert.deepEqual(manageBar(E, mk(), bar(1, 1.0859, 1.0862, 1.0857, 1.0861), "managedLow", false), { exit: 1.0857, how: "trail" });
  // A low that is only just through the stop the candle began with cannot be the exit: the manager moves a stop by more than a twentieth of R, or not at all.
  const hair = mk();
  manageBar(E, hair, bar(1, 1.0854, 1.0857, 1.08535, 1.0856), "managedLow", false);
  const from = hair.cur, step = 0.0015 * 0.05;
  const nudge = manageBar(E, hair, bar(2, 1.0858, 1.0866, from + step / 3, 1.0864), "managedLow", false);
  assert.ok(nudge && nudge.how === "trail" && Math.abs(nudge.exit - (from + step)) < 1e-9, JSON.stringify([nudge, from]));
  // The next candle makes a new high and gives back seven pips before closing near the top.
  const whip = bar(2, 1.0865, 1.0869, 1.0862, 1.0868);
  assert.equal(manageBar(E, h2, whip, "managed", false), null);                      // closed above the trail: still in
  const out = manageBar(E, l2, whip, "managedLow", false);
  assert.ok(out && out.how === "trail" && Math.abs(out.exit - 1.0862) < 1e-9, JSON.stringify(out));     // through the 1.086525 the stop could have reached: out at the low
  // The favourable run never exits at a price the candle did not trade: after a gap down under the old
  // high, the stop it could reach is the buffer below THIS candle's best, not the trail for the old high.
  const gap = mk();
  manageBar(E, gap, bar(1, 1.0854, 1.0868, 1.0853, 1.0867), "managed", false);      // break-even; best 1.0868
  const g = manageBar(E, gap, bar(2, 1.0856, 1.0858, 1.0852, 1.0853), "managed", false);
  assert.ok(g === null || g.exit <= 1.0858 + 1e-9, JSON.stringify(g));
  // A candle that reaches the target after break-even: a target for one, the trail for the other —
  // the stop behind the target was in the candle's range, and the candle cannot say which came first.
  const run = bar(3, 1.0858, 1.0871, 1.0856, 1.0870);
  const h3 = mk(), l3 = mk();
  for (const o of [h3, l3]) assert.equal(manageBar(E, o, bar(1, 1.0854, 1.0857, 1.08535, 1.0856), o === h3 ? "managed" : "managedLow", false), null);
  assert.deepEqual(manageBar(E, h3, run, "managed", false), { exit: 1.0870, how: "target" });
  const o3 = manageBar(E, l3, run, "managedLow", false);
  assert.ok(o3 && o3.how === "trail" && o3.exit < 1.0870 && o3.exit > l3.bePx, JSON.stringify(o3));
  // …unless the candle never came back that far: then it is a target for both.
  const l4 = mk();
  manageBar(E, l4, bar(1, 1.0854, 1.0857, 1.08535, 1.0856), "managedLow", false);
  assert.deepEqual(manageBar(E, l4, bar(2, 1.0866, 1.0871, 1.08665, 1.0870), "managedLow", false), { exit: 1.0870, how: "target" });
  // The favourable run cannot be trailed out at a stop the manager would never have set: it moves a stop
  // by more than a twentieth of R or not at all. Here the stop it "could have reached" inside the candle is
  // half a pip above the lock — inside that step — and the candle closes under it. Still in, stop unmoved.
  const inStep = mk();
  manageBar(E, inStep, bar(1, 1.0854, 1.0857, 1.08535, 1.0856), "managed", false);   // break-even: stop at the lock, 1.0848
  assert.equal(manageBar(E, inStep, bar(2, 1.0850, 1.08505, 1.08482, 1.08484), "managed", false), null);
  assert.ok(Math.abs(inStep.cur - 1.0848) < 1e-9, String(inStep.cur));
  // A candle whose best price puts that stop clearly beyond the step, and which closes back through it: out there.
  const out2 = manageBar(E, inStep, bar(3, 1.0850, 1.0853, 1.08495, 1.0850), "managed", false);
  assert.ok(out2 && out2.how === "trail" && Math.abs(out2.exit - 1.0851) < 1e-9, JSON.stringify(out2));
  // What both agree on: the stop the candle BEGAN with comes first, and a trade left alone is untouched by any of this.
  for (const m of ["managed", "managedLow", "raw"] as const) assert.deepEqual(manageBar(E, mk(), bar(1, 1.0842, 1.0872, 1.0824, 1.0850), m, false), { exit: 1.0825, how: "stop" });
  const raw = mk();
  assert.equal(manageBar(E, raw, dip, "raw", false), null);
  assert.deepEqual([raw.be, raw.cur], [false, 1.0825]);
  // Booleans still mean what they meant.
  assert.equal(manageBar(E, mk(), dip, true, false), null);
  assert.equal(manageBar(E, mk(), dip, false, false), null);
});

test("two touches the same way inside one candle are one trade", () => {
  const base = [flat(0, 1.0840), bar(1, 1.0840, 1.0843, 1.0836, 1.0841), flat(2, 1.0841), flat(3, 1.0841)];
  const touch = (i: number, stop: number): EnterEvent => ev(i, "buy", 1.0840, stop, 1.0870, { intrabar: true });
  // Both happened somewhere inside candle 1; the first may well have still been open at the second.
  const out = runTrades(E, base, [touch(1, 1.0825), touch(1, 1.0826)], true, 1, 10);
  assert.deepEqual(out.placement, { calls: 2, placed: 1, skipped: { one_open: 1 } });
  // Even if the first was stopped inside that same candle, the candle cannot say it was before the second.
  const stopped = [flat(0, 1.0840), bar(1, 1.0840, 1.0843, 1.0824, 1.0841), flat(2, 1.0841)];
  const out2 = runTrades(E, stopped, [touch(1, 1.0825), touch(1, 1.0826)], true, 1, 10);
  assert.deepEqual([out2.placement.placed, out2.placement.skipped.one_open, out2.trades.map((t) => t.how)], [1, 1, ["stop"]]);
  // A call at that candle's CLOSE is after the stop-out, and is free to go.
  const out3 = runTrades(E, stopped, [touch(1, 1.0825), ev(1, "buy", 1.0841, 1.0826, 1.0871)], true, 1, 10);
  assert.equal(out3.placement.placed, 2);
  // The other side is never in the way.
  assert.equal(runTrades(E, base, [touch(1, 1.0825), ev(1, "sell", 1.0840, 1.0855, 1.0810, { intrabar: true })], true, 1, 10).placement.placed, 2);
});

test("4-hour, daily and weekly candles are cut on the feed's clock, daylight saving included", () => {
  const H = 3600_000;
  // Sydney is 10 hours ahead of UTC in the southern winter and 11 from the first Sunday of October.
  assert.equal(zoneOffsetMs("Australia/Sydney", Date.UTC(2026, 8, 30, 12)), 10 * H);
  assert.equal(zoneOffsetMs("Australia/Sydney", Date.UTC(2026, 9, 6, 12)), 11 * H);
  assert.equal(zoneOffsetMs("UTC", Date.UTC(2026, 9, 6, 12)), 0);
  assert.equal(zoneOffsetMs(undefined, 0), 0);
  // The forex day ends at 5pm New York: "NY17" is New York's clock moved on seven hours.
  assert.equal(zoneOffsetMs("NY17", Date.UTC(2026, 9, 6, 12)), 3 * H);          // 4 hours behind UTC in summer, plus 7
  assert.equal(zoneOffsetMs("NY17", Date.UTC(2026, 11, 8, 12)), 2 * H);         // 5 behind in winter
  // A Sydney day in September runs 14:00 UTC to 14:00 UTC.
  const d = (h: number, m = 0) => Date.UTC(2026, 8, 29, h, m);
  assert.equal(bucketStart("1day", d(13, 55), "Australia/Sydney"), bucketStart("1day", d(0), "Australia/Sydney"));
  assert.notEqual(bucketStart("1day", d(14, 0), "Australia/Sydney"), bucketStart("1day", d(13, 55), "Australia/Sydney"));
  assert.equal(bucketStart("1day", d(14, 0), "Australia/Sydney"), bucketStart("1day", Date.UTC(2026, 8, 30, 13, 55), "Australia/Sydney"));
  // On UTC the same two moments are one day; on a short timeframe the clock makes no difference.
  assert.equal(bucketStart("1day", d(13, 55)), bucketStart("1day", d(14, 0)));
  assert.equal(bucketStart("1h", d(13, 55), "Australia/Sydney"), bucketStart("1h", d(13, 55)));
  assert.equal(bucketStart("15min", d(13, 55), "NY17"), bucketStart("15min", d(13, 55), "UTC"));
  // Four-hour candles on Sydney's clock start at 02, 06, 10, 14, 18, 22 UTC (in September).
  assert.equal(bucketStart("4h", d(2, 0), "Australia/Sydney"), bucketStart("4h", d(5, 55), "Australia/Sydney"));
  assert.notEqual(bucketStart("4h", d(1, 55), "Australia/Sydney"), bucketStart("4h", d(2, 0), "Australia/Sydney"));
  // The week starts Monday on the feed's clock: Sunday 21:00 UTC (the forex open) is already Monday in Sydney.
  const sunOpen = Date.UTC(2026, 8, 27, 21, 0), monNoon = Date.UTC(2026, 8, 28, 12, 0), friClose = Date.UTC(2026, 8, 25, 20, 55);
  assert.equal(bucketStart("1week", sunOpen, "Australia/Sydney"), bucketStart("1week", monNoon, "Australia/Sydney"));
  assert.notEqual(bucketStart("1week", sunOpen, "Australia/Sydney"), bucketStart("1week", friClose, "Australia/Sydney"));
  assert.equal(bucketStart("1week", sunOpen), bucketStart("1week", friClose));            // on UTC the Sunday open falls into LAST week's candle

  // Built from candles: a daily candle on Sydney's clock closes at 14:00 UTC, and the replay may not read it before.
  const base: Bar[] = [];
  for (let t = Date.UTC(2026, 8, 28, 0); t < Date.UTC(2026, 8, 30, 0); t += 300_000) base.push({ t, o: 1.08, h: 1.0801 + (t % (24 * H)) / (24 * H) / 1000, l: 1.0799, c: 1.08 });
  const syd = aggregate(base, "1day", "Australia/Sydney"), utc = aggregate(base, "1day");
  assert.deepEqual(syd.end.map((e) => new Date(e).toISOString().slice(0, 16)), ["2026-09-28T14:00", "2026-09-29T14:00", "2026-09-30T14:00"]);
  assert.deepEqual(utc.end.map((e) => new Date(e).toISOString().slice(0, 16)), ["2026-09-29T00:00", "2026-09-30T00:00"]);
  assert.equal(syd.rows[1].datetime, "2026-09-29 00:00:00");                               // labelled as the feed labels it: by its own clock
});

test("the feed's clock is measured from the feed's own candles, not assumed", () => {
  // Five weeks of a market, and "the feed": the same candles cut on Sydney's clock, newest still forming and dropped.
  const base = synthBars({ seed: 11, start: Date.UTC(2026, 7, 31), bars: 7000, price: 1.085, pip: E.pip, dec: E.dec, volPips: 2.2 });
  const feedOn = (zone: string) => Object.fromEntries((["4h", "1day", "1week"] as const).map((tf) => [tf, aggregate(base, tf, zone).bars.slice(0, -1).map((b) => ({ h: b.h, l: b.l }))]));
  const NAMED = ["UTC", "Australia/Sydney", "NY17", "America/New_York", "Europe/London", "Asia/Tokyo"];
  for (const truth of ["Australia/Sydney", "UTC", "NY17"]) {
    const fits = rankZones(base, feedOn(truth), NAMED);
    assert.equal(fits[0].zone, truth, `${truth}: ${JSON.stringify(fits.slice(0, 3))}`);
    assert.ok(fits[0].err < 0.001, `${truth} fits itself exactly (${fits[0].err})`);
    // …and every other named clock is visibly worse — by more than the margin a clock is accepted at.
    assert.ok(fits.slice(1).every((f) => f.err > 0.03), JSON.stringify(fits));
  }
  assert.ok(ZONE_CANDIDATES.includes("Australia/Sydney") && ZONE_CANDIDATES.includes("NY17") && ZONE_CANDIDATES.includes("Etc/GMT-10") && ZONE_CANDIDATES[0] === "UTC");
  // The feed read a little later than the history (one more candle has closed since): still found.
  const feed = feedOn("Australia/Sydney");
  assert.ok((zoneError(base.slice(0, -60), feed["1day"], "1day", "Australia/Sydney") as number) < 0.001);
  // A clock that is wrong is visibly wrong, and too little to compare is said, not guessed.
  assert.ok((zoneError(base, feed["1day"], "1day", "UTC") as number) > 0.05);
  assert.equal(zoneError(base.slice(0, 500), feed["1week"], "1week", "UTC"), null);
  assert.equal(zoneError(base, [], "1day", "UTC"), null);
});

test("one look at the clock is not enough: a fixed offset and a daylight-saving zone agree for half the year", () => {
  // In the southern winter Sydney IS ten hours ahead; across a year it is not.
  assert.equal(sameClockOver("Australia/Sydney", "Etc/GMT-10", Date.UTC(2026, 4, 1), Date.UTC(2026, 8, 20)), true);
  assert.equal(sameClockOver("Australia/Sydney", "Etc/GMT-10", Date.UTC(2026, 1, 1), Date.UTC(2026, 8, 20)), false);
  assert.equal(sameClockOver("NY17", "Etc/GMT-3", Date.UTC(2026, 4, 1), Date.UTC(2026, 8, 20)), true);
  assert.equal(sameClockOver("NY17", "Etc/GMT-3", Date.UTC(2026, 4, 1), Date.UTC(2026, 11, 20)), false);

  // The earlier windows end in mid-January and mid-July — where every daylight-saving clock differs from
  // itself — the most recent of each that the history covers with sixty days to spare.
  const d = (y: number, m: number, day: number) => Date.UTC(y, m, day);
  assert.deepEqual(seasonWindows(d(2025, 6, 7), d(2026, 9, 5)), [{ when: "January 2026", endMs: d(2026, 0, 20) }, { when: "July 2026", endMs: d(2026, 6, 20) }]);
  assert.deepEqual(seasonWindows(d(2026, 0, 17), d(2026, 9, 5)).map((w) => w.when), ["July 2026"]);          // 37 weeks of history: one side only
  assert.deepEqual(seasonWindows(d(2025, 3, 1), d(2026, 6, 25)).map((w) => w.when), ["January 2026", "July 2025"]);   // "now" IS July: last July, a year back
  assert.deepEqual(seasonWindows(d(2026, 7, 1), d(2026, 9, 5)), []);

  // Sixty-five weeks of a market, July 2025 to early October 2026, and a feed that cuts its candles on `truth`'s clock.
  const all = synthBars({ seed: 21, start: d(2025, 6, 7), bars: 93_600, price: 1.085, pip: E.pip, dec: E.dec, volPips: 2.2 });
  const now = Date.UTC(2026, 9, 5, 1);
  const base = all.filter((b) => b.t + M5 <= now);
  const span = { fromMs: base[0].t, toMs: base[base.length - 1].t };
  const utc = (stamp: string) => Date.parse(stamp.replace(" ", "T") + "Z");
  /** The feed's latest closed candles, and its whole candles up to a date it reads on its OWN clock. */
  const closedNow = (truth: string, tf: string, size: number) => { const s = aggregate(base, tf, truth); return s.bars.filter((_, i) => s.end[i] <= now).map((b) => ({ h: b.h, l: b.l })).slice(-size); };
  const upTo = (truth: string, tf: string, size: number, endLocal: number) => { const s = aggregate(all, tf, truth); return s.rows.map((r, i) => [utc(r.datetime), i] as const).filter(([t]) => t <= endLocal).map(([, i]) => ({ h: s.bars[i].h, l: s.bars[i].l })).slice(-size); };
  const recentOf = (truth: string) => rankZones(base, { "4h": closedNow(truth, "4h", 59), "1day": closedNow(truth, "1day", 39), "1week": closedNow(truth, "1week", 13) });
  const windowsOf = (truth: string) => seasonWindows(span.fromMs, span.toMs).map((w) => ({
    when: w.when,
    fits: rankZones(base.filter((b) => b.t <= w.endMs + 13 * 3600_000), { "4h": upTo(truth, "4h", 60, w.endMs), "1day": upTo(truth, "1day", 40, w.endMs) }, ZONE_CANDIDATES, { "4h": 9, "1day": 3 }),
  }));
  const measure = (truth: string) => chooseZone(recentOf(truth), windowsOf(truth), span, { bothSides: true });

  // A feed on a FIXED ten hours ahead. On the latest candles alone it cannot be told from Sydney, which is ten hours ahead in early October…
  const fixedNow = recentOf("Etc/GMT-10");
  assert.deepEqual(fixedNow.slice(0, 2).map((f) => f.err), [0, 0]);
  assert.deepEqual(fixedNow.slice(0, 2).map((f) => f.zone).sort(), ["Australia/Sydney", "Etc/GMT-10"]);
  const one = chooseZone(fixedNow, null, span);
  assert.equal(one.verified, false);
  assert.match(one.note, /latest candles only/);
  // …in January it can: Sydney is eleven ahead then. The fixed clock it is, and only now is it called verified.
  const two = measure("Etc/GMT-10");
  assert.deepEqual([two.zone, two.verified], ["Etc/GMT-10", true]);
  assert.match(two.note, /now and from January 2026 and July 2026/);
  // Every clock that IS tried is found, and verified, as itself.
  for (const truth of ["Australia/Sydney", "UTC", "NY17", "America/New_York", "Europe/London"]) {
    const got = measure(truth);
    assert.deepEqual([got.zone, got.verified], [truth, true], `${truth}: ${JSON.stringify(got.fits.slice(0, 2))} — ${got.note}`);
  }
  // A DAYLIGHT-SAVING CLOCK NOBODY THOUGHT OF IS NOT VERIFIED AS THE FIXED OFFSET IT HAPPENS TO SIT ON TODAY.
  // Chicago is UTC−5 in October and was in late March too: "six months earlier" saw the same clock, a
  // perfect 4-hour fit, and — averaged with a daily fit a little over the line — called it verified.
  for (const truth of ["America/Chicago", "Europe/Berlin", "Asia/Kolkata"]) {
    const got = measure(truth);
    assert.equal(got.verified, false, `${truth} was verified as ${got.zone}`);
    assert.match(got.note, /not its candles from|no clock tried reproduces/, truth);
  }
  // One side of the year only (a short history): the clock that fits is used, and is not called verified.
  const half = chooseZone(recentOf("UTC"), windowsOf("UTC").slice(1), span, { bothSides: false });
  assert.deepEqual([half.zone, half.verified], ["UTC", false]);
  assert.match(half.note, /now and from July 2026 — but not checked on both sides of the year/);
  // …and with July alone the fixed ten hours and Sydney are still one clock: the rival is named.
  const still = chooseZone(recentOf("Etc/GMT-10"), windowsOf("Etc/GMT-10").slice(1), span, { bothSides: false });
  assert.equal(still.verified, false);
  assert.match(still.note, /fits the feed as well and cuts some of this history differently/);

  // EVERY TIMEFRAME HAS TO FIT. A clock whose 4-hour candles are perfect and whose daily candles are 2.5% out
  // averages to "within 2%", and is not within 2%.
  const fit = (zone: string, byTf: Record<string, number> = {}) => { const v = Object.values(byTf); return { zone, err: v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0, byTf }; };
  const lop = chooseZone([fit("Etc/GMT+5", { "4h": 0, "1day": 0.004 })], [{ when: "January", fits: [fit("Etc/GMT+5", { "4h": 0, "1day": 0.0254 })] }, { when: "July", fits: [fit("Etc/GMT+5", { "4h": 0, "1day": 0 })] }], span, { bothSides: true });
  assert.equal(lop.verified, false);
  assert.match(lop.note, /not its candles from January and July/);
  assert.equal(chooseZone([fit("Etc/GMT+5", { "4h": 0, "1day": 0.004 })], [{ when: "January", fits: [fit("Etc/GMT+5", { "4h": 0.01, "1day": 0.019 })] }, { when: "July", fits: [fit("Etc/GMT+5", { "4h": 0, "1day": 0 })] }], span, { bothSides: true }).verified, true);
  // A clock that is missing from one of the windows has not been shown to fit it.
  assert.equal(chooseZone([fit("UTC")], [{ when: "January", fits: [fit("UTC")] }, { when: "July", fits: [fit("NY17")] }], span, { bothSides: true }).verified, false);
  // Two clocks that both fit every window, and differ somewhere in between: not verified, and it names the rival.
  const both = [{ when: "January", fits: [fit("Australia/Sydney"), fit("Etc/GMT-10")] }, { when: "July", fits: [fit("Australia/Sydney"), fit("Etc/GMT-10")] }];
  const tie = chooseZone([fit("Australia/Sydney"), fit("Etc/GMT-10")], both, { fromMs: Date.UTC(2026, 0, 1), toMs: Date.UTC(2026, 8, 20) }, { bothSides: true });
  assert.equal(tie.verified, false);
  assert.match(tie.note, /cuts some of this history differently/);
  // The same two over a stretch where they are one clock: no doubt left.
  assert.equal(chooseZone([fit("Australia/Sydney"), fit("Etc/GMT-10")], both, { fromMs: Date.UTC(2026, 4, 1), toMs: Date.UTC(2026, 8, 20) }, { bothSides: true }).verified, true);
  assert.deepEqual(chooseZone([], null, span), { zone: "UTC", verified: false, fits: [], note: "the feed's own candles could not be read; UTC assumed" });
});

test("the candle that ends as the market reopens: nothing was watched inside it, but the scan at its close steps every pending setup", () => {
  // (The live scan runs eight seconds after that close and reads each pending setup's confirmation; the
  //  third version of the replay skipped the whole candle for them, and entered such a setup a candle late.)
  const src = readFileSync("src/lib/genfx/replay.ts", "utf8");
  const forming = src.slice(src.indexOf('if (a.state === "forming") {'));
  // Skipped only when the candle lies wholly inside the window…
  assert.match(forming, /if \(quietInside && quiet\) continue;/);
  assert.ok(!/if \(quietInside\) continue;/.test(forming));
  // …a pull-back inside a candle nobody watched is not taken…
  assert.match(forming, /if \(!quietInside && a\.armedAt != null && a\.armedAt < T && a\.tp1 != null\) \{/);
  // …and at a close inside the window nothing is read.
  const iSkip = forming.indexOf("if (quietInside && quiet) continue;"), iPull = forming.indexOf("if (!quietInside && a.armedAt"), iQuiet = forming.indexOf("if (quiet) continue;"), iConf = forming.indexOf("const conf = confirmFromCandles(");
  assert.ok(iSkip > 0 && iSkip < iPull && iPull < iQuiet && iQuiet < iConf);
});
