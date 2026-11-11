import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fixture from '../command-center/fixtures/replay-bars.json';
import { replay } from '../command-center/engines/replay';
import { replayIdea, replayFollow, replayEndOf } from '../command-center/engines/ideaReplay';
import {
  buildIdea, followIdea, ideaLevels, ideaOptionsOf, ideaRecord, ideaText, IDEA_RULES, ATLAS_IDEA_VERSION,
  type AtlasIdea, type BuildIdeaInput,
} from '../command-center/engines/idea';
import { updateVerdict } from '../command-center/engines/ideaDesk';
import { noSetup, type BrainSetup } from '../command-center/engines/setup';
import { STYLE } from '../command-center/core/style';
import { edgesOfRead } from '../command-center/core/read';
import type { AtlasRead } from '../command-center/core/atlasContract';
import type { Bar, MarketSnapshot } from '../command-center/core/types';

/*
 * GENERATE WITH ATLAS — the trade idea (owner 11-11).
 *
 * Everything here runs the REAL engine over the recorded gold session in command-center/fixtures (a
 * labelled replay fixture, 18 September) or over small hand-built cases. Nothing reaches a network.
 */

const M5 = 5 * 60_000;
const m5: Bar[] = (fixture.m5 as number[][]).map(([t, o, h, l, c]) => ({ t: t * 1000, o, h, l, c }));

/** Every moment of the recording the idea engine is asked at, three candles apart. */
const MOMENTS = (() => {
  const out: { off: number; r: ReturnType<typeof replay>; idea: AtlasIdea }[] = [];
  for (let off = 0; off <= m5.length - 100; off += 3) {
    const r = replay(40, false, off);
    const idea = buildIdea({ snapshot: r.snapshot, setup: r.state.setup, takeable: true, read: r.state.read, scenarios: r.state.scenarios, marketOpen: true, now: r.endedAt });
    out.push({ off, r, idea });
  }
  return out;
})();

const base = (r: ReturnType<typeof replay>, over: Partial<BuildIdeaInput> = {}): BuildIdeaInput => ({
  snapshot: r.snapshot, setup: r.state.setup, takeable: true, read: r.state.read, scenarios: r.state.scenarios, marketOpen: true, now: r.endedAt, ...over,
});

test('the recording produces all three answers: the engine\'s trade, a plan from the read, and standing aside', () => {
  const kinds = new Set(MOMENTS.map((m) => `${m.idea.kind}/${m.idea.source ?? '-'}`));
  assert.ok(kinds.has('stand_aside/-'), 'never stood aside');
  assert.ok(kinds.has('enter_now/setup_engine'), 'never returned the setup engine\'s ready trade');
  assert.ok([...kinds].some((k) => k.endsWith('/read_plan')), 'never returned a plan from the read');
  for (const m of MOMENTS) assert.equal(m.idea.version, ATLAS_IDEA_VERSION);
});

test('the same market always produces the same idea', () => {
  for (const off of [0, 21, 33, 57]) {
    const a = replayIdea({ style: 'auto' }, off), b = replayIdea({ style: 'auto' }, off);
    assert.deepEqual(a, b);
  }
});

test('every idea with a trade in it is geometrically sound', () => {
  for (const { idea } of MOMENTS) {
    if (idea.kind === 'stand_aside') {
      assert.equal(idea.entry, null); assert.equal(idea.stop, null); assert.deepEqual(idea.targets, []);
      assert.equal(idea.execute.via, null); assert.equal(idea.execute.now, false);
      assert.ok(idea.reasoning.length > 20, 'standing aside without a reason');
      continue;
    }
    assert.ok(idea.side && idea.entry && idea.stop && idea.style, `incomplete idea: ${idea.headline}`);
    const d = idea.side === 'buy' ? 1 : -1;
    const E = idea.entry!.price, stop = idea.stop!.price, risk = Math.abs(E - stop);
    assert.ok(d * (E - stop) > 0, `stop on the wrong side: ${idea.headline}`);
    assert.ok(idea.entry!.low <= idea.entry!.high);
    assert.ok(E >= idea.entry!.low - 0.011 && E <= idea.entry!.high + 0.011, 'the reference entry is outside its own zone');
    // Pips are the distance in gold pips ($0.10), from the reference entry.
    assert.ok(Math.abs(idea.stop!.pips - risk / 0.1) <= 1, `stop pips ${idea.stop!.pips} vs ${risk / 0.1}`);
    assert.ok(idea.targets.length >= 1 && idea.targets.length <= 3);
    let prev = 0;
    idea.targets.forEach((t, k) => {
      const dist = d * (t.price - E);
      assert.equal(t.label, `TP${k + 1}`);
      assert.ok(dist > prev, `targets out of order on ${idea.headline}`);
      assert.ok(Math.abs(t.pips - dist / 0.1) <= 1);
      assert.ok(Math.abs(t.r - dist / risk) <= 0.06, `R for ${t.label}: ${t.r} vs ${dist / risk}`);
      prev = dist;
    });
    assert.equal(idea.rr!.first, idea.targets[0].r);
    assert.equal(idea.rr!.best, idea.targets[idea.targets.length - 1].r);
    assert.ok(idea.confidence && ['Low', 'Medium', 'High'].includes(idea.confidence.label));
    assert.match(idea.confidence!.basis, /not a win probability/);
    assert.ok(idea.invalidation && idea.invalidation.text.length > 10);
  }
});

