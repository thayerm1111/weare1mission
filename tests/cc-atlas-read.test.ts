import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { buildSnapshot } from '../command-center/engines/snapshot';
import { resample } from '../command-center/core/bars';
import {
  computeRead, computeReadDetailed, closedOnly, swingRead, setupStageOf, withSetupStage, edgesOfRead,
  readFromStored, fmtPx, READ_RULES,
} from '../command-center/core/read';
import { updateScenarios, scenarioChanges, isActiveScenario, SCENARIO_RULES } from '../command-center/core/scenarios';
import { atlasStep, shouldPersistRead, readHistoryOf, rowOfRead, READ_PERSIST_MS, type AtlasMemory, type AtlasStep } from '../command-center/engines/atlasRead';
import { replay, hourlyAsOf } from '../command-center/engines/replay';
import { liveReadFields } from '../command-center/engines/live';
import { ATLAS_READ_VERSION, levelIdOf, type AtlasRead, type Scenario } from '../command-center/core/atlasContract';
import type { Bar, MarketSnapshot, Timeframe } from '../command-center/core/types';
import type { SetupState } from '../command-center/engines/setup';

/*
 * ATLAS'S DIRECTIONAL READ — the rules, the hysteresis, the scenarios and the boundaries.
 *
 * Every market here is real arithmetic run through the real snapshot builder: one minute-resolution price
 * path is folded into 5-minute candles and every higher timeframe is resampled from those, so all the
 * timeframes describe the same market, exactly as they do live. The recorded session in
 * command-center/fixtures is used for the replay and no-lookahead tests.
 */

// Never a database from a test: the live route's fallback runs with the Supabase client switched off.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const M = 60_000;
const SPAN: Record<string, number> = { '5m': 5 * M, '15m': 15 * M, '1h': 60 * M, '4h': 240 * M };
const AT = Date.UTC(2026, 9, 14, 14, 0, 0);     // Wednesday 14 October 2026, 14:00 UTC — gold open
const N5 = 61 * 48 + 12;                        // enough 5-minute candles for 60+ closed 4-hour candles
const ORIGIN = AT - N5 * 5 * M;

type Wave = { amp: number; periodMin: number; phase?: number };
function path5m(drift: number, waves: Wave[], extra = 0, base = 4300): Bar[] {
  const px = (t: number) => {
    const m = (t - ORIGIN) / M;
    let p = base + drift * (m / 60);
    for (const w of waves) p += w.amp * Math.sin((2 * Math.PI * m) / w.periodMin + (w.phase ?? 0));
    return p;
  };
  const out: Bar[] = [];
  for (let k = 0; k < N5 + extra; k++) {
    const t = ORIGIN + k * 5 * M;
    const s = [0, 1, 2, 3, 4, 5].map((j) => px(t + j * M));
    out.push({ t, o: +s[0].toFixed(2), h: +Math.max(...s).toFixed(2), l: +Math.min(...s).toFixed(2), c: +s[5].toFixed(2) });
  }
  return out;
}
/** What the worker would hold at `at`: candles closed by then, at the worker's fetch sizes, and the snapshot. */
function marketAt(all5: Bar[], at: number) {
  const m5 = all5.filter((b) => b.t + 5 * M <= at);
  const bars: Partial<Record<Timeframe, Bar[]>> = {
    '5m': m5.slice(-200),
    '15m': resample(m5, '5m', '15m').slice(-150),
    '1h': resample(m5, '5m', '1h').slice(-150),
    '4h': resample(m5, '5m', '4h').slice(-120),
  };
  const snap = buildSnapshot({ now: at, bars, price: m5[m5.length - 1].c, feeds: [{ feed: 'twelvedata', state: 'live', lastTickMs: at - 1000, ageMs: 1000 }] });
  return { bars, snap };
}
const mirror = (b: Bar): Bar => ({ t: b.t, o: +(8600 - b.o).toFixed(2), h: +(8600 - b.l).toFixed(2), l: +(8600 - b.h).toFixed(2), c: +(8600 - b.c).toFixed(2) });

const BULL_WAVES: Wave[] = [{ amp: 1.2, periodMin: 40 }, { amp: 3, periodMin: 150 }, { amp: 8, periodMin: 600 }, { amp: 20, periodMin: 2400 }];
const BULL = path5m(2.0, BULL_WAVES, 30);
const BEAR = BULL.map(mirror);
const RANGE = path5m(0, [{ amp: 1.0, periodMin: 35, phase: 0 }, { amp: 2.0, periodMin: 130, phase: 1.5 }, { amp: 3, periodMin: 470, phase: 3 }, { amp: 5, periodMin: 1700, phase: 4.5 }]);
const TURN = path5m(-2.0, [{ amp: 1.2, periodMin: 40 }, { amp: 6, periodMin: 150, phase: 1 }, { amp: 8, periodMin: 600 }, { amp: 20, periodMin: 2400 }]);

const cold = (all5: Bar[], at = AT) => { const m = marketAt(all5, at); return { ...m, read: computeRead({ snapshot: m.snap, bars: m.bars, previous: null }) }; };
const sumW = (e: { weight: number }[]) => e.reduce((a, x) => a + x.weight, 0);
const t = (iso: string) => Date.parse(iso);

/** A worker's day in miniature: one reading per closed 5-minute candle, carrying the read and scenarios forward. */
function stepper(all5: Bar[], from: number, to: number) {
  const out: { at: number; read: AtlasRead; scenarios: Scenario[]; step: AtlasStep }[] = [];
  let mem: AtlasMemory = { read: null, scenarios: [] };
  for (let at = from; at <= to; at += 5 * M) {
    const { bars, snap } = marketAt(all5, at);
    const step = atlasStep({ snapshot: snap, bars, previous: mem, now: at });
    mem = { read: step.read, scenarios: step.scenarios };
    out.push({ at, read: step.read, scenarios: step.scenarios, step });
  }
  return out;
}
const BULL_DAY = stepper(BULL, AT - 12 * 60 * M, AT + 2 * 60 * M);
const at = (steps: typeof BULL_DAY, iso: string) => {
  const s = steps.find((x) => x.at === t(iso));
  assert.ok(s, `no reading at ${iso}`);
  return s!;
};

/* ─────────────────────────── each lean, from crafted markets ─────────────────────────── */

