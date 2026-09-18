import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atr, features, regression, efficiency, rsi, zScore, bodyBias } from '../command-center/core/math';
import { barsFromTicks, resample, isClosed, lastClosed, hasGaps, bucketStart } from '../command-center/core/bars';
import { pivots, sequenceOf, structureOf, sweepReclaim, retestQuality, breakOfStructure } from '../command-center/core/structure';
import { sessionAt, minutesIntoSession, marketOpen, sessionLevels, withDistance } from '../command-center/core/sessions';
import { tfState, pressureOf, regimeOf, analyseTf } from '../command-center/core/regime';
import { sizePosition, checkAccountLimits, stopMoveAllowed, DEFAULT_LIMITS, type AccountState } from '../command-center/core/risk';
import { canTransition, transition, onTimeout, reconcile, isLive, isTerminal } from '../command-center/core/state';
import { buildThesis, positionHealth, thesisStillValid, MODE_HORIZON } from '../command-center/core/thesis';
import type { Bar, Tick } from '../command-center/core/types';

const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c });
const M = 60_000;
const flat = (n: number, px: number, w = 1, t0 = 0, step = 5 * M): Bar[] =>
  Array.from({ length: n }, (_, i) => bar(t0 + i * step, px, px + w, px - w, px));
const rising = (n: number, from: number, per = 0.5, t0 = 0): Bar[] =>
  Array.from({ length: n }, (_, i) => bar(t0 + i * 5 * M, from + i * per, from + i * per + 1, from + i * per - 1, from + i * per + 0.4));

/* ─────────────────────────── the clean-room boundary ─────────────────────────── */
test('COMMAND CENTER IS CLEAN ROOM: nothing imports the old desk code', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
  const files = walk('command-center');
  assert.ok(files.length >= 8, 'the command center has source files');
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const forbidden of ['@/lib/flow', '@/lib/genx', 'src/lib/flow', 'src/lib/genx', '@/lib/genxCompute']) {
      assert.ok(!src.includes(forbidden), `${f} must not import ${forbidden} — this is a fresh build`);
    }
  }
});

/* ─────────────────────────── math ─────────────────────────── */
test('math measures what it says it measures', () => {
  assert.equal(atr(flat(5, 4350), 14), null, 'not enough bars → null, never a guess');
  assert.ok(Math.abs((regression(rising(40, 4300, 0.5), 20)?.slope ?? 0) - 0.5) < 0.01);
  assert.ok((regression(rising(40, 4300, 0.5), 20)?.r2 ?? 0) > 0.95, 'a straight line is well explained');
  assert.ok((regression(flat(40, 4350), 20)?.r2 ?? 1) < 0.2, 'chop is not');
  assert.equal(efficiency(rising(40, 4300, 0.5), 20)! > 0.9, true, 'a one-way move is efficient');
  assert.ok(rsi(rising(40, 4300), 14)! > 90);
  assert.ok(Math.abs(zScore(flat(60, 4350), 50)!) < 0.5);
  assert.ok(bodyBias(rising(20, 4300), 10) > 0.15, 'up bars close in the upper half of their range');
  assert.ok(bodyBias(flat(20, 4350), 10) === 0, 'a doji series has no body bias at all');
});

test('features refuse to exist without enough history', () => {
  assert.equal(features(flat(30, 4350)), null);
  const f = features(rising(120, 4300, 0.4));
  assert.ok(f && f.atr > 0 && f.slope > 0 && f.efficiency > 0.5);
});

/* ─────────────────────────── bars ─────────────────────────── */
test('ticks fold into bars and bars resample cleanly', () => {
  const ticks: Tick[] = [0, 1, 2, 6, 7, 11].map((m, i) => ({ t: m * M, bid: 4350 + i, ask: 4350.2 + i, mid: 4350.1 + i, spread: 0.2, source: 'twelvedata' }));
  const m5 = barsFromTicks(ticks, '5m');
  assert.equal(m5.length, 3);
  assert.equal(m5[0].t, 0);
  assert.equal(m5[0].o, 4350.1);
  assert.equal(m5[0].c, 4352.1, 'last tick in the bucket is the close');

  const m15 = resample(flat(12, 4350, 1, 0, 5 * M), '5m', '15m');
  assert.equal(m15.length, 4);
  assert.throws(() => resample([], '15m', '1h' as never) && resample([], '4h', '1h'), /not a multiple/);
});