test('every target is a real level ATLAS already knows — or says plainly that it is measured, never a mix', () => {
  for (const { idea, r } of MOMENTS) {
    if (idea.kind === 'stand_aside') continue;
    const e = edgesOfRead(r.state.read);
    const real = [...ideaLevels(r.snapshot).map((l) => l.price), e.support?.price, e.resistance?.price].filter((x): x is number => x != null);
    const isReal = (p: number) => real.some((x) => Math.abs(x - p) < 0.06);
    if (idea.source === 'read_plan') {
      const bases = new Set(idea.targets.map((t) => t.basis));
      assert.equal(bases.size, 1, `real and measured targets mixed on ${idea.headline}`);
      // An objective closer than one R is not an objective; each further one is at least 0.6 R beyond.
      assert.ok(idea.targets[0].r >= IDEA_RULES.MIN_R - 0.06);
      for (let k = 1; k < idea.targets.length; k++) assert.ok(idea.targets[k].r - idea.targets[k - 1].r >= IDEA_RULES.NEXT_R - 0.11);
    }
    for (const t of idea.targets) {
      if (t.basis === 'level') assert.ok(isReal(t.price), `${t.label} ${t.price} on "${idea.headline}" is not a level ATLAS has`);
      else assert.match(t.what, /risk|multiple/);
    }
  }
});

test('a plan from the read needs a clear or strong lean, trades with it, and enters at one of its two levels', () => {
  let plans = 0;
  for (const { idea, r } of MOMENTS) {
    const read = r.state.read!;
    if (idea.source !== 'read_plan') {
      // No plan is ever made from a neutral, turning or faint read, or through a blocker.
      if (idea.kind === 'stand_aside') continue;
      assert.equal(idea.source, 'setup_engine');
      continue;
    }
    plans += 1;
    assert.ok(read.lean === 'bullish_lean' || read.lean === 'bearish_lean', `a plan from a ${read.lean} read`);
    assert.ok(read.strength === 'clear' || read.strength === 'strong', `a plan from a ${read.strength} lean`);
    assert.equal(idea.side, read.lean === 'bullish_lean' ? 'buy' : 'sell');
    assert.equal(r.snapshot.blockers.length, 0);
    assert.match(idea.badge, /NOT AN ENGINE-CONFIRMED TRADE/);
    assert.equal(idea.execute.via, 'manual');
    assert.equal(idea.execute.approved, null, 'a plan must never carry a take-setup approval');
    // Intraday by default: the stop sits inside the style's own floor and ceiling.
    assert.equal(idea.style, 'hold');
    assert.ok(idea.stop!.pips >= STYLE.hold.noiseFloorPips * 0.5 && idea.stop!.pips <= STYLE.hold.maxStopPips);
    // The entry is a level, never "wherever gold is": either price is inside the zone, or it is not executable now.
    assert.ok(idea.entry!.level, 'a plan with no level');
    assert.notEqual(idea.entry!.type, 'market');
    if (idea.execute.now) assert.equal(idea.entry!.distancePips, 0);
    else assert.ok(idea.watch, 'a plan that is not at its entry must be watchable');
    // The level the stop hides behind is on the far side of the entry.
    const d = idea.side === 'buy' ? 1 : -1;
    assert.ok(d * (idea.entry!.price - idea.entry!.level!.price) >= -0.011);
    assert.ok(d * (idea.entry!.level!.price - idea.stop!.price) > 0);
    assert.ok(idea.expiresAt === r.endedAt + IDEA_RULES.PLAN_TTL_MS);
  }
  assert.ok(plans >= 3, `only ${plans} plans on the recording`);
  // And the other way round: a neutral or faint read never produces one.
  for (const { idea, r } of MOMENTS) {
    const read = r.state.read!;
    const weak = read.lean === 'balanced' || read.lean === 'transitioning' || read.lean === 'insufficient_data' || (read.strength !== 'clear' && read.strength !== 'strong');
    if (weak) assert.notEqual(idea.source, 'read_plan', `a plan from a ${read.lean}/${read.strength} read`);
    if (r.snapshot.blockers.length) assert.equal(idea.kind, 'stand_aside', 'an idea was priced through a blocker');
  }
});

