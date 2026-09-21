import test from 'node:test';
import assert from 'node:assert/strict';
import { narrateTrade } from '../command-center/brain/narrate';
import { gradeTrade, gradeNarrative, type GradeInput } from '../command-center/engines/grade';
import { classify, answer, type SetupView } from '../command-center/brain/language';
import { metrics, character, health, protection, type LivePosition } from '../command-center/brain/trade';
import { replay } from '../command-center/engines/replay';
import { STYLE } from '../command-center/core/style';
import type { BrainMemory } from '../command-center/brain/types';

const M = 60_000;

/* ─────────────────────── narration ─────────────────────── */

/** A real position on real recorded bars, so nothing below is judged against invented prices. */
function livePosition(over: Partial<LivePosition> = {}) {
  const { snapshot, diffs } = replay(40, false, 20);
  const entry = snapshot.price - 6;                        // a long that is comfortably onside
  const p: LivePosition = {
    id: 'p1', side: 'buy', style: 'hold', entry, qty: 1, initQty: 1,
    initStop: entry - 4, curStop: entry - 4, takeProfit: null,
    openedAt: snapshot.at - 30 * M, pipSize: 0.1, pipValuePerLot: 10,
    mfePips: 0, maePips: 0, breakEvenAt: null, partials: [],
    thesis: { invalidationPrice: entry - 4 }, aiManagement: false,
    ...over,
  };
  const m = metrics(p, snapshot.price, snapshot.at);
  const ch = character(p, snapshot, m, diffs);
  const h = health(p, m, ch);
  const prot = protection(p, m, ch, snapshot);
  return { p, m, ch, h, prot, snapshot, now: snapshot.at };
}

test('a milestone is said once and never again', () => {
  const { p, m, ch, h, prot, snapshot, now } = livePosition();
  const first = narrateTrade({ position: p, metrics: m, character: ch, health: h, protection: prot, snapshot, said: new Set(), lastSpokeAt: null, now });
  assert.ok(first.length > 0, 'a trade that is well into profit has something to say');

  const said = new Set(first.map((n) => n.key));
  const second = narrateTrade({ position: p, metrics: m, character: ch, health: h, protection: prot, snapshot, said, lastSpokeAt: now, now: now + M });
  assert.equal(second.length, 0, 'the same state must never produce the same line twice');
});

test('the R ladder only ratchets — falling back does not re-arm a rung', () => {
  const { p, m, ch, h, prot, snapshot, now } = livePosition();
  if ((m.r ?? 0) < 1) return;                              // this fixture is not far enough along to test it
  const said = new Set(['r:1']);
  const notes = narrateTrade({ position: p, metrics: m, character: ch, health: h, protection: prot, snapshot, said, lastSpokeAt: null, now });
  assert.ok(!notes.some((n) => n.key === 'r:1'), '+1R was already announced and must not be announced again');
});

test('at most one line is spoken aloud, and the rest are demoted rather than dropped', () => {
  const { p, m, ch, h, prot, snapshot, now } = livePosition();
  const notes = narrateTrade({ position: p, metrics: m, character: ch, health: h, protection: prot, snapshot, said: new Set(), lastSpokeAt: null, now });
  const voice = notes.filter((n) => n.channel === 'voice');
  assert.ok(voice.length <= 1, `spoke ${voice.length} lines at once — that is noise, and noise gets muted`);
  assert.ok(notes.every((n) => n.text.length > 10), 'every line has to be worth reading');
});

test('nothing is manufactured when nothing has happened', () => {
  const { p, m, ch, h, prot, snapshot, now } = livePosition();
  const all = narrateTrade({ position: p, metrics: m, character: ch, health: h, protection: prot, snapshot, said: new Set(), lastSpokeAt: null, now });
  const said = new Set(all.map((n) => n.key));
  const again = narrateTrade({ position: p, metrics: m, character: ch, health: h, protection: prot, snapshot, said, lastSpokeAt: now, now: now + 30 * M });
  assert.equal(again.length, 0, 'silence is the correct output when there is no news');
});

test('an invalidation interrupts even inside the quiet window', () => {
  const { p, m, h, prot, snapshot, now } = livePosition();
  const invalidated = {
    state: 'invalidated' as const, votes: [], score: 100,
    headline: 'The original thesis is gone.',
    explanation: 'Price has accepted below the level this trade was built on.',
  };
  const notes = narrateTrade({
    position: p, metrics: m, character: invalidated, health: h, protection: prot, snapshot,
    said: new Set(), lastSpokeAt: now - 1000, now,      // spoke one second ago
  });
  const urgent = notes.find((n) => n.key === 'char:invalidated');
  assert.ok(urgent, 'an invalidation must always be raised');
  assert.equal(urgent!.channel, 'urgent', 'and it is allowed to interrupt');
});