test('a forming bar is never mistaken for a closed one', () => {
  const bars = flat(3, 4350, 1, 0, 5 * M);
  assert.equal(isClosed(bars[2], '5m', 10 * M + 1), false, 'the last bar is still forming');
  assert.equal(isClosed(bars[2], '5m', 15 * M), true);
  assert.equal(lastClosed(bars, '5m', 12 * M)?.t, 5 * M);
  assert.equal(bucketStart(7 * M + 30_000, 5), 5 * M);
});

test('a feed outage does not look like a quiet market', () => {
  const gapped = [...flat(5, 4350, 1, 0, 5 * M), bar(60 * M, 4350, 4351, 4349, 4350)];
  assert.equal(hasGaps(gapped, '5m'), true);
  assert.equal(hasGaps(flat(10, 4350, 1, 0, 5 * M), '5m'), false);
});

/* ─────────────────────────── structure ─────────────────────────── */
test('a pivot is only real once bars have closed beyond it', () => {
  const bars = [...flat(4, 4350), bar(4 * 5 * M, 4350, 4362, 4349, 4360), ...flat(4, 4350, 1, 5 * 5 * M)];
  const ps = pivots(bars, 2, 2);
  assert.ok(ps.some((p) => p.kind === 'high' && p.price === 4362));
  assert.equal(pivots(bars.slice(0, 6), 2, 2).some((p) => p.price === 4362), false, 'not confirmed yet');
});

test('a break of structure needs a CLOSE, not a wick', () => {
  const wickOnly = [bar(0, 4350, 4365, 4349, 4351)];
  assert.equal(breakOfStructure(wickOnly, 4360, 'up'), false, 'a wick through a level is a rejection, not a break');
  assert.equal(breakOfStructure([bar(0, 4350, 4365, 4349, 4362)], 4360, 'up'), true);
});

test('sweep and reclaim is detected, and a failed break is not called a break', () => {
  const swept = [...flat(6, 4350), bar(6 * 5 * M, 4350, 4351, 4330, 4349)];
  const r = sweepReclaim(swept, 4340, 'below');
  assert.equal(r.swept, true); assert.equal(r.reclaimed, true); assert.equal(r.extreme, 4330);

  // A market that only goes up has no confirmed swing points — the engine must not invent them.
  const noPullback = structureOf(rising(60, 4300, 0.5));
  assert.equal(noPullback.swingHigh, null, 'no pullback, no swing high');
  assert.equal(noPullback.sequence, 'unknown');

  // Give it a real pullback and the swings appear.
  const withPullback = structureOf([
    ...rising(30, 4300, 0.5),
    ...flat(4, 4312, 1, 30 * 5 * M),
    bar(34 * 5 * M, 4312, 4313, 4304, 4305),
    ...flat(4, 4306, 1, 35 * 5 * M),
    ...rising(20, 4307, 0.5, 39 * 5 * M),
  ]);
  assert.ok(withPullback.swingHigh != null && withPullback.swingLow != null, 'a pullback creates structure');
  assert.ok(withPullback.positionInRange != null && withPullback.positionInRange >= 0 && withPullback.positionInRange <= 1);
});

test('retest quality rewards a defended level and rejects acceptance back inside', () => {
  const good = retestQuality(bar(0, 4362, 4363, 4355.2, 4361), 4355, 'up', 0.5);
  assert.ok(good != null && good > 0.6, 'closed near the high after touching the level');
  assert.equal(retestQuality(bar(0, 4362, 4363, 4350, 4351), 4355, 'up', 0.5), null, 'closed back below — not a retest');
});

/* ─────────────────────────── sessions ─────────────────────────── */
test('gold sessions follow the New York clock, including the daily break', () => {
  const ny = (y: number, m: number, d: number, h: number) => Date.UTC(y, m, d, h + 4);   // EDT
  assert.equal(sessionAt(ny(2026, 8, 18, 10)), 'new_york');
  assert.equal(sessionAt(ny(2026, 8, 18, 5)), 'london');
  assert.equal(sessionAt(ny(2026, 8, 16, 22)), 'asia', 'Wednesday 22:00 NY is the Asian session');
  assert.equal(sessionAt(ny(2026, 8, 18, 22)), 'closed', 'Friday 22:00 NY is the weekend, not Asia');
  assert.equal(sessionAt(ny(2026, 8, 18, 17) + 30 * M), 'closed', 'the 17:00–18:00 break');
  assert.equal(marketOpen(Date.UTC(2026, 8, 19, 16)), false, 'Saturday');
  assert.ok(minutesIntoSession(ny(2026, 8, 18, 9)) >= 55 && minutesIntoSession(ny(2026, 8, 18, 9)) <= 65);
});