test('when the setup engine has a trade ready, the idea is that trade number for number', () => {
  const ready = MOMENTS.filter((m) => m.r.state.setup.state === 'trade_ready');
  assert.ok(ready.length >= 1, 'the recording has no ready setup to test against');
  for (const { idea, r } of ready) {
    const su = r.state.setup;
    assert.equal(idea.kind, 'enter_now'); assert.equal(idea.source, 'setup_engine');
    assert.equal(idea.side, su.side); assert.equal(idea.style, su.style);
    assert.equal(idea.stop!.price, su.stop);
    assert.equal(idea.targets[0].price, su.initialObjective);
    if (idea.targets[1]) assert.equal(idea.targets[1].price, su.extendedObjective);
    assert.equal(idea.entry!.type, 'market');
    assert.equal(idea.entry!.low, su.entryLow); assert.equal(idea.entry!.high, su.entryHigh);
    assert.equal(idea.confidence!.score, su.confidence);
    assert.equal(idea.expiresAt, su.expiresAt);
    // It is taken as ATLAS's own trade: the approval is exactly what take-setup compares against.
    assert.equal(idea.execute.via, 'take_setup'); assert.equal(idea.execute.now, true);
    assert.deepEqual(idea.execute.approved, { side: su.side, style: su.style, stop: su.stop, invalidationPrice: su.invalidationPrice });
    assert.deepEqual(idea.confirmations.map((c) => [c.label, c.ok]), su.conditions.map((c) => [c.text, c.met]));
    // The member's style filter changing the engine's answer turns it into their own call.
    const mine = buildIdea(base(r, { takeable: false }));
    assert.equal(mine.execute.via, 'manual'); assert.equal(mine.execute.approved, null);
    assert.deepEqual(mine.execute.manual, { side: su.side, style: su.style, stop: su.stop, takeProfit: su.initialObjective });
  }
});

test('nothing is priced from missing, closed, stale or blocked data', () => {
  const r = MOMENTS.find((m) => m.idea.kind !== 'stand_aside')!.r;
  const none = buildIdea(base(r, { snapshot: null }));
  assert.equal(none.kind, 'stand_aside'); assert.equal(none.price, null);
  const closed = buildIdea(base(r, { marketOpen: false }));
  assert.equal(closed.kind, 'stand_aside'); assert.match(closed.reasoning, /closed/i);
  const stale = buildIdea(base(r, { stale: true, now: r.endedAt + 9 * 60_000 }));
  assert.equal(stale.kind, 'stand_aside'); assert.match(stale.reasoning, /9 minutes old/);
  const blockedSnap: MarketSnapshot = { ...r.snapshot, blockers: [{ code: 'feed_stale', detail: 'The price feed is stale' }] };
  const blocked = buildIdea(base(r, { snapshot: blockedSnap }));
  assert.equal(blocked.kind, 'stand_aside'); assert.match(blocked.reasoning, /price feed is stale/);
  const noRead = buildIdea(base(r, { read: null, setup: noSetup('Nothing has set up.', ['a level to break']) }));
  assert.equal(noRead.kind, 'stand_aside'); assert.deepEqual(noRead.waitingFor, ['a level to break']);
  for (const x of [none, closed, stale, blocked, noRead]) { assert.equal(x.execute.via, null); assert.equal(x.watch, null); }
});