/* ─────────────────────── grading ─────────────────────── */

const baseGrade = (over: Partial<GradeInput> = {}): GradeInput => ({
  side: 'buy', style: 'hold', entry: 4380, exit: 4389, pips: 90, r: 1.5,
  mfePips: 100, maePips: -10, riskPips: 60, heldMs: 40 * M,
  partials: [], events: [], openedAt: Date.now() - 40 * M, exitReason: null, continuationPips: null,
  ...over,
});

test('a winner that took nearly the full stop of heat is not called well traded', () => {
  const g = gradeTrade(baseGrade({ maePips: -57, riskPips: 60 }));
  assert.equal(g.verdict, 'good outcome, loose process');
  assert.ok(g.lines.some((l) => l.what === 'Entry' && l.mark === 'poor'));
  assert.match(g.lines.find((l) => l.what === 'Entry')!.note, /not a repeatable entry/i);
});

test('a loss taken at a sensible stop for the right reason is a CORRECT loss', () => {
  const g = gradeTrade(baseGrade({ pips: -60, r: -1, mfePips: 8, maePips: -60, riskPips: 60 }));
  assert.equal(g.verdict, 'correct loss');
  assert.match(g.lines.find((l) => l.what === 'Stop')!.note, /read was wrong, not the placement/i);
});

test('a stop inside the style noise floor is called what it is', () => {
  const pol = STYLE.hold;
  const tight = Math.round(pol.noiseFloorPips * 0.7);
  const g = gradeTrade(baseGrade({ pips: -tight, r: -1, mfePips: 4, maePips: -tight, riskPips: tight }));
  assert.equal(g.lines.find((l) => l.what === 'Stop')!.mark, 'poor');
  assert.match(g.lines.find((l) => l.what === 'Stop')!.note, /noise, not a signal/i);
});

test('capture is the number that decides the exit, and it does not flatter', () => {
  const kept = gradeTrade(baseGrade({ pips: 90, mfePips: 100 }));
  assert.equal(kept.lines.find((l) => l.what === 'Exit')!.mark, 'excellent');
  assert.equal(kept.capture, 0.9);

  const gaveBack = gradeTrade(baseGrade({ pips: 20, mfePips: 160, r: 0.3 }));
  assert.equal(gaveBack.lines.find((l) => l.what === 'Exit')!.mark, 'poor');
  assert.ok(gaveBack.score < kept.score, 'giving the move back has to cost something');
});

test('reaching 1R and never protecting, then losing, is marked as exactly that', () => {
  const g = gradeTrade(baseGrade({ pips: -60, r: -1, mfePips: 120, maePips: -60, riskPips: 60 }));
  const be = g.lines.find((l) => l.what === 'Break even')!;
  assert.equal(be.mark, 'poor');
  assert.match(be.note, /given back for nothing/i);
});

test('sitting through a character change for many bars of the deciding chart is held against the trade', () => {
  // HOLD decides on the 15-minute, so "too long" is measured in 15-minute bars — not in a fraction of a
  // follow-through window, which was the flaw the QUICK/HOLD/SWING rename exposed.
  const openedAt = Date.now() - 300 * M;
  const g = gradeTrade(baseGrade({
    openedAt, heldMs: 300 * M,
    events: [{ at: openedAt + 60 * M, code: 'TRADE_THESIS_WEAKENING' }],
  }));
  const reacting = g.lines.find((l) => l.what === 'Reacting')!;
  assert.equal(reacting.mark, 'poor');
  assert.match(reacting.note, /warning was there/i);

  // The same lag on a QUICK trade, whose deciding chart is the 1-minute, is far worse still.
  const quick = gradeTrade(baseGrade({
    style: 'quick', riskPips: 40, openedAt, heldMs: 300 * M,
    events: [{ at: openedAt + 60 * M, code: 'TRADE_THESIS_WEAKENING' }],
  }));
  assert.equal(quick.lines.find((l) => l.what === 'Reacting')!.mark, 'poor');

  // And a prompt reaction is graded as one, in the horizon's own units.
  const prompt = gradeTrade(baseGrade({
    openedAt, heldMs: 300 * M,
    events: [{ at: openedAt + 270 * M, code: 'TRADE_THESIS_WEAKENING' }],
  }));
  assert.equal(prompt.lines.find((l) => l.what === 'Reacting')!.mark, 'excellent');
});