test('a market trending up on every timeframe reads as a bullish lean, with its evidence on the chart', () => {
  const { read, bars, snap } = cold(BULL);
  assert.equal(read.version, ATLAS_READ_VERSION);
  assert.equal(read.lean, 'bullish_lean');
  assert.ok(read.score >= READ_RULES.COLD_ENTER, `a cold start needs ${READ_RULES.COLD_ENTER}; got ${read.score}`);
  assert.equal(read.htfTrend.state, 'up');
  assert.equal(read.momentum.state, 'rising');
  assert.equal(read.horizon, 'intraday');
  assert.ok(read.strength === 'clear' || read.strength === 'strong');
  assert.ok(read.evidenceFor.length >= 3 && read.evidenceFor.every((e) => e.weight > 0));
  // The score is the evidence, nothing else: the weights shown add up to it (smaller items folded into one line).
  assert.ok(read.evidenceFor.length <= READ_RULES.EVIDENCE_MAX && read.evidenceAgainst.length <= READ_RULES.EVIDENCE_MAX);
  assert.ok(Math.abs(sumW(read.evidenceFor) - sumW(read.evidenceAgainst) - read.score) <= 1, `${sumW(read.evidenceFor)} - ${sumW(read.evidenceAgainst)} vs ${read.score}`);
  // "For" is relative to the lean (or, with no side, to the way the score tilts): for − against = side × score.
  for (const r of [cold(BEAR).read, cold(RANGE).read, cold(TURN).read]) {
    const side = r.lean === 'bullish_lean' ? 1 : r.lean === 'bearish_lean' ? -1 : r.score >= 0 ? 1 : -1;
    assert.ok(Math.abs(sumW(r.evidenceFor) - sumW(r.evidenceAgainst) - side * r.score) <= 1, `${r.lean}: the shown weights do not add up to ${r.score}`);
  }

  // Every reference points at something real: a level the snapshot carries, or a swing / candle that had CLOSED.
  const levelIds = new Set([...snap.levels, ...(snap.map ?? [])].map(levelIdOf));
  const refs = [...read.evidenceFor, ...read.evidenceAgainst].map((e) => e.ref).filter(Boolean);
  refs.push(read.invalidation?.ref, read.nextWatch?.ref);
  for (const r of refs) {
    if (!r) continue;
    if (r.kind === 'level') assert.ok(levelIds.has(r.levelId), `unknown level ${r.levelId}`);
    if (r.kind === 'swing' || r.kind === 'candle') {
      const closed = (bars[r.tf] ?? []).find((b) => b.t === r.t);
      assert.ok(closed, `no ${r.tf} candle opens at ${r.t}`);
      assert.ok(closed!.t + SPAN[r.tf] <= AT, 'a reference to a candle that had not closed');
    }
  }

  assert.ok(read.invalidation && read.invalidation.price! < snap.price, 'a bullish lean is wrong BELOW price');
  const nw = read.nextWatch?.ref;
  assert.ok(nw && (nw.kind === 'level' || nw.kind === 'swing') && nw.price > read.invalidation!.price!, 'what it watches next sits above the invalidation');
  assert.match(read.summary, /^The broader structure remains bullish, and the five-minute chart agrees\. My intraday lean is up while [\d,]+\.\d\d holds; next I'm watching [\d,]+\.\d\d\.$/);
  assert.equal(read.entry, 'none', 'a lean is never an entry');
  assert.equal(read.setupStage, 'none');
});

test('the same market upside down reads exactly the other way — no side is favoured', () => {
  const up = cold(BULL).read;
  const down = cold(BEAR).read;
  assert.equal(down.lean, 'bearish_lean');
  assert.ok(Math.abs(up.score + down.score) <= 2, `mirror scores ${up.score} / ${down.score}`);
  assert.equal(down.htfTrend.state, 'down');
  assert.equal(down.momentum.state, 'falling');
  assert.ok(down.invalidation!.price! > cold(BEAR).snap.price, 'a bearish lean is wrong ABOVE price');
  assert.match(down.summary, /^The broader structure remains bearish, and the five-minute chart agrees\. My intraday lean is down while price stays below [\d,]+\.\d\d/);
});

test('a range with no side reads balanced: neutral between two real levels, nothing to invalidate', () => {
  const { read } = cold(RANGE);
  assert.equal(read.lean, 'balanced');
  assert.ok(Math.abs(read.score) < READ_RULES.EXIT);
  assert.equal(read.htfTrend.state, 'range');
  assert.equal(read.strength, null);
  assert.equal(read.invalidation, null, 'no lean, nothing to invalidate');
  const z = read.nextWatch?.ref;
  assert.ok(z && z.kind === 'zone' && z.from < z.to, 'the range it is watching, as a zone');
  const e = edgesOfRead(read);
  assert.equal(e.support!.price, (z as { from: number }).from);
  assert.match(read.summary, /^Higher timeframes are ranging, and the five-minute chart is quiet\. I'm neutral between [\d,]+\.\d\d and [\d,]+\.\d\d until a close outside that range\.$/);
});

test('the trend and momentum disagreeing at a deciding level reads as transitioning, with both outcomes priced', () => {
  const { read, snap } = cold(TURN);
  assert.equal(read.lean, 'transitioning');
  assert.equal(read.htfTrend.state, 'down');
  assert.equal(read.momentum.state, 'rising');
  assert.ok(Math.abs(read.score) < READ_RULES.ENTER);
  const p = read.nextWatch?.ref, q = read.invalidation;
  assert.ok(p && (p.kind === 'level' || p.kind === 'swing') && p.price > snap.price, 'the level that completes the turn up');
  assert.ok(q && q.price! < snap.price, 'the level that puts the downtrend back in charge');
  assert.match(read.summary, /^The broader structure is bearish, but the five-minute chart is recovering\. That's a transition, not a trend yet: a close above [\d,]+\.\d\d would turn my lean up, a close below [\d,]+\.\d\d keeps it down\.$/);
});

test("a qualified lean instead of 'mixed': the trend still decides while the five-minute chart pushes back", () => {
  // The bearish day at 14:55 on the 13th: the 1h/4h are bearish, five-minute momentum is rising, and the
  // evidence is -16 — not enough to START a lean, but enough to HOLD one that was already there.
  const now = t('2026-10-13T14:55:00Z');
  const m = marketAt(BEAR, now);
  const d = computeReadDetailed({ snapshot: m.snap, bars: m.bars, previous: null });
  assert.equal(d.read.htfTrend.state, 'down');
  assert.equal(d.read.momentum.state, 'rising');
  assert.ok(d.read.score <= -READ_RULES.EXIT && d.read.score > -READ_RULES.ENTER, `score ${d.read.score}`);
  const R = d.edges.resistance!, S = d.edges.support!;
  const before: AtlasRead = {
    ...d.read, at: now - 5 * M, lean: 'bearish_lean', strength: 'clear', score: -35, since: now - 50 * M, previous: null,
    invalidation: { text: 'held', price: R.price, ref: R.ref }, nextWatch: { text: 'next', ref: S.ref },
  };
  const read = computeRead({ snapshot: m.snap, bars: m.bars, previous: before });
  assert.equal(read.lean, 'bearish_lean', "it doesn't hide behind 'mixed'");
  assert.equal(read.since, before.since, 'the lean is held, not restarted');
  assert.equal(read.summary, `The broader structure remains bearish, but the five-minute chart is recovering. My intraday lean is still down unless ${fmtPx(R.price)} is reclaimed.`);
});

test('not enough current data is said plainly and never dressed up as a lean', () => {
  const { bars, snap } = marketAt(BULL, AT);
  const before = computeRead({ snapshot: snap, bars, previous: null });       // bullish
  const cases: [string, Parameters<typeof computeRead>[0], RegExp][] = [
    ['no snapshot', { snapshot: null, bars, previous: before }, /no market snapshot/],
    ['stale snapshot', { snapshot: snap, bars, previous: before, now: AT + 6 * M }, /6 minutes old/],
    ['feed stale', { snapshot: { ...snap, blockers: [{ code: 'feed_stale', detail: 'Twelvedata feed is stale' }] }, bars, previous: before }, /twelvedata feed is stale/],
    ['feeds disagree', { snapshot: { ...snap, blockers: [{ code: 'feed_divergence', detail: 'Price feeds disagree by $2.10' }] }, bars, previous: before }, /price feeds disagree/],
    ['too few candles', { snapshot: snap, bars: { ...bars, '5m': bars['5m']!.slice(-20) }, previous: before }, /not enough closed 5-minute candles/],
    ['a recent gap', { snapshot: snap, bars: { ...bars, '5m': [...bars['5m']!.slice(0, -8), ...bars['5m']!.slice(-4)] }, previous: before }, /recent gap/],
  ];
  for (const [name, input, why] of cases) {
    const r = computeRead(input);
    assert.equal(r.lean, 'insufficient_data', name);
    assert.equal(r.score, 0, `${name}: no score from data it cannot trust`);
    assert.equal(r.strength, null);
    assert.equal(r.invalidation, null);
    assert.deepEqual([r.evidenceFor, r.evidenceAgainst], [[], []]);
    assert.match(r.summary, why, name);
    if (input.snapshot) assert.match(r.summary, /Before that, my intraday lean was up\./, `${name}: it says what it thought before`);
    if (input.snapshot) assert.equal(r.previous?.lean, 'bullish_lean');
  }
  const shut = (when: number): MarketSnapshot => ({ ...snap, at: when, session: 'closed', blockers: [{ code: 'market_closed', detail: 'Market is closed' }] });
  const closed = computeRead({ snapshot: shut(AT), bars, previous: before });
  assert.equal(closed.lean, 'insufficient_data');
  assert.equal(closed.summary, "Gold is closed, so I'm not holding a live intraday lean. Going into the close it was up.");
  // Fifteen minutes later, still shut: it still remembers how it went into the close.
  const later = computeRead({ snapshot: shut(AT + 15 * M), bars, previous: closed, now: AT + 15 * M });
  assert.equal(later.since, closed.since);
  assert.equal(later.summary, closed.summary);
});

/* ─────────────────────────── a lean is never an entry ─────────────────────────── */

test('a lean never produces an entry: only the setup engine can confirm one', () => {
  const all: SetupState[] = ['blocked', 'no_setup', 'watching', 'setup_developing', 'waiting_for_trigger', 'trade_ready', 'setup_invalidated', 'setup_expired'];
  for (const s of all) {
    const m = setupStageOf(s);
    assert.equal(m.entry === 'confirmed', s === 'trade_ready', `${s} → entry ${m.entry}`);
    assert.equal(m.entry === 'awaiting_confirmation', s === 'waiting_for_trigger');
  }
  assert.deepEqual(setupStageOf(null), { setupStage: 'none', entry: 'none' });
  assert.deepEqual(setupStageOf('trade_ready', true), { setupStage: 'in_trade', entry: 'none' });

  const { bars, snap } = marketAt(BULL, AT);
  const strong = computeRead({ snapshot: snap, bars, previous: null });
  assert.ok(strong.score >= READ_RULES.COLD_ENTER);
  assert.equal(strong.entry, 'none', 'however strong the lean');
  const ready = computeRead({ snapshot: snap, bars, previous: null, setup: { state: 'trade_ready' } });
  assert.equal(ready.entry, 'confirmed');
  assert.equal(ready.setupStage, 'ready');
  // The setup changes the stage and nothing else: the read itself is identical.
  const strip = (r: AtlasRead) => ({ ...r, setupStage: null, entry: null });
  assert.deepEqual(strip(ready), strip(strong));
  assert.deepEqual(withSetupStage(strong, 'waiting_for_trigger'), { ...strong, setupStage: 'developing', entry: 'awaiting_confirmation' });
  assert.equal(computeRead({ snapshot: marketAt(BEAR, AT).snap, bars: marketAt(BEAR, AT).bars, previous: null }).entry, 'none');
});

/* ─────────────────────────── hysteresis ─────────────────────────── */

test('every change of lean across a synthetic day obeys the rules — noise never flips it', () => {
  let changes = 0;
  for (let k = 1; k < BULL_DAY.length; k++) {
    const a = BULL_DAY[k - 1].read, b = BULL_DAY[k].read;
    if (a.lean === b.lean) { assert.equal(b.since, a.since, 'an unchanged lean keeps its start'); continue; }
    changes += 1;
    const why = b.previous?.reason ?? '';
    assert.equal(b.since, b.at);
    assert.equal(b.previous?.lean, a.lean);
    const d = b.lean === 'bullish_lean' ? 1 : b.lean === 'bearish_lean' ? -1 : 0;
    const was = a.lean === 'bullish_lean' ? 1 : a.lean === 'bearish_lean' ? -1 : 0;
    const decisive = /^A 15-minute candle closed (below|above)|^Structure (confirmed it|turned)|^The data is usable again|^Not enough current data/.test(why);
    if (d !== 0 && !decisive) {
      assert.ok(a.score * d >= READ_RULES.ENTER && b.score * d >= READ_RULES.ENTER, `entered ${b.lean} at ${new Date(b.at).toISOString()} without two readings (${a.score}, ${b.score})`);
    }
    if (was !== 0 && d === 0 && !decisive) {
      assert.ok(a.score * was < READ_RULES.EXIT && b.score * was < READ_RULES.EXIT, `dropped ${a.lean} at ${new Date(b.at).toISOString()} on one reading (${a.score}, ${b.score})`);
    }
  }
  assert.ok(changes >= 6 && changes <= 30, `a moving market changes its read sometimes, not constantly (${changes} in 14h)`);
});

test('entering a lean takes two readings on two different closed candles', () => {
  const first = at(BULL_DAY, '2026-10-14T13:45:00Z').read;
  assert.equal(first.lean, 'balanced', 'one strong reading is not a lean');
  assert.ok(first.score >= READ_RULES.ENTER);
  assert.match(first.summary, /The evidence has just tilted up, but I want one more closed candle before I call it a lean\.$/);

  // A second reading INSIDE the same 5-minute candle sees the same candles — it does not count twice.
  const same = marketAt(BULL, t('2026-10-14T13:47:00Z'));
  assert.equal(computeRead({ snapshot: same.snap, bars: same.bars, previous: first }).lean, 'balanced');

  const second = at(BULL_DAY, '2026-10-14T13:50:00Z').read;
  assert.equal(second.lean, 'bullish_lean');
  assert.match(second.previous!.reason, /^The evidence held above \+30 on two closed candles \(\+\d+, then \+\d+\)\.$/);
});

test('one reading below the hold line is noise; two on separate candles end the lean', () => {
  const held = at(BULL_DAY, '2026-10-14T04:45:00Z').read;
  assert.equal(held.lean, 'bullish_lean');
  assert.ok(held.score < READ_RULES.EXIT, `score ${held.score} is under the hold line`);
  assert.match(held.summary, /My intraday lean is still up, but the evidence has turned against it — one more closed candle like this and it changes/);

  const same = marketAt(BULL, t('2026-10-14T04:48:00Z'));
  assert.equal(computeRead({ snapshot: same.snap, bars: same.bars, previous: held }).lean, 'bullish_lean', 'same candle, same verdict');

  const next = at(BULL_DAY, '2026-10-14T04:50:00Z').read;
  assert.equal(next.lean, 'balanced');
  assert.match(next.previous!.reason, /^The case for the bullish lean faded: the evidence was \+\d+ and is now \+\d+, below the 15 it needs to hold, on two readings\.$/);
});

test('a decisive event moves the read at once', () => {
  // 1. A 15-minute close through the lean's own invalidation — even with the score still above the hold line.
  const before = at(BULL_DAY, '2026-10-14T14:40:00Z').read;
  const after = at(BULL_DAY, '2026-10-14T14:45:00Z').read;
  assert.equal(before.lean, 'bullish_lean');
  assert.ok(after.score >= READ_RULES.EXIT, 'the score alone would have held it');
  assert.notEqual(after.lean, 'bullish_lean');
  assert.equal(after.previous!.reason, `A 15-minute candle closed below ${fmtPx(before.invalidation!.price!)} at ${fmtPx(marketAt(BULL, after.at).bars['15m']!.at(-1)!.c)}, the level the bullish lean depended on.`);

  // 2. A 5-minute close through the last confirmed 15-minute swing, with the evidence agreeing: on the spot.
  const prior = at(BULL_DAY, '2026-10-14T06:25:00Z').read;
  const broke = at(BULL_DAY, '2026-10-14T06:30:00Z').read;
  assert.ok(prior.lean !== 'bullish_lean' && prior.score < READ_RULES.ENTER, 'no two-reading confirmation was available');
  assert.equal(broke.lean, 'bullish_lean');
  assert.match(broke.previous!.reason, /^Structure confirmed it: a 5-minute candle closed above the last 15-minute swing high at [\d,]+\.\d\d, with the evidence at \+\d+\.$/);

  // 3. Through the invalidation with the evidence the other way: straight to the other side, no waiting.
  const m = marketAt(BEAR, AT);
  const last15 = m.bars['15m']!.at(-1)!;
  const wrong: AtlasRead = { ...cold(BEAR, AT - 5 * M).read, lean: 'bullish_lean', score: 40, strength: 'clear', since: AT - 90 * M, previous: null,
    invalidation: { text: 'x', price: +(last15.c + 0.5).toFixed(2) } };
  const flipped = computeRead({ snapshot: m.snap, bars: m.bars, previous: wrong });
  assert.equal(flipped.lean, 'bearish_lean');
  assert.match(flipped.previous!.reason, /^A 15-minute candle closed below/);
});

test("a lean its own rules just retired needs two fresh readings to come back", () => {
  for (let k = 2; k < BULL_DAY.length; k++) {
    const ended = BULL_DAY[k - 1].read, now = BULL_DAY[k].read;
    if (!(ended.since === ended.at && ended.previous?.lean === 'bullish_lean')) continue;
    if (now.lean === 'bullish_lean') assert.match(now.previous!.reason, /^Structure confirmed it/, `re-entered at ${new Date(now.at).toISOString()} on the reading that ended it`);
  }
});

test('levels hold still: a held lean never moves its invalidation away from price', () => {
  for (let k = 1; k < BULL_DAY.length; k++) {
    const a = BULL_DAY[k - 1].read, b = BULL_DAY[k].read;
    if (a.lean !== 'bullish_lean' || b.lean !== 'bullish_lean' || a.invalidation?.price == null || b.invalidation?.price == null) continue;
    assert.ok(b.invalidation.price >= a.invalidation.price, `invalidation loosened ${a.invalidation.price} → ${b.invalidation.price} at ${new Date(b.at).toISOString()}`);
  }
});

/* ─────────────────────────── no lookahead ─────────────────────────── */

test('the forming candle never confirms, breaks or reclaims anything', () => {
  const { bars, snap } = marketAt(BULL, AT);
  const base = computeRead({ snapshot: snap, bars, previous: null });
  for (const wild of [+250, -250]) {
    const withForming: Partial<Record<Timeframe, Bar[]>> = {};
    for (const tf of ['5m', '15m', '1h', '4h'] as Timeframe[]) {
      const b = bars[tf]!;
      const open = Math.floor(AT / SPAN[tf]) * SPAN[tf];       // the candle that is still forming at AT
      const last = b[b.length - 1].c;
      withForming[tf] = [...b, { t: open, o: last, h: Math.max(last, last + wild), l: Math.min(last, last + wild), c: last + wild }];
    }
    assert.deepEqual(computeRead({ snapshot: snap, bars: withForming, previous: null }), base, `a forming candle ${wild > 0 ? 'spiking' : 'collapsing'} changed the read`);
  }
});

test('a candle that closed after its series was fetched is not read as closed', () => {
  const { bars, snap } = marketAt(BULL, AT);
  const fetchedEarly = computeRead({ snapshot: snap, bars, barsAsOf: { '5m': AT - 2 * M }, previous: null });
  const withoutIt = computeRead({ snapshot: snap, bars: { ...bars, '5m': bars['5m']!.slice(0, -1) }, previous: null });
  assert.deepEqual(fetchedEarly, withoutIt);
  assert.deepEqual(closedOnly(bars['5m'], '5m', AT - 2 * M), bars['5m']!.slice(0, -1));
  // Unsorted, duplicated and forming input comes out closed, de-duplicated and in order.
  const messy = [bars['5m']!.at(-1)!, bars['5m']!.at(-3)!, bars['5m']!.at(-2)!, bars['5m']!.at(-3)!, { t: AT, o: 1, h: 1, l: 1, c: 1 }];
  assert.deepEqual(closedOnly(messy, '5m', AT), bars['5m']!.slice(-3));
});

test('a swing is confirmed only after two later closed candles', () => {
  const mk = (hs: number[]): Bar[] => hs.map((h, i) => ({ t: AT - (hs.length - i) * 5 * M, o: h - 1, h, l: h - 2, c: h - 0.5 }));
  const peakOneAgo = mk([10, 11, 12, 13, 20, 14]);          // the peak has one candle after it
  assert.equal(swingRead(peakOneAgo, '5m').lastHigh, null);
  const peakTwoAgo = mk([10, 11, 12, 13, 20, 14, 13]);      // two candles after it: now it is a swing
  assert.equal(swingRead(peakTwoAgo, '5m').lastHigh?.price, 20);
  assert.equal(swingRead(peakTwoAgo, '5m').lastHigh?.t, peakTwoAgo[4].t, 'stamped with the candle open time');
});

test('replay: the read at step k is the read computed from the recording cut at k', () => {
  const full = replay(46);
  assert.equal(full.atlas.length, 46);
  for (const cut of [1, 5, 13, 30]) {
    const part = replay(46 - cut, false, cut);
    assert.deepEqual(part.atlas.at(-1), full.atlas[full.atlas.length - 1 - cut], `step ${full.atlas.length - 1 - cut} saw the future`);
  }
  // Every reference in every replayed read is a candle closed by that step's own time.
  for (const s of full.atlas) {
    for (const e of [...s.read.evidenceFor, ...s.read.evidenceAgainst]) {
      if (e.ref && (e.ref.kind === 'swing' || e.ref.kind === 'candle')) assert.ok(e.ref.t + SPAN[e.ref.tf] <= s.at, 'a reference to a candle that had not closed');
    }
  }
  // The screen gets the last step, with the replayed setup's stage, labelled by the replay banner.
  assert.equal(full.state.live, false);
  assert.deepEqual(withSetupStage(full.atlas.at(-1)!.read, full.state.setup.state), full.state.read);
  assert.deepEqual(full.state.scenarios, full.atlas.at(-1)!.scenarios);
  assert.ok(full.state.readHistory.length >= 1 && full.state.readHistory[0].at === full.state.read!.since);
});

test("replay: the read is given the hour as it stood, never the recording's finished hour", () => {
  const raw = JSON.parse(readFileSync('command-center/fixtures/replay-bars.json', 'utf8')) as { m5: number[][]; h1: number[][] };
  const toBars = (rows: number[][]): Bar[] => rows.map(([s, o, h, l, c]) => ({ t: s * 1000, o, h, l, c }));
  const m5 = toBars(raw.m5), h1 = toBars(raw.h1);
  const k = m5.length - 8;                                   // a step 35 minutes into an hour
  const stepAt = m5[k].t + 5 * M;
  const asLive = hourlyAsOf(m5.slice(0, k + 1), h1, stepAt);
  // Whatever the recording says about any hour not closed by then, the read is given the same candles.
  const scrambled = h1.map((b) => (b.t + 60 * M > stepAt ? { ...b, o: 1, h: 99_999, l: 0.5, c: 2 } : b));
  assert.deepEqual(hourlyAsOf(m5.slice(0, k + 1), scrambled, stepAt), asLive);
  const forming = asLive.at(-1)!;
  assert.ok(forming.t + 60 * M > stepAt, 'the last hourly candle is the one still forming');
  const soFar = m5.slice(0, k + 1).filter((b) => b.t >= forming.t);
  assert.deepEqual(forming, { t: forming.t, o: soFar[0].o, h: Math.max(...soFar.map((b) => b.h)), l: Math.min(...soFar.map((b) => b.l)), c: soFar.at(-1)!.c }, 'built from the 5-minute candles so far');
});

test('the same inputs always give the same read, and the inputs are never touched', () => {
  const { bars, snap } = marketAt(BULL, AT);
  const prev = cold(BULL, AT - 5 * M).read;
  const before = JSON.stringify({ bars, snap, prev });
  const a = computeRead({ snapshot: snap, bars, previous: prev });
  const b = computeRead({ snapshot: snap, bars, previous: prev });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify({ bars, snap, prev }), before, 'computeRead mutated its input');
});

/* ─────────────────────────── scenarios ─────────────────────────── */

function bullScenarios() {
  const m = marketAt(BULL, AT);
  const d = computeReadDetailed({ snapshot: m.snap, bars: m.bars, previous: null });
  const scs = updateScenarios(d.read, m.snap, [], AT, { bars: m.bars, edges: d.edges });
  return { ...m, d, scs, S: d.edges.support!.price, R: d.edges.resistance!.price };
}
/** The bars after AT: 5-minute candles closing at `closes`, and the 15-minute candles they complete. */
function after(bars: Partial<Record<Timeframe, Bar[]>>, closes: number[]): Partial<Record<Timeframe, Bar[]>> {
  const m5 = [...bars['5m']!];
  let p = m5[m5.length - 1].c;
  closes.forEach((c, i) => { m5.push({ t: AT + i * 5 * M, o: p, h: Math.max(p, c) + 0.1, l: Math.min(p, c) - 0.1, c }); p = c; });
  return { ...bars, '5m': m5, '15m': resample(m5, '5m', '15m') };
}
const byRole = (scs: Scenario[], role: Scenario['role']) => scs.find((s) => isActiveScenario(s) && s.role === role)!;

test('scenarios: base, alternative and view change, each with precise prices and references', () => {
  const { scs, S, R, snap } = bullScenarios();
  assert.equal(scs.length, 3);
  const base = byRole(scs, 'base'), alt = byRole(scs, 'alternative'), view = byRole(scs, 'view_change');
  assert.deepEqual([base.direction, alt.direction, view.direction], ['up', 'range', 'down']);
  assert.ok(S < snap.price && snap.price < R);
  assert.deepEqual([base.trigger.price, base.invalidation.price], [R, S]);
  assert.deepEqual([view.trigger.price, view.invalidation.price], [S, R]);
  assert.ok(base.trigger.ref && base.invalidation.ref, 'every level has a reference the chart can draw');
  assert.deepEqual(alt.trigger.ref, { kind: 'zone', from: S, to: R, label: `${fmtPx(S)}–${fmtPx(R)}` });
  assert.equal(alt.trigger.price, null);
  for (const s of scs) {
    assert.equal(s.status, 'watching');
    assert.equal(s.since, AT);
    assert.equal(s.tf, SCENARIO_RULES.TF);
    assert.equal(s.history.length, 1);
  }
  assert.match(base.trigger.text, /^A 15-minute close above [\d,]+\.\d\d \(.+\)$/);
});

test('a lean alone never confirms a scenario — only a closed candle through the trigger does', () => {
  const { d, scs, snap, bars, R } = bullScenarios();
  // A much stronger lean, a minute later, no new candle: nothing is confirmed.
  const louder: AtlasRead = { ...d.read, score: 95, strength: 'strong' };
  const same = updateScenarios(louder, snap, scs, AT + M, { bars, edges: d.edges });
  assert.ok(same.every((s) => s.status === 'watching' || s.status === 'developing'));

  // A 5-minute close above the trigger: developing — the 15-minute close still decides.
  const five = updateScenarios(d.read, snap, scs, AT + 5 * M, { bars: after(bars, [R + 1]), edges: d.edges });
  const base5 = byRole(five, 'base');
  assert.equal(base5.status, 'developing');
  assert.match(base5.history.at(-1)!.reason, /^A 5-minute candle closed above [\d,]+\.\d\d at [\d,]+\.\d\d; the 15-minute close decides it\.$/);

  // The 15-minute candle closes above it: confirmed, and the history is appended, never rewritten.
  const fifteen = updateScenarios(d.read, snap, five, AT + 15 * M, { bars: after(bars, [R + 1, R + 1.2, R + 1.5]), edges: d.edges });
  const base15 = fifteen.find((s) => s.id === base5.id)!;
  assert.equal(base15.status, 'confirmed');
  assert.deepEqual(base15.history.slice(0, base5.history.length), base5.history);
  assert.equal(base15.history.at(-1)!.reason, `The 15-minute candle that closed at 14:15 UTC closed above ${fmtPx(R)} at ${fmtPx(R + 1.5)}.`);
  assert.equal(base15.history.at(-1)!.at, AT + 15 * M, 'stamped when the candle closed');
  // The same close settles the others: the view change and the range are invalidated by it.
  assert.equal(fifteen.find((s) => s.id === byRole(scs, 'view_change').id)!.status, 'invalidated');
  assert.equal(fifteen.find((s) => s.id === byRole(scs, 'alternative').id)!.status, 'invalidated');

  // A finished call is final: whatever happens next, it is never edited.
  const later = updateScenarios(d.read, snap, fifteen, AT + 30 * M, { bars: after(bars, [R + 1, R + 1.2, R + 1.5, R - 20, R - 25, R - 30]), edges: d.edges });
  assert.deepEqual(later.find((s) => s.id === base15.id), base15);
});

test('a scenario with no resolution expires at its horizon, with the reason on the record', () => {
  const { d, scs, snap, bars } = bullScenarios();
  const late = AT + SCENARIO_RULES.HORIZON_MS['15m'] + 5 * M;
  const out = updateScenarios(d.read, snap, scs, late, { bars, edges: d.edges });
  for (const s of scs) {
    const x = out.find((y) => y.id === s.id)!;
    assert.equal(x.status, 'expired');
    assert.equal(x.history.at(-1)!.reason, 'No resolution within 4 hours — the levels it was built on are stale.');
    assert.equal(x.history.at(-1)!.at, AT + SCENARIO_RULES.HORIZON_MS['15m']);
  }
  assert.equal(out.filter(isActiveScenario).length, 3, 'fresh calls are opened from the current read');
});

test('when the levels move, a watching scenario is superseded and the old call stays as it was made', () => {
  const { d, scs, snap, bars, S } = bullScenarios();
  const atr15 = snap.timeframes['15m']!.features.atr;
  const moved = { ...d.edges, support: { ...d.edges.support!, price: +(S - 2 * atr15).toFixed(2) } };
  const out = updateScenarios(d.read, snap, scs, AT + 5 * M, { bars, edges: moved });
  for (const s of scs) {
    const x = out.find((y) => y.id === s.id)!;
    assert.equal(x.status, 'expired');
    assert.match(x.history.at(-1)!.reason, /^Superseded: the read's levels for this path moved from [\d,.]+–[\d,.]+ to [\d,.]+–[\d,.]+\.$/);
    assert.deepEqual(x.history.slice(0, s.history.length), s.history);
    assert.deepEqual([x.trigger, x.invalidation], [s.trigger, s.invalidation], 'its prices are never rewritten');
  }
  assert.equal(byRole(out, 'base').invalidation.price, moved.support.price);

  // A scenario already DEVELOPING is never pulled before its candle closes.
  const developing = updateScenarios(d.read, snap, scs, AT + 5 * M, { bars: after(bars, [d.edges.resistance!.price + 1]), edges: d.edges });
  const kept = updateScenarios(d.read, snap, developing, AT + 6 * M, { bars: after(bars, [d.edges.resistance!.price + 1]), edges: moved });
  assert.equal(kept.find((s) => s.id === byRole(developing, 'base').id)!.status, 'developing');
});

function assertAppendOnly(steps: { at: number; scenarios: Scenario[] }[], label: string) {
  let resolved = 0;
  for (let k = 1; k < steps.length; k++) {
    const before = new Map(steps[k - 1].scenarios.map((s) => [s.id, s]));
    for (const s of steps[k].scenarios) {
      for (let i = 1; i < s.history.length; i++) assert.ok(s.history[i].at >= s.history[i - 1].at, `${label}: history runs backwards`);
      const p = before.get(s.id);
      if (!p) { assert.equal(s.history[0].status, 'watching'); continue; }
      assert.deepEqual(s.history.slice(0, p.history.length), p.history, `${label}: history rewritten`);
      assert.deepEqual([s.direction, s.trigger, s.invalidation, s.since, s.tf], [p.direction, p.trigger, p.invalidation, p.since, p.tf], `${label}: a call changed its prices`);
      if (!isActiveScenario(p)) assert.deepEqual(s, p, `${label}: a finished scenario changed`);
      if (isActiveScenario(p) && (s.status === 'confirmed' || s.status === 'invalidated')) {
        resolved += 1;
        assert.match(s.history.at(-1)!.reason, /^The 15-minute candle that closed at \d\d:\d\d UTC /, `${label}: resolved without a closed candle`);
      }
    }
    const live = steps[k].scenarios.filter(isActiveScenario);
    assert.equal(new Set(live.map((s) => s.direction)).size, live.length, `${label}: two live scenarios on one path`);
    assert.equal(new Set(live.map((s) => s.role)).size, live.length, `${label}: two live scenarios in one role`);
  }
  return resolved;
}

test('scenario history is append-only across a whole recorded session and a synthetic day', () => {
  assert.ok(assertAppendOnly(replay(46).atlas, 'replay') >= 3);
  assert.ok(assertAppendOnly(BULL_DAY, 'synthetic') >= 10);
});

/* ─────────────────────────── persistence and history ─────────────────────────── */

test('reads are written when something changes, and otherwise at most every few minutes', () => {
  const read = cold(BULL).read;
  const quiet: AtlasStep = { read, scenarios: [], leanChanged: false, scenarioChanges: [], reason: 'Held' };
  const at0 = { lastPersistAt: AT, unwrittenChange: false };
  assert.equal(shouldPersistRead(quiet, { ...at0, now: AT + 60_000 }), false);
  assert.equal(shouldPersistRead(quiet, { ...at0, now: AT + READ_PERSIST_MS }), true);
  assert.equal(shouldPersistRead({ ...quiet, leanChanged: true }, { ...at0, now: AT + 60_000 }), true);
  assert.equal(shouldPersistRead({ ...quiet, scenarioChanges: ['"x" watching → developing'] }, { ...at0, now: AT + 60_000 }), true);
  assert.equal(shouldPersistRead(quiet, { ...at0, now: AT + 60_000, unwrittenChange: true }), true, 'a failed write is retried');

  const s0 = atlasStep({ snapshot: marketAt(BULL, AT).snap, bars: marketAt(BULL, AT).bars, previous: null });
  assert.equal(s0.leanChanged, true);
  assert.match(s0.reason, /^Lean: Bullish lean \(first read\)\. Scenarios: opened "/);
  const s1 = atlasStep({ snapshot: marketAt(BULL, AT + 5 * M).snap, bars: marketAt(BULL, AT + 5 * M).bars, previous: { read: s0.read, scenarios: s0.scenarios } });
  assert.deepEqual(scenarioChanges(s0.scenarios, s1.scenarios), s1.scenarioChanges);
});

test('the read history is one entry per lean, newest first, with the reason each began', () => {
  const rows = [
    { at: 5, lean: 'bullish_lean' as const, since: 3, summary: 'up', why: 'held two readings', reason: 'Held' },
    { at: 1, lean: 'balanced' as const, since: 1, summary: 'flat', why: null, reason: 'Lean: Balanced / range (first read).' },
    { at: 3, lean: 'bullish_lean' as const, since: 3, summary: 'up', why: 'held two readings', reason: 'Lean: ...' },
    { at: 4, lean: 'bullish_lean' as const, since: 3, summary: 'up', why: 'held two readings', reason: 'Held' },
    { at: 7, lean: 'balanced' as const, since: 7, summary: 'flat again', why: 'faded', reason: 'Lean: ...' },
  ];
  assert.deepEqual(readHistoryOf(rows), [
    { at: 7, lean: 'balanced', reason: 'faded', summary: 'flat again' },
    { at: 3, lean: 'bullish_lean', reason: 'held two readings', summary: 'up' },
    { at: 1, lean: 'balanced', reason: 'Lean: Balanced / range (first read).', summary: 'flat' },
  ]);
  const r = cold(BULL).read;
  assert.deepEqual(rowOfRead(r), { at: r.at, lean: r.lean, since: r.since, summary: r.summary, why: null, reason: null });
});

test('a stored read is checked before it is trusted as the previous one', () => {
  const r = cold(BULL).read;
  assert.deepEqual(readFromStored(JSON.parse(JSON.stringify(r))), r);
  assert.equal(readFromStored(null), null);
  assert.equal(readFromStored({ ...r, version: 'read-0' }), null, 'another version is a cold start, not a guess');
  assert.equal(readFromStored({ ...r, lean: 'very_bullish' }), null);
  assert.equal(readFromStored({ ...r, score: '40' }), null);
  // A previous read that is too old is history, not hysteresis: the next read starts fresh and says so.
  const { bars, snap } = marketAt(BULL, AT);
  const old = { ...r, at: AT - 45 * M, since: AT - 90 * M };
  const next = computeRead({ snapshot: snap, bars, previous: old });
  assert.equal(next.since, AT);
  assert.match(next.previous!.reason, /^The last read was 45 minutes old, so this one started fresh\.$/);
});

test('the migration creates a service-role-only, append-only table for the reads', () => {
  const up = readFileSync('supabase/migrations/20261111010000_cc_atlas_reads.sql', 'utf8');
  const down = readFileSync('supabase/migrations/20261111010000_cc_atlas_reads_down.sql', 'utf8');
  assert.match(up, /create table if not exists public\.cc_atlas_reads \(/);
  for (const col of [/id\s+bigserial primary key/, /at\s+timestamptz not null/, /snapshot_id bigint/, /version\s+text/, /lean\s+text/, /score\s+int/, /read\s+jsonb/, /scenarios\s+jsonb/, /reason\s+text/, /created_at\s+timestamptz default now\(\)/]) {
    assert.match(up, col);
  }
  assert.match(up, /alter table public\.cc_atlas_reads enable row level security;/);
  assert.ok(!/create policy/i.test(up), 'no policies: service role only');
  assert.match(up, /create index if not exists cc_atlas_reads_at_idx on public\.cc_atlas_reads \(at desc\);/);
  assert.ok(!/references/i.test(up), 'snapshot_id is not a foreign key: snapshots are pruned');
  assert.match(down, /drop table if exists public\.cc_atlas_reads;/);
});

/* ─────────────────────────── the live route's read ─────────────────────────── */

test('the live route computes the read itself when none is stored, and never from a stale snapshot', async () => {
  const { bars, snap } = marketAt(BULL, AT);
  const base = { snapshot: snap, snapshotId: 1, bars5m: bars['5m']!.slice(-140), marketIsOpen: true, setupState: 'waiting_for_trigger' as SetupState, tradeActive: false, historySince: AT - 86_400_000 };
  const fresh = await liveReadFields({ ...base, now: AT + 20_000 });
  assert.ok(fresh.read);
  assert.notEqual(fresh.read!.lean, 'insufficient_data');
  assert.equal(fresh.read!.entry, 'awaiting_confirmation', "this member's setup, mapped read-only");
  assert.deepEqual(fresh.readHistory, [], 'no stored history is shown as none, not invented');
  assert.equal(fresh.scenarios.filter(isActiveScenario).length, 3);

  const stale = await liveReadFields({ ...base, now: AT + 6 * M });
  assert.equal(stale.read!.lean, 'insufficient_data');
  assert.match(stale.read!.summary, /6 minutes old/);
  assert.equal((await liveReadFields({ ...base, tradeActive: true, now: AT + 20_000 })).read!.setupStage, 'in_trade');
});

/* ─────────────────────────── boundaries ─────────────────────────── */

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === 'node_modules' || n.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
const READ_MODULES = ['command-center/core/read', 'command-center/core/scenarios', 'command-center/engines/atlasRead'];
const importsOf = (file: string): { spec: string; typeOnly: boolean; target: string }[] => {
  const src = readFileSync(file, 'utf8');
  const out: { spec: string; typeOnly: boolean; target: string }[] = [];
  for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gms)) {
    const spec = m[2];
    out.push({ spec, typeOnly: !!m[1], target: spec.startsWith('.') ? normalize(join(dirname(file), spec)) : spec });
  }
  return out;
};

test('the read never reaches a trading path', () => {
  const allowed = new Set([
    'command-center/core/scenarios.ts', 'command-center/engines/atlasRead.ts', 'command-center/engines/live.ts',
    'command-center/engines/replay.ts', 'command-center/adapters/db.ts', 'command-center/worker/index.ts',
    // GENERATE WITH ATLAS (11-11): the idea engine describes a plan at the read's own two levels. It cannot
    // trade — tests/cc-atlas-idea.test.ts proves it imports no execution module and that nothing on a trading
    // path imports it — so the read still never reaches an order.
    'command-center/engines/idea.ts', 'command-center/engines/ideaDesk.ts',
  ]);
  const files = [...walk('command-center'), ...walk('src/lib')];
  const offenders = files.filter((f) => !allowed.has(f) && importsOf(f).some((i) => READ_MODULES.includes(i.target)));
  assert.deepEqual(offenders, []);
  for (const f of ['executor', 'autopilot', 'autoManage', 'setup', 'broker', 'callTrade', 'validator', 'tradeLive']) {
    assert.ok(existsSync(`command-center/engines/${f}.ts`));
    assert.ok(!importsOf(`command-center/engines/${f}.ts`).some((i) => READ_MODULES.includes(i.target)), `${f} imports the read`);
  }
});

test('the read modules cannot trade: nothing from engines or adapters is imported at runtime', () => {
  for (const f of READ_MODULES.map((m) => `${m}.ts`)) {
    for (const i of importsOf(f)) {
      const into = /command-center\/(engines|adapters)\//.test(i.target);
      assert.ok(!into || i.typeOnly, `${f} imports ${i.spec} at runtime`);
    }
  }
});

test('the worker computes the read after trading, contains its own failures and never hands it to a trade', () => {
  const src = readFileSync('command-center/worker/index.ts', 'utf8');
  const fn = src.slice(src.indexOf('async function atlasReadPass('), src.indexOf('async function main('));
  assert.ok(fn.includes('try {') && fn.includes('} catch (e) {'), 'every failure is caught inside the read pass');
  assert.ok(/within\(saveAtlasRead\(/.test(fn), 'the write is bounded in time');
  const pass = src.slice(src.indexOf('async function pass('), src.indexOf('async function secondLook('));
  assert.ok(pass.indexOf('await atlasReadPass(snap') > pass.indexOf('autopilotTick({'), 'the read runs after trading');
  for (const call of ['autopilotTick({', 'autoManageTick(']) {
    const i = pass.indexOf(call);
    assert.ok(!pass.slice(i, pass.indexOf(')', pass.indexOf('}', i))).includes('atlas'), `${call} is handed the read`);
  }
  assert.ok(src.includes('await restoreAtlasRead();'), 'the read is restored at boot');
});