test('standing aside still says where a trade would be', () => {
  const quiet = MOMENTS.filter((m) => m.idea.kind === 'stand_aside' && m.r.snapshot.blockers.length === 0 && edgesOfRead(m.r.state.read).support);
  assert.ok(quiet.length >= 3);
  for (const { idea, r } of quiet) {
    const e = edgesOfRead(r.state.read);
    assert.equal(idea.paths.length, 2);
    const up = idea.paths.find((p) => p.side === 'buy')!, down = idea.paths.find((p) => p.side === 'sell')!;
    assert.equal(up.price, +e.resistance!.price.toFixed(2)); assert.equal(up.direction, 'above');
    assert.equal(down.price, +e.support!.price.toFixed(2)); assert.equal(down.direction, 'below');
    assert.match(up.text, /15-minute close above/);
  }
});

test('the style choice is honoured honestly', () => {
  const plan = MOMENTS.find((m) => m.idea.source === 'read_plan')!;
  // Swing: the read is an intraday read, and ATLAS will not dress it up as a swing thesis.
  const swing = buildIdea(base(plan.r, { options: { style: 'swing' }, setup: noSetup('No swing setup.') }));
  assert.equal(swing.kind, 'stand_aside'); assert.match(swing.reasoning, /swing/);
  // Quick is priced only when asked for, on the five-minute range, and says what that means.
  const quick = buildIdea(base(plan.r, { options: { style: 'quick' }, setup: noSetup('No quick setup.') }));
  if (quick.kind !== 'stand_aside') {
    assert.equal(quick.style, 'quick');
    assert.ok(quick.stop!.pips <= STYLE.quick.maxStopPips);
    assert.ok(quick.warnings.some((w) => /five-minute range/.test(w)));
  }
  assert.deepEqual(ideaOptionsOf({ style: 'hold' }), { style: 'hold' });
  assert.deepEqual(ideaOptionsOf({ style: 'everything' }), { style: 'auto' });
  assert.deepEqual(ideaOptionsOf(null), { style: 'auto' });
  // When the filter hides the engine's own pick, the idea says so.
  const ready = MOMENTS.find((m) => m.r.state.setup.state === 'trade_ready')!;
  const hidden = buildIdea(base(ready.r, { options: { style: 'quick' }, setup: noSetup('No quick setup.'), takeable: false, enginePick: ready.r.state.setup }));
  assert.ok(hidden.warnings.some((w) => /With no style filter/.test(w)));
});

/* ── the setup engine's waiting states (hand-built: the recording has none) ─────────────────────── */

const waiting = (r: ReturnType<typeof replay>, over: Partial<BrainSetup>): BrainSetup => {
  const p = r.snapshot.price;
  return {
    state: 'waiting_for_trigger', side: 'buy', style: 'hold', strategy: 'trend_pullback', styleWhy: 'The 15m and 1h structure is carrying this.',
    entryLow: +(p - 0.6).toFixed(2), entryHigh: +p.toFixed(2), stop: +(p - 9).toFixed(2), initialObjective: +(p + 14).toFixed(2), extendedObjective: +(p + 26).toFixed(2),
    stopPips: 90, expectedMovePips: [140, 260], conditions: [], metCount: 0, totalCount: 0, confidence: 62,
    thesis: 'Pullback into trend. 15m is still making higher lows.', invalidation: `A close back below ${(p - 6).toFixed(2)} with bearish pressure expanding.`,
    invalidationPrice: +(p - 6).toFixed(2), waitingFor: [], say: 'Everything is in place except the trigger.', headline: 'WAITING FOR TRIGGER',
    blockedBy: null, expiresAt: r.endedAt + 90 * 60_000, at: r.endedAt, ...over,
  };
};

test('waiting on a break trigger: the entry is the trigger, re-priced from it, and nothing is executable yet', () => {
  const r = MOMENTS[0].r, p = r.snapshot.price;
  const trig = +(p + 4).toFixed(2);
  const su = waiting(r, { conditions: [
    { id: 'pivot', text: `Hold above ${(p - 6).toFixed(2)}`, met: true, detail: '', trigger: false },
    { id: 'trigger', text: `Break ${trig.toFixed(2)}`, met: false, detail: '40 pips away.', trigger: true },
  ] });
  const idea = buildIdea(base(r, { setup: su }));
  assert.equal(idea.kind, 'on_break'); assert.equal(idea.source, 'setup_engine');
  assert.equal(idea.entry!.price, trig); assert.equal(idea.entry!.confirm, 'touch'); assert.equal(idea.entry!.type, 'stop');
  assert.equal(idea.stop!.price, su.stop);
  assert.equal(idea.stop!.pips, Math.round((trig - su.stop!) / 0.1));
  assert.equal(idea.execute.via, null); assert.equal(idea.execute.now, false);
  assert.deepEqual(idea.watch, { price: trig, direction: 'above', say: `Watch ${trig.toFixed(2)} and tell me if it breaks above.` });
  assert.ok(idea.targets[0].r >= 1 - 0.06);
});