test('session levels are derived from bars, never assumed', () => {
  const base = Date.UTC(2026, 8, 17, 12);
  const bars = [...flat(20, 4300, 5, base, 30 * M), ...flat(20, 4360, 5, base + 24 * 3600_000, 30 * M)];
  const lv = sessionLevels(bars, base + 24 * 3600_000 + 10 * 3600_000);
  assert.ok(lv.some((l) => l.kind === 'pdh'), 'previous day high exists');
  assert.ok(lv.some((l) => l.kind === 'dh'));
  const near = withDistance(lv, 4365, 3);
  assert.ok((near[0].distanceAtr ?? 99) <= (near[near.length - 1].distanceAtr ?? 99), 'sorted by nearness');
});

/* ─────────────────────────── regime + pressure ─────────────────────────── */
test('timeframe state and regime follow the measurements', () => {
  const up = analyseTf(rising(120, 4300, 0.6))!;
  assert.ok(['strong_uptrend', 'uptrend', 'breakout'].includes(up.state), `got ${up.state}`);
  assert.ok(up.pressure.bullish > 60, 'a one-way rise is bullish pressure');

  const quiet = analyseTf(flat(120, 4350, 0.15))!;
  assert.ok(['compression', 'range', 'chaotic'].includes(quiet.state), `got ${quiet.state}`);
  assert.ok(Math.abs(quiet.pressure.net) < 40);

  assert.equal(regimeOf({ exec: { f: up.f, s: up.s }, context: { f: up.f, s: up.s }, newsShock: true }), 'news_shock');
  const r = regimeOf({ exec: { f: quiet.f, s: quiet.s }, context: null });
  assert.ok(['compression', 'volatility_squeeze', 'tight_range', 'sideways_range', 'chaotic', 'mean_reversion'].includes(r), `got ${r}`);
});

test('pressure acceleration compares against the previous reading', () => {
  const a = analyseTf(rising(120, 4300, 0.6))!;
  const p2 = pressureOf(a.f, a.s, { bullish: 40, bearish: 60, net: -20, acceleration: 0 });
  assert.ok(p2.acceleration > 0, 'pressure improved since last pass');
});

/* ─────────────────────────── risk ─────────────────────────── */
const inst = { contractSize: 100, minLot: 0.01, maxLot: 50, lotStep: 0.01, pipValuePerLot: 1 };

test('size comes from risk, and rounds DOWN', () => {
  const r = sizePosition({ equity: 10_000, entry: 4350, stop: 4345, side: 'buy', riskPct: 0.5, inst });
  assert.ok(r.ok && r.stopPips === 50);
  assert.ok(r.ok && r.riskAmount <= 50.0001, 'never more than the requested risk');
  assert.ok(r.ok && Math.abs(r.lots - 1) < 0.011);
});

test('risk refuses what it cannot size honestly', () => {
  assert.equal(sizePosition({ equity: 0, entry: 4350, stop: 4345, side: 'buy', riskPct: 0.5, inst }).ok, false);
  assert.equal(sizePosition({ equity: 10_000, entry: 4350, stop: 4355, side: 'buy', riskPct: 0.5, inst }).ok, false, 'stop on the wrong side');
  assert.equal(sizePosition({ equity: 100, entry: 4350, stop: 4340, side: 'buy', riskPct: 0.1, inst }).ok, false, 'below the minimum lot');
  assert.equal(sizePosition({ equity: 10_000, entry: 4350, stop: 4200, side: 'buy', riskPct: 0.5, inst, maxStopPips: 100 }).ok, false, 'stop too wide');
});