test('what happened after the exit stays null until it has actually been measured', () => {
  const g = gradeTrade(baseGrade());
  const after = g.lines.find((l) => l.what === 'After the exit')!;
  assert.equal(after.mark, null);
  assert.match(after.note, /not measured yet/i);

  const measured = gradeTrade(baseGrade({ continuationPips: 120 }));
  assert.match(measured.lines.find((l) => l.what === 'After the exit')!.note, /closed early/i);

  const wellTimed = gradeTrade(baseGrade({ continuationPips: -120 }));
  assert.equal(wellTimed.lines.find((l) => l.what === 'After the exit')!.mark, 'excellent');
});

test('the narrative is honest about a loss and never claims a lesson it does not have', () => {
  const loss = baseGrade({ pips: -60, r: -1, mfePips: 8, maePips: -60 });
  const g = gradeTrade(loss);
  const say = gradeNarrative(g, loss);
  assert.match(say, /lost 60 pips/i);
  assert.ok(!/worked/i.test(say.split('.')[0]), 'a loss must not open by saying the trade worked');
});

/* ─────────────────────── asking for a trade ─────────────────────── */

test('asking for a trade is routed to the setup engine, not to a timeframe lecture', () => {
  for (const q of [
    'find me a quick trade',
    'what would you trade right now',
    'do you see a swing?',
    'is there a trade here',
    'got a trade for me',
    'ATLAS, give me a setup',
  ]) {
    assert.equal(classify(q).intent, 'setup', `"${q}" should ask for a trade`);
  }
  // "find me a swing trade" must NOT be swallowed by the older /swing/ matcher.
  assert.equal(classify('find me a swing trade').arg, 'swing');
  assert.equal(classify('find me a quick trade').arg, 'quick');
});

test('the market questions still route where they always did', () => {
  assert.equal(classify('what changed?').intent, 'what_changed');
  assert.equal(classify('why are you bullish').intent, 'why');
  assert.equal(classify('show me the math').intent, 'math');
  assert.equal(classify("how's my trade").intent, 'trade');
  assert.equal(classify('talk to me').intent, 'briefing');
});

test('the answer reports the setup it was given and invents nothing', () => {
  const su: SetupView = {
    state: 'trade_ready', side: 'buy', style: 'hold', stop: 4374.94,
    entryLow: 4385.2, entryHigh: 4385.69,
    initialObjective: 4396.79, extendedObjective: 4399.22,
    stopPips: 107, expectedMovePips: [111, 135], confidence: 80,
    say: 'I want to BUY gold.', headline: 'TRADE READY',
    waitingFor: [], conditions: [{ text: 'Hold above 4377.33', met: true }],
    thesis: 'Momentum continuation.', invalidation: 'A close back below 4377.33.',
  };
  const memory = { now: null, diffs: [], watchedLevels: [], thesis: null, state: null } as unknown as BrainMemory;
  const r = answer('find me a trade', memory, { setup: su });
  assert.match(r.spokenText, /4374\.94/, 'it has to quote the real stop');
  assert.match(r.spokenText, /4396\.79/, 'and the real objective');
  assert.match(r.spokenText, /take it or pass/i, 'and it must not imply it will send anything by itself');
});

test('with no setup available it says so rather than improvising one', () => {
  const memory = { now: null, diffs: [], watchedLevels: [], thesis: null, state: null } as unknown as BrainMemory;
  const r = answer('find me a trade', memory, { setup: null });
  assert.match(r.spokenText, /not going to guess/i);
});

test('asking for a style ATLAS does not have gets the truth, not a substitute', () => {
  const su = {
    state: 'trade_ready', side: 'sell', style: 'swing', stop: 4400, entryLow: 4380, entryHigh: 4380,
    initialObjective: 4340, extendedObjective: 4320, stopPips: 200, expectedMovePips: [400, 600],
    confidence: 70, say: 'I want to SELL gold.', headline: 'TRADE READY', waitingFor: [],
    conditions: [], thesis: null, invalidation: null,
  } as SetupView;
  const memory = { now: null, diffs: [], watchedLevels: [], thesis: null, state: null } as unknown as BrainMemory;
  const r = answer('find me a quick trade', memory, { setup: su });
  assert.match(r.spokenText, /not.*quick|SWING/i, 'it must say the trade it has is a different kind');
});