test('ready on the conditions but short on confidence: said plainly, and only ever the member\'s own call', () => {
  const r = MOMENTS[0].r;
  const su = waiting(r, { confidence: 48, conditions: [{ id: 'pivot', text: 'Hold above the level', met: true, detail: '', trigger: false }, { id: 'trigger', text: 'Entry is still close to the level', met: true, detail: '', trigger: true }] });
  const idea = buildIdea(base(r, { setup: su, minConfidence: 55 }));
  assert.equal(idea.kind, 'on_confirmation');
  assert.match(idea.entry!.text, /confidence is 48/);
  assert.equal(idea.execute.via, 'manual'); assert.equal(idea.execute.approved, null);
  assert.match(idea.execute.note, /has not confirmed/);
});

/* ── following an idea on real candles ──────────────────────────────────────────────────────────── */

const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);
const plan = (over: Partial<AtlasIdea> = {}): AtlasIdea => ({
  version: ATLAS_IDEA_VERSION, id: 'x', at: T0, snapshotAt: T0, snapshotId: 1, options: { style: 'auto' },
  kind: 'at_level', source: 'read_plan', side: 'buy', style: 'hold', strategy: 'Pullback into the lean',
  headline: 'BUY the pullback to 4,000.00', badge: 'PLAN', price: 4012,
  entry: { type: 'limit', price: 4002, low: 4000, high: 4002, level: { price: 4000, label: 'london low' }, trigger: null, confirm: 'none', text: '', distancePips: 100 },
  stop: { price: 3994, pips: 80, what: '' },
  targets: [
    { label: 'TP1', price: 4012, pips: 100, r: 1.3, basis: 'level', what: 'a' },
    { label: 'TP2', price: 4020, pips: 180, r: 2.3, basis: 'level', what: 'b' },
  ],
  rr: { first: 1.3, best: 2.3 }, confidence: { score: 40, label: 'Medium', basis: 'not a win probability' },
  reasoning: '', bias: null, poi: null, targeting: null, invalidation: { text: 'A 15-minute close below 4,000.00', price: 4000 },
  confirmations: [], waitingFor: [], engine: { state: 'no_setup', headline: 'NO TRADE', say: '' }, alternative: null, paths: [], warnings: [],
  expiresAt: T0 + 4 * 3600_000,
  execute: { via: 'manual', now: false, note: '', approved: null, manual: { side: 'buy', style: 'hold', stop: 3994, takeProfit: 4012 } },
  watch: { price: 4002, direction: 'below', say: 'Watch 4002.00 and tell me when price reaches it.' }, say: '', ...over,
});
/** Five-minute candles from T0, each [open, high, low, close]. */
const candles = (rows: number[][], from = T0): Bar[] => rows.map(([o, h, l, c], k) => ({ t: from + k * M5, o, h, l, c }));
const at = (n: number) => T0 + n * M5;

test('a level entry: not entered until price reaches the zone, then the first target before the stop is the result', () => {
  const idea = plan();
  const waitingBars = candles([[4012, 4014, 4008, 4010], [4010, 4011, 4004, 4005]]);
  const w = followIdea(idea, { price: 4005, bars: waitingBars, tf: '5m', now: at(2) });
  assert.equal(w.state, 'waiting'); assert.equal(w.entered, null); assert.equal(w.canExecute, false);
  assert.match(w.text, /30 pips away/);

  const inZone = followIdea(idea, { price: 4001.2, bars: waitingBars, tf: '5m', now: at(2) });
  assert.equal(inZone.state, 'in_zone'); assert.equal(inZone.canExecute, true);

  const win = followIdea(idea, { price: 4013, tf: '5m', now: at(5), bars: candles([
    [4012, 4014, 4008, 4010], [4010, 4011, 4001, 4003], [4003, 4008, 4002.5, 4007], [4007, 4012.5, 4006, 4012], [4012, 4014, 4011, 4013],
  ]) });
  assert.equal(win.state, 'tp1'); assert.equal(win.reached, 1); assert.equal(win.pips, 100);
  assert.deepEqual(win.entered, { at: at(1), price: 4002 });
  assert.match(win.basis, /5 closed 5-minute candles/);

  const loss = followIdea(idea, { price: 3990, tf: '5m', now: at(4), bars: candles([
    [4012, 4014, 4008, 4010], [4010, 4011, 4001, 4003], [4003, 4004, 3993, 3995], [3995, 3996, 3989, 3990],
  ]) });
  assert.equal(loss.state, 'stopped'); assert.equal(loss.pips, -80); assert.equal(loss.stopped, true);
});