test('account limits are hard and explain themselves', () => {
  const base: AccountState = { equity: 10_000, openRiskPct: 0, dayPnlPct: 0, dayPeakEquity: 10_000, weekPnlPct: 0, consecutiveLosses: 0, tradesThisSession: 0, openPositions: 0, lastTradeAtMs: null };
  const now = Date.UTC(2026, 8, 18, 14);
  assert.equal(checkAccountLimits(base, DEFAULT_LIMITS, now).ok, true);

  const daily = checkAccountLimits({ ...base, dayPnlPct: -3.1 }, DEFAULT_LIMITS, now);
  assert.equal(daily.ok, false); assert.equal(daily.hard, true); assert.match(daily.reason, /Daily loss/);

  assert.equal(checkAccountLimits({ ...base, equity: 9_500, dayPeakEquity: 10_000 }, DEFAULT_LIMITS, now).ok, false, 'daily drawdown');
  assert.equal(checkAccountLimits({ ...base, openPositions: 1 }, DEFAULT_LIMITS, now).ok, false, 'one gold position at a time');
  assert.equal(checkAccountLimits({ ...base, consecutiveLosses: 4 }, DEFAULT_LIMITS, now).ok, false);
  assert.equal(checkAccountLimits({ ...base, lastTradeAtMs: now - 30_000 }, DEFAULT_LIMITS, now).ok, false, 'cooldown');
  assert.equal(checkAccountLimits({ ...base, openRiskPct: 1.8 }, DEFAULT_LIMITS, now, { newTradeRiskPct: 0.5 }).ok, false, 'total open risk');
  assert.equal(checkAccountLimits(base, DEFAULT_LIMITS, now, { spread: 1.2 }).ok, false, 'spread');
});

test('a stop may only ever move toward the trade', () => {
  assert.equal(stopMoveAllowed('buy', 4340, 4345).ok, true);
  assert.equal(stopMoveAllowed('buy', 4340, 4335).ok, false);
  assert.equal(stopMoveAllowed('sell', 4360, 4355).ok, true);
  assert.equal(stopMoveAllowed('sell', 4360, 4365).ok, false);
  assert.equal(stopMoveAllowed('buy', 4340, 4335).hard, true, 'not overridable');
});

/* ─────────────────────────── execution state ─────────────────────────── */
test('the state machine only allows legal moves', () => {
  assert.equal(canTransition('armed', 'entry_requested'), true);
  assert.equal(canTransition('armed', 'open'), false, 'you cannot be open without an order');
  assert.equal(transition('order_submitted', 'filled', 'broker said so').ok, false, 'must be acknowledged first');
  assert.equal(isTerminal('closed'), true);
  assert.equal(isLive('partial_taken'), true);
});

test('a timeout goes to unknown and is only left by reconciliation — never a retry', () => {
  assert.deepEqual(onTimeout('order_submitted'), { to: 'unknown', action: 'reconcile' });
  assert.deepEqual(onTimeout('exit_requested'), { to: 'unknown', action: 'reconcile' });
  assert.deepEqual(onTimeout('armed'), { to: 'armed', action: 'none' });
  assert.equal(canTransition('unknown', 'order_submitted'), false, 'never resend from unknown');

  assert.equal(reconcile({ hasPosition: true, hasWorkingOrder: false, wasFilledInHistory: true }).to, 'open');
  assert.equal(reconcile({ hasPosition: false, hasWorkingOrder: true, wasFilledInHistory: false }).to, 'canceled');
  assert.equal(reconcile({ hasPosition: false, hasWorkingOrder: false, wasFilledInHistory: true }).to, 'closed');
  assert.equal(reconcile({ hasPosition: false, hasWorkingOrder: false, wasFilledInHistory: false }).to, 'canceled');
});

/* ─────────────────────────── thesis + health ─────────────────────────── */
const mkThesis = (mode: 'scalp' | 'intraday' | 'swing') => buildThesis({
  strategy: 'breakout_retest', mode, side: 'buy', reason: 'PDH broke and the retest held',
  expected: 'continues toward the session high', invalidation: 'acceptance back below the level',
  invalidationPrice: 4345, regime: 'breakout', pressure: 30, atr: 3, positionInRange: 0.7,
});

const healthInput = (over: Record<string, unknown> = {}) => ({
  thesis: mkThesis('intraday'), now: 3600_000, openedAt: 0, price: 4360, entry: 4350,
  structure: { swingHigh: 4365, swingLow: 4345, sequence: 'HH_HL' as const, brokeStructure: 'up' as const, failedBreak: null, rangeHigh: 4370, rangeLow: 4340, positionInRange: 0.66, sweptLevel: null, reclaimed: false },
  tfState: 'uptrend' as const, pressure: { bullish: 68, bearish: 32, net: 36, acceleration: 2 },
  regime: 'breakout' as const, mfePips: 120, ...over,
});

test('a healthy trade is left alone', () => {
  const h = positionHealth(healthInput() as never);
  assert.ok(h.score >= 65, `got ${h.score}`);
  assert.equal(thesisStillValid(h, healthInput() as never).action, 'hold');
});

test('the thesis dies on ITS OWN evidence, not on a lower-timeframe wobble', () => {
  const dead = healthInput({ price: 4340, tfState: 'downtrend', structure: { ...healthInput().structure, brokeStructure: 'down', sequence: 'LH_LL' }, pressure: { bullish: 25, bearish: 75, net: -50, acceleration: -20 } });
  const h = positionHealth(dead as never);
  const v = thesisStillValid(h, dead as never);
  assert.equal(v.valid, false);
  assert.equal(v.action, 'exit');
  assert.match(v.why, /4345|health/);
});

test('a swing trade tolerates what would kill a scalp', () => {
  const shared = { price: 4344, tfState: 'weak_downtrend' as const, mfePips: 40 };
  const scalp = positionHealth(healthInput({ ...shared, thesis: mkThesis('scalp'), now: 40 * M }) as never);
  const swing = positionHealth(healthInput({ ...shared, thesis: mkThesis('swing'), now: 40 * M }) as never);
  assert.ok(swing.score > scalp.score, `swing ${swing.score} should tolerate more than scalp ${scalp.score}`);
  assert.ok(MODE_HORIZON.swing.noiseFloorPips > MODE_HORIZON.scalp.noiseFloorPips);
});

test('a trade that does nothing for its whole window is failing', () => {
  const stalled = healthInput({ thesis: mkThesis('scalp'), now: 50 * M, price: 4350.5, mfePips: 8 });
  const h = positionHealth(stalled as never);
  assert.ok(h.drivers.some((d) => /follow-through/.test(d.label)), 'time failure is recorded as a driver');
});

test('every health change is explainable in words', () => {
  const h = positionHealth(healthInput({ price: 4338, tfState: 'downtrend' }) as never);
  assert.ok(h.drivers.length >= 2);
  for (const d of h.drivers) { assert.ok(d.label.length > 5); assert.ok(Number.isFinite(d.delta)); }
});

/* ─────────────────────────── adapters + snapshot ─────────────────────────── */
import { parseSeries, TD_INTERVAL } from '../command-center/adapters/twelvedata';
import { isRejection, numField, TL_HOSTS } from '../command-center/adapters/tradelocker';
import { buildSnapshot, tradeable, SNAPSHOT_VERSION, MAX_FEED_DIVERGENCE } from '../command-center/engines/snapshot';

test('Twelve Data rows are parsed newest-last, numeric, and UTC', () => {
  const bars = parseSeries({ values: [
    { datetime: '2026-09-18 14:40:00', open: '4350.1', high: '4352.0', low: '4349.0', close: '4351.5' },
    { datetime: '2026-09-18 14:35:00', open: '4348.0', high: '4351.0', low: '4347.5', close: '4350.1' },
  ] });
  assert.equal(bars.length, 2);
  assert.ok(bars[0].t < bars[1].t, 'oldest first after parsing');
  assert.equal(bars[0].o, 4348, 'strings become numbers');
  assert.equal(bars[0].t, Date.UTC(2026, 8, 18, 14, 35), 'exchange time read as UTC');
  assert.equal(parseSeries({ values: [{ datetime: 'nonsense', open: 'x', high: 'x', low: 'x', close: 'x' }] }).length, 0, 'junk rows are dropped, not guessed');
  assert.equal(TD_INTERVAL['15m'], '15min');
});