test('grading is conservative: the forming candle is not read, the entry candle only checks the stop, and the stop wins a tie', () => {
  const idea = plan();
  // A candle that opened BEFORE the idea reached the zone and the target: it is not read at all.
  const before = followIdea(idea, { price: 4010, tf: '5m', now: at(1), bars: [{ t: T0 - M5, o: 4010, h: 4013, l: 4001, c: 4010 }, { t: T0, o: 4010, h: 4011, l: 4008, c: 4010 }] });
  assert.equal(before.state, 'waiting');
  // The entry candle spans the target as well: its high may have come first, so it does not count.
  const sameBar = followIdea(idea, { price: 4006, tf: '5m', now: at(1), bars: candles([[4010, 4013, 4001, 4006]]) });
  assert.equal(sameBar.state, 'open'); assert.equal(sameBar.reached, 0);
  // The entry candle spans the stop: counted, because it cannot be ruled out.
  const entryStop = followIdea(idea, { price: 3996, tf: '5m', now: at(1), bars: candles([[4010, 4011, 3993, 3996]]) });
  assert.equal(entryStop.state, 'stopped');
  // A later candle spans both the stop and the target: the stop counts.
  const tie = followIdea(idea, { price: 4010, tf: '5m', now: at(2), bars: candles([[4010, 4011, 4001, 4003], [4003, 4013, 3993, 4010]]) });
  assert.equal(tie.state, 'stopped'); assert.equal(tie.pips, -80);
  // A candle still forming at `now` is not read either.
  const forming = followIdea(idea, { price: 4005, tf: '5m', now: at(1) + 60_000, bars: candles([[4010, 4011, 4004, 4005], [4005, 4005, 3990, 3991]]) });
  assert.equal(forming.state, 'waiting');
});

test('a break needs a 15-minute candle to CLOSE through the level — a five-minute poke is not an entry', () => {
  const brk = plan({
    kind: 'on_break', headline: 'BUY a 15-minute close above 4,020.00',
    entry: { type: 'stop', price: 4022, low: 4020, high: 4022, level: { price: 4020, label: 'new york high' }, trigger: 'A 15-minute close above 4,020.00', confirm: 'close_15m', text: '', distancePips: 80 },
    stop: { price: 4014, pips: 80, what: '' }, invalidation: { text: 'A 15-minute close below 4,000.00', price: 4000 },
    targets: [{ label: 'TP1', price: 4032, pips: 100, r: 1.3, basis: 'level', what: 'a' }],
  });
  // 12:00, 12:05, 12:10 → the 15-minute candle closes at 12:15 with the 12:10 close.
  const poke = followIdea(brk, { price: 4018, tf: '5m', now: at(3), bars: candles([[4012, 4016, 4011, 4015], [4015, 4023, 4014, 4021], [4021, 4022, 4017, 4018]]) });
  assert.equal(poke.state, 'waiting'); assert.equal(poke.entered, null);
  const closed = followIdea(brk, { price: 4021.5, tf: '5m', now: at(3), bars: candles([[4012, 4016, 4011, 4015], [4015, 4019, 4014, 4018], [4018, 4022, 4017, 4021.5]]) });
  assert.equal(closed.state, 'open'); assert.deepEqual(closed.entered, { at: at(3), price: 4021.5 });
  // A close far beyond the zone is not chased: the entry is the retest.
  const far = followIdea(brk, { price: 4029, tf: '5m', now: at(3), bars: candles([[4012, 4016, 4011, 4015], [4015, 4024, 4014, 4023], [4023, 4030, 4022.5, 4029]]) });
  assert.equal(far.state, 'waiting'); assert.match(far.text, /retest/);
  const retest = followIdea(brk, { price: 4026, tf: '5m', now: at(5), bars: candles([[4012, 4016, 4011, 4015], [4015, 4024, 4014, 4023], [4023, 4030, 4022.5, 4029], [4029, 4030, 4021.5, 4024], [4024, 4027, 4023, 4026]]) });
  assert.equal(retest.state, 'open'); assert.deepEqual(retest.entered, { at: at(3), price: 4022 });
  // A 15-minute close through the invalidation first: the idea is off.
  const dead = followIdea(brk, { price: 3997, tf: '5m', now: at(3), bars: candles([[4012, 4013, 4004, 4005], [4005, 4006, 3999, 4000], [4000, 4001, 3996, 3997]]) });
  assert.equal(dead.state, 'invalidated');
  // The setup engine's own trigger is price trading through it.
  const touch = followIdea({ ...brk, source: 'setup_engine', entry: { ...brk.entry!, price: 4020, low: 4020, high: 4020, confirm: 'touch' } },
    { price: 4021, tf: '5m', now: at(2), bars: candles([[4012, 4016, 4011, 4015], [4015, 4021, 4014, 4020.5]]) });
  assert.deepEqual(touch.entered, { at: at(1), price: 4020 });
});

test('a plan is off the moment the read is no longer its read, and it expires', () => {
  const idea = plan();
  const bars = candles([[4012, 4014, 4008, 4010], [4010, 4011, 4001, 4003], [4003, 4004, 3993, 3995]]);
  const leans = [{ at: T0 - 3600_000, lean: 'bullish_lean' }, { at: at(1) - 60_000, lean: 'balanced' }];
  const off = followIdea(idea, { price: 3995, bars, tf: '5m', now: at(3), leans });
  assert.equal(off.state, 'invalidated'); assert.equal(off.pips, null); assert.match(off.text, /not counted as a trade/);
  // The same candles while the lean held: a real stop.
  assert.equal(followIdea(idea, { price: 3995, bars, tf: '5m', now: at(3), leans: [leans[0]] }).state, 'stopped');
  // The setup engine's own trades are not judged by the read.
  assert.equal(followIdea({ ...idea, source: 'setup_engine' }, { price: 3995, bars, tf: '5m', now: at(3), leans }).state, 'stopped');
  const late = followIdea(idea, { price: 4010, bars: candles([[4012, 4014, 4008, 4010]]), tf: '5m', now: T0 + 5 * 3600_000 });
  assert.equal(late.state, 'expired');
  // Through the stop without ever entering on a closed candle: off.
  assert.equal(followIdea(idea, { price: 3990, bars: [], tf: '5m', now: at(1) }).state, 'invalidated');
});

test('a market idea: still there, gone, and graded from where it was priced', () => {
  const mkt = plan({ kind: 'enter_now', source: 'setup_engine', entry: { type: 'market', price: 4002, low: 4001.5, high: 4002, level: null, trigger: null, confirm: 'none', text: '', distancePips: 0 }, watch: null });
  assert.equal(followIdea(mkt, { price: 4003, bars: [], tf: '5m', now: T0 + 60_000 }).state, 'ready');
  assert.equal(followIdea(mkt, { price: 4003, bars: [], tf: '5m', now: T0 + 60_000 }).canExecute, true);
  // Moved more than 0.6 R from where it was priced (the engine's own drift rule): it is a different trade.
  const gone = followIdea(mkt, { price: 4008, bars: [], tf: '5m', now: T0 + 60_000 });
  assert.equal(gone.state, 'missed'); assert.equal(gone.canExecute, false);
  const won = followIdea(mkt, { price: 4021, tf: '5m', now: at(2), bars: candles([[4002, 4013, 4001, 4012], [4012, 4021, 4011, 4020.5]]) });
  assert.equal(won.state, 'tp2'); assert.equal(won.pips, 180);
  assert.deepEqual(won.entered, { at: T0, price: 4002 });
  assert.equal(followIdea(plan({ kind: 'stand_aside', side: null, entry: null, stop: null, targets: [] }), { price: 4000, bars: [], tf: '5m', now: at(1) }).state, 'none');
});