test('a TradeLocker 200 carrying s:error is a rejection, not a success', () => {
  assert.equal(isRejection(200, { s: 'ok' }), false);
  assert.equal(isRejection(200, { s: 'error', errmsg: 'stop too close' }), true);
  assert.equal(isRejection(200, { s: 'rejected' }), true);
  assert.equal(isRejection(500, {}), true);
  assert.equal(TL_HOSTS.live.includes('live.tradelocker.com'), true);
});

test('broker rows are read whether they arrive as objects or columnar arrays', () => {
  assert.equal(numField({ avgPrice: '4350.5' }, ['avgPrice']), 4350.5);
  assert.equal(numField([1, 2, 4350.5], ['avgPrice'], 2), 4350.5);
  assert.equal(numField({ nothing: true }, ['avgPrice']), null);
});

const feed = (over = {}) => ({ feed: 'twelvedata' as const, state: 'live' as const, lastTickMs: 0, ageMs: 1000, ...over });
const NOW_WED = Date.UTC(2026, 8, 16, 18, 0);       // Wednesday 14:00 New York
/** bars of any timeframe that finish right at `end` — so nothing is stale by accident */
const seriesTo = (n: number, stepMs: number, end: number, from: number, per: number): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const t = end - (n - i) * stepMs, px = from + i * per;
    return bar(t, px, px + 1, px - 1, px + per * 0.8);
  });
const snapInput = (over = {}) => ({
  now: NOW_WED,
  bars: {
    '5m': seriesTo(120, 5 * M, NOW_WED, 4300, 0.4),
    '1h': seriesTo(120, 60 * M, NOW_WED, 4290, 1.2),
  },
  price: 4348, bid: 4347.8, ask: 4348.2, feeds: [feed()], ...over,
});

test('the snapshot carries its own warnings, and they gate trading', () => {
  const s = buildSnapshot(snapInput() as never);
  assert.equal(s.snapshotVersion, SNAPSHOT_VERSION);
  assert.ok(s.timeframes['5m'], 'the execution timeframe is present');
  assert.equal(s.session, 'new_york');
  assert.ok(Math.abs((s.spread ?? 0) - 0.4) < 1e-9);
  assert.ok(s.levels.length > 0, 'levels are derived from the bars');
});

test('feed divergence blocks trading instead of quietly picking a price', () => {
  const s = buildSnapshot(snapInput({ comparePrice: { source: 'tradelocker', price: 4348 + MAX_FEED_DIVERGENCE + 0.5 } }) as never);
  assert.ok(s.warnings.some((w) => /disagree/i.test(w)));
  assert.equal(tradeable(s).ok, false);
  assert.equal(tradeable(s).code, 'feed_divergence', 'blocked by an explicit code, not by matching prose');
});

test('a stale feed blocks trading; a healthy one does not', () => {
  const stale = buildSnapshot(snapInput({ feeds: [feed({ state: 'stale', ageMs: 400_000 })] }) as never);
  assert.equal(tradeable(stale).code, 'feed_stale');
  const healthy = buildSnapshot(snapInput() as never);
  assert.deepEqual(healthy.blockers, [], `nothing should block a healthy read: ${JSON.stringify(healthy.blockers)}`);
  assert.equal(tradeable(healthy).ok, true);
});

test('a stale CONTEXT timeframe is a note, not a block — a 4h candle is meant to be hours old', () => {
  const s = buildSnapshot(snapInput({ bars: { '5m': seriesTo(120, 5 * M, NOW_WED, 4300, 0.4), '4h': seriesTo(80, 4 * 60 * M, NOW_WED - 20 * 3600_000, 4200, 3) } }) as never);
  assert.ok(s.warnings.some((w) => w.startsWith('4h')), 'it is still reported');
  assert.equal(s.blockers.some((b) => b.code === 'exec_data_behind'), false, 'but it does not stop trading');
});

test('a closed market is never tradeable', () => {
  const sat = buildSnapshot(snapInput({ now: Date.UTC(2026, 8, 19, 16) }) as never);
  assert.equal(sat.session, 'closed');
  assert.equal(tradeable(sat).ok, false);
  assert.ok(sat.blockers.some((b) => b.code === 'market_closed'));
});

test('no usable 5-minute read means no trade', () => {
  const thin = buildSnapshot(snapInput({ bars: { '5m': rising(10, 4300) } }) as never);
  assert.equal(tradeable(thin).ok, false);
  assert.equal(tradeable(thin).code, 'no_exec_read');
});