test('the record counts a target before the stop as a win and never counts a cancelled plan', () => {
  const rec = ideaRecord([
    { state: 'tp1', pips: 88 }, { state: 'tp3', pips: 240 }, { state: 'stopped', pips: -95 },
    { state: 'invalidated', pips: null }, { state: 'expired', pips: null }, { state: 'waiting', pips: null }, { state: 'open', pips: null }, { state: 'none', pips: null },
  ]);
  assert.deepEqual(rec, { graded: 3, wins: 2, losses: 1, pips: 233, open: 2, untriggered: 2 });
});

test('the update says whether ATLAS still agrees with its own plan', () => {
  const idea = plan();
  const f = followIdea(idea, { price: 4008, bars: [], tf: '5m', now: at(1) });
  const read = (lean: AtlasRead['lean'], score: number, strength: AtlasRead['strength']) => ({ lean, score, strength } as AtlasRead);
  assert.match(updateVerdict(idea, f, read('bullish_lean', 44, 'clear'), null), /still agrees: bullish lean, clear \(evidence \+44\)/);
  assert.match(updateVerdict(idea, f, read('balanced', 6, null), null), /no longer this plan's read/);
  const ready = { state: 'trade_ready', side: 'sell', style: 'quick', headline: 'TRADE READY', say: 'I want to SELL gold.' } as BrainSetup;
  assert.match(updateVerdict(idea, f, read('bullish_lean', 44, 'clear'), ready), /now has its own trade ready \(sell\)/);
  const done = followIdea(idea, { price: 3990, bars: [], tf: '5m', now: at(1) });
  assert.equal(updateVerdict(idea, done, read('bullish_lean', 44, 'clear'), null), done.text);
});

test('the replay generates and follows an idea on the recording, and is addressed without storing anything', () => {
  assert.equal(replayEndOf('33'), 33); assert.equal(replayEndOf('9999'), 100); assert.equal(replayEndOf('nope'), 0);
  const idea = replayIdea({ style: 'auto' }, 33);
  assert.equal(idea.id, 'replay:33:auto');
  assert.equal(idea.kind, 'on_break'); assert.equal(idea.side, 'buy');
  const f = replayFollow(idea.id!)!;
  assert.deepEqual(f.idea, idea);
  assert.equal(f.follow.state, 'tp1');
  assert.ok((f.follow.pips ?? 0) > 0);
  assert.equal(replayFollow('replay:x:auto'), null);
  assert.match(ideaText(idea), /^ATLAS · XAUUSD BUY/);
  assert.match(ideaText(replayIdea({ style: 'auto' }, 0)), /no trade right now/);
});

test('the idea engine cannot trade: it never touches the executor, a broker or FLOW/GENX', () => {
  for (const f of ['command-center/engines/idea.ts', 'command-center/engines/ideaDesk.ts', 'command-center/engines/ideaReplay.ts', 'src/app/api/command-center/idea/route.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /from\s+["'][^"']*(executor|callTrade|tradelocker|autopilot|autoManage)["']/, `${f} imports an execution module`);
    assert.doesNotMatch(src, /from\s+["'][^"']*\/(genx|flow)[^"']*["']/, `${f} imports FLOW/GENX`);
    assert.doesNotMatch(src, /\b(prepare|execute|takeSetup|manage)\s*\(/, `${f} calls an execution function`);
  }
  // And nothing that decides, sizes, sends or manages an order reads an idea.
  for (const f of ['executor', 'autopilot', 'autoManage', 'setup', 'broker', 'callTrade', 'validator', 'tradeLive', 'watch', 'profile']) {
    const src = readFileSync(`command-center/engines/${f}.ts`, 'utf8');
    assert.doesNotMatch(src, /from\s+["']\.\/idea(Desk|Replay)?["']/, `${f} imports the idea engine`);
  }
  assert.doesNotMatch(readFileSync('command-center/worker/index.ts', 'utf8'), /engines\/idea/, 'the worker imports the idea engine');
  assert.doesNotMatch(readFileSync('src/app/api/command-center/trade/route.ts', 'utf8'), /engines\/idea/, 'the trade route imports the idea engine');
  // The pure engine has no I/O at all.
  const pure = readFileSync('command-center/engines/idea.ts', 'utf8');
  assert.doesNotMatch(pure, /adapters\/|Date\.now\(\)|fetch\(/);
  // And the watch an idea arms is informational, with its price taken from the stored idea.
  const desk = readFileSync('command-center/engines/ideaDesk.ts', 'utf8');
  assert.match(desk, /authority: "informational"/);
  assert.doesNotMatch(desk, /authority: "action"/);
});
