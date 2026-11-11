import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replay } from '../command-center/engines/replay';
import {
  EXPLAIN_RULES, NO_EXPLANATION, annId, annotationOfAction, buildExplanation, correctionLine, crossedWatch, explainStep, explainText,
  isTransient, movedSince, nextShownSegment, pricesIn, segmentAt, segmentsOf, spokenPricesIn,
  type Annotation, type ExplainContext, type ExplainState, type Explanation,
} from '../command-center/core/explain';
import { allLevels } from '../command-center/core/levelMap';
import type { AtlasRead, Scenario } from '../command-center/core/atlasContract';
import { explainBus, userDrawings } from '../src/components/command-center/hud/explainBus';
import {
  DUPLICATE_MS, ECHO_WINDOW_MS, EXTENDS_MS, NO_TURN_MEMORY, REPEAT_ASK_MS, TYPED_ECHO_MS, asksTimeframe, asksToShow, isRepeatAsk, judgeUserTurn, looksLikeEcho, spokenCharsEstimate,
  transcriptOf, turnKey, type TurnMemory,
} from '../src/components/command-center/voiceLine';

/*
 * ATLAS EXPLAINS ON THE CHART (owner 11-11).
 *
 * LABELLED REPLAY FIXTURE: every market in this file is the recorded gold session in command-center/fixtures
 * (18 September), stepped through the real engine by engines/replay.ts, or a small hand-built case that says
 * so. Nothing here reaches a network, a provider or a clock other than the one passed in — so nothing here is
 * evidence about the live feed or a real voice call. Those are checked separately and reported as such.
 */

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** The screen's context for one replayed moment — built the way CommandCenterHud builds it. */
function ctxAt(off: number, over: Partial<ExplainContext> = {}): { ctx: ExplainContext; r: ReturnType<typeof replay> } {
  const r = replay(40, false, off);
  const s = r.state;
  const ctx: ExplainContext = {
    levels: (s.levelsAll ?? []).map((l) => ({ kind: l.kind, price: l.price, label: l.label })),
    read: s.read ?? null,
    scenarios: s.scenarios ?? [],
    bars: { '5m': s.bars },
    price: s.price,
    snapshotId: null,
    analysisAt: s.at,
    now: r.endedAt,
    ...over,
  };
  return { ctx, r };
}

/** Every price that is REAL for a context: a level, something the read refers to, a live scenario's levels, a named price. */
function realPrices(ctx: ExplainContext): number[] {
  const out: number[] = ctx.levels.map((l) => l.price);
  const r = ctx.read;
  if (r?.invalidation?.price != null) out.push(r.invalidation.price);
  const refs = [r?.nextWatch?.ref, r?.invalidation?.ref, ...(r?.evidenceFor ?? []).map((e) => e.ref), ...(r?.evidenceAgainst ?? []).map((e) => e.ref)];
  for (const ref of refs) {
    if (!ref) continue;
    if (ref.kind === 'level' || ref.kind === 'swing') out.push(ref.price);
    if (ref.kind === 'zone') out.push(ref.from, ref.to);
  }
  for (const sc of ctx.scenarios) { if (sc.trigger.price != null) out.push(sc.trigger.price); if (sc.invalidation.price != null) out.push(sc.invalidation.price); }
  for (const n of ctx.named ?? []) out.push(n.price);
  return out;
}
const isReal = (p: number, real: number[]) => real.some((x) => Math.abs(x - p) < EXPLAIN_RULES.EXACT);

const play = (ex: Explanation, seq = 1): ExplainState => explainStep(NO_EXPLANATION, { type: 'begin', seq, explanation: ex }, ex.at);
const shownIds = (s: ExplainState) => s.shown.map((x) => x.ann.id);
const activeIds = (s: ExplainState) => s.shown.filter((x) => x.active).map((x) => x.ann.id);

/* The bullish moment of the recording: a clear lean, an invalidation on a confirmed 15-minute swing, resistance above. */
const BULL = ctxAt(21);
const BULL_ANSWER = 'Bullish lean on the 1-hour, clear but not strong. The 15-minute closed above the last lower high at 4,361.67. '
  + 'Next I\'m watching resistance at 4,387.31. If it closes below 4,361.67 on the 15-minute, my view changes.';

/* ── 1. the text ───────────────────────────────────────────────────────────────────────────────────── */

test('an answer is cut into short spoken segments, and a decimal point never ends one', () => {
  const t = explainText('  Gold is 4,371.77 now.\n\nSellers defended 4,392.10!  What next? ');
  assert.equal(t, 'Gold is 4,371.77 now. Sellers defended 4,392.10! What next?');
  const segs = segmentsOf(t);
  assert.deepEqual(segs.map((s) => s.text), ['Gold is 4,371.77 now.', 'Sellers defended 4,392.10!', 'What next?']);
  for (const s of segs) assert.equal(t.slice(s.start, s.end), s.text, 'offsets index into the text');

  const long = `${'The 1-hour still leans down while the 5-minute has turned up and buyers are pressing into the level '.repeat(2)}; so I would wait for the 15-minute to close before reading anything into it.`;
  const fine = segmentsOf(explainText(long));
  assert.ok(fine.length >= 2, 'a long thought is split where it pauses');
  for (const s of fine) assert.ok(s.text.length <= 230);
});

test('numbers are read as gold prices only when they could be one', () => {
  const P = 4380;
  assert.deepEqual(pricesIn('Resistance 4,387.31, support 4361.67, round 4,372 and 4390.', P).map((x) => [x.value, x.exact]), [[4387.31, true], [4361.67, true], [4372, false], [4390, false]]);
  assert.deepEqual(pricesIn('It closed at 14:30 UTC, 25 pips away, RSI 35, 0.38 efficiency, 20 candles, 2026.', P), [], 'times, pips, indicators and years are not prices');
  assert.deepEqual(pricesIn('Bitcoin is 98,000 and the index is 5,900.', P), [], 'a number nowhere near gold is not a gold price');
  const one = pricesIn('Above 4,387.31.', P)[0];
  assert.equal('Above 4,387.31.'.slice(one.at, one.at + one.len), '4,387.31', 'the position is the number itself');
});

test('prices are also read the way ATLAS SAYS them on the voice line', () => {
  const P = 4380;
  const said = (t: string) => spokenPricesIn(t, P).map((x) => [x.value, x.exact, t.slice(x.at, x.at + x.len)]);
  assert.deepEqual(said('Sellers defended forty-three ninety-two ten on the fifteen-minute.'), [[4392.1, true, 'forty-three ninety-two ten']]);
  assert.deepEqual(said('Gold is at forty-three eighty, two pips under it.'), [[4380, false, 'forty-three eighty']], 'a comma ends the number');
  assert.deepEqual(said('Between forty-three seventy-one and forty-three ninety-two.').map((x) => x[0]), [4371, 4392], '"and" between two prices keeps them two');
  assert.deepEqual(said('Support is forty-three seventy-one point seven seven.'), [[4371.77, true, 'forty-three seventy-one point seven seven']]);
  assert.deepEqual(said('It is four thousand three hundred seventy-one point oh five now.').map((x) => x[0]), [4371.05]);
  assert.deepEqual(said('Forty-three seventy-one point seventy-seven held.').map((x) => x[0]), [4371.77]);
  assert.deepEqual(said('The next one is forty-three hundred and five.').map((x) => x[0]), [4305]);
  assert.deepEqual(said('The last three closed five-minute candles made lower highs.'), [], 'counts and timeframes are not prices');
  assert.deepEqual(said('I would wait one or two candles; twenty pips is the stop.'), []);
  assert.deepEqual(spokenPricesIn('forty-three ninety-two', null), [], 'with no price of gold to compare with, nothing is assumed');
});

/* ── 2. what an answer may draw ────────────────────────────────────────────────────────────────────── */

test('an answer about the recorded market becomes a sequence: segments, evidence, annotations cued where they are said', () => {
  const { ctx } = BULL;
  assert.equal(ctx.read?.lean, 'bullish_lean', 'the fixture moment is the bullish one');
  const ex = buildExplanation({ responseId: 'r1', text: BULL_ANSWER, ctx });

  assert.equal(ex.responseId, 'r1');
  assert.equal(ex.analysisAt, ctx.analysisAt, 'it carries the snapshot it was built against');
  assert.equal(ex.at, ctx.now); assert.equal(ex.priceAt, ctx.price);
  assert.equal(ex.expiresAt, ctx.now + EXPLAIN_RULES.TTL_MS, 'and it expires');
  assert.equal(ex.segments.length, 4);

  const byId = new Map(ex.annotations.map((a) => [a.id, a]));
  const inv = byId.get('lv:4361.67');
  assert.ok(inv && inv.kind === 'level' && inv.role === 'invalidation', 'the level the read is wrong beyond');
  const sw = byId.get('sw:15m:1789742700000');
  assert.ok(sw && sw.kind === 'swing' && sw.price === 4361.67 && sw.type === 'high', 'with the confirmed 15-minute swing that made it');
  const res = byId.get('lv:4387.31');
  assert.ok(res && res.kind === 'level' && res.role === 'resistance');
  const dist = byId.get('ds:4387.31');
  assert.ok(dist && dist.kind === 'distance', '"next I\'m watching" measures the distance to it');
  const sc = ex.annotations.find((a) => a.kind === 'scenario');
  assert.ok(sc && sc.kind === 'scenario' && ctx.scenarios.some((s) => s.id === sc.scenarioId && s.trigger.price === 4361.67), 'the conditional path is the REAL scenario with that trigger');

  // Each is cued just before the phrase that names it, in the segment that names it.
  const cue = (id: string) => ex.cues.find((c) => c.id === id)!;
  const at = (needle: string) => ex.text.indexOf(needle);
  assert.equal(cue('lv:4361.67').at, at('4,361.67') - EXPLAIN_RULES.LEAD_CHARS);
  assert.equal(cue('lv:4361.67').segment, 1);
  assert.equal(cue('lv:4387.31').at, at('4,387.31') - EXPLAIN_RULES.LEAD_CHARS);
  assert.equal(cue('lv:4387.31').segment, 2);
  assert.equal(cue(sc.id).segment, 3);
  assert.deepEqual(ex.cues.map((c) => c.at), [...ex.cues.map((c) => c.at)].sort((a, b) => a - b), 'cues are in spoken order');
  assert.equal(new Set(ex.annotations.map((a) => a.id)).size, ex.annotations.length, 'a level said twice is ONE line');
  assert.equal(new Set(ex.cues.map((c) => `${c.id}@${c.segment}`)).size, ex.cues.length, 'cued once per sentence that names it');
  assert.deepEqual(ex.cues.filter((c) => c.id === 'lv:4361.67').map((c) => c.segment), [1, 3], 'named again in the last sentence: it lights again there');

  // What the answer stands on is watched, with the side gold was on when it was said.
  assert.deepEqual(ex.watch.map((w) => [w.price, w.side]).sort(), [[4361.67, 'above'], [4387.31, 'below']]);
});

test('THE MODEL NEVER DRAWS: a price that is not real on the screen draws nothing', () => {
  const { ctx } = BULL;
  const real = realPrices(ctx);
  // Three invented numbers — none within a dollar of anything real — beside one real level.
  const fake = [4366.4, 4377.03, 4393.5];
  for (const f of fake) assert.ok(!real.some((p) => Math.abs(p - f) <= EXPLAIN_RULES.ROUND), `${f} really is invented`);
  const ex = buildExplanation({ responseId: 'r', text: `Sellers hit it at ${fake[0].toFixed(2)} three times. Watch ${fake[1].toFixed(2)} and ${fake[2].toFixed(2)}. Resistance is 4,387.31.`, ctx });
  assert.deepEqual(ex.annotations.filter((a) => a.kind === 'level').map((a) => a.id), ['lv:4387.31']);
  assert.ok(!ex.annotations.some((a) => a.kind === 'zone'), 'no zone between two invented prices');

  // Cents that match nothing are never rounded onto a nearby level.
  const near = buildExplanation({ responseId: 'r', text: 'Resistance is 4,387.90.', ctx });
  assert.ok(!near.annotations.some((a) => a.kind === 'level' && Math.abs(a.price - 4387.9) < 1 && a.id !== 'lv:4387.31' ), 'no line at the invented price');
  assert.ok(!near.annotations.some((a) => a.id === 'lv:4387.90'));

  // A round number resolves only when exactly ONE real price is within a dollar of it.
  const hand: ExplainContext = { levels: [{ kind: 'pdh', price: 4392.1, label: "yesterday's high" }, { kind: 'london_low', price: 4371.6, label: 'london low' }, { kind: 'swing_high', price: 4372.45, label: '1h swing high' }],
    read: null, scenarios: [], bars: {}, price: 4380, snapshotId: 7, analysisAt: 1, now: 1000 };
  const one = buildExplanation({ responseId: 'r', text: 'Sellers defended forty-three ninety-two.', ctx: hand });
  assert.deepEqual(one.annotations.map((a) => a.id), ['lv:4392.10'], 'one real level near the round number');
  const two = buildExplanation({ responseId: 'r', text: 'Support is forty-three seventy-two.', ctx: hand });
  assert.deepEqual(two.annotations.filter((a) => a.kind === 'level'), [], 'two real levels near it: ambiguous, so nothing is drawn');
  assert.equal(one.snapshotId, 7);
});

test('every annotation, over the whole recording, stands on a real price, a real candle or a real scenario', () => {
  const noise = [3.17, 9.4, 14.86, -6.6, -11.23, 21.5];
  let drawn = 0;
  for (let off = 0; off <= 96; off += 6) {
    const { ctx } = ctxAt(off);
    const real = realPrices(ctx);
    const r = ctx.read as AtlasRead;
    const p = ctx.price as number;
    const lv = ctx.levels.slice(0, 4);
    const text = [
      `${r.summary} ${r.htfTrend.text}. ${r.momentum.text}. ${r.nextWatch?.text ?? ''} ${r.invalidation?.text ?? ''}`,
      ...r.evidenceFor.slice(0, 3).map((e) => `${e.text}.`),
      ...lv.map((l) => `The ${l.label} is ${l.price.toFixed(2)}.`),
      // Invented numbers a model might hallucinate, at every distance from price.
      ...noise.map((n) => `Watch ${(p + n).toFixed(2)} closely, and ${(p + n * 2).toFixed(0)} after it.`),
      'Support and resistance both matter right now. If it breaks below support the scenario changes; the last three closed 5-minute candles agree.',
    ].join(' ');
    const ex = buildExplanation({ responseId: `r${off}`, text, ctx });
    const times = new Set((ctx.bars['5m'] ?? []).map((b) => b.t));
    for (const a of ex.annotations) {
      drawn++;
      if (a.kind === 'level' || a.kind === 'distance') assert.ok(isReal(a.price, real), `off ${off}: ${a.id} is not a real price`);
      if (a.kind === 'zone') assert.ok(isReal(a.from, real) && isReal(a.to, real), `off ${off}: ${a.id} is not between two real prices`);
      if (a.kind === 'swing') assert.ok(isReal(a.price, real), `off ${off}: ${a.id}`);
      if (a.kind === 'candle' && a.tf === '5m') assert.ok(times.has(a.t), `off ${off}: ${a.id} is not a candle on hand`);
      if (a.kind === 'candles') assert.ok(times.has(a.from) && times.has(a.to), `off ${off}: ${a.id}`);
      if (a.kind === 'scenario') assert.ok(ctx.scenarios.some((s) => s.id === a.scenarioId && (s.status === 'watching' || s.status === 'developing')), `off ${off}: ${a.id} is not a live scenario`);
      assert.ok(ex.cues.some((c) => c.id === a.id), 'every annotation has its cue');
    }
    for (const c of ex.cues) assert.ok(c.at >= 0 && c.at <= ex.text.length && c.segment >= 0 && c.segment < ex.segments.length);
    for (const w of ex.watch) assert.ok(isReal(w.price, real));
  }
  assert.ok(drawn > 60, `the recording exercised the rule (${drawn} annotations)`);
});

test('words point only at what the read itself names: support, resistance, what would change the view', () => {
  const { ctx } = BULL;
  const ex = buildExplanation({ responseId: 'r', text: 'Buyers are holding above support. Resistance is the next test. A close through the level that would change my view ends it.', ctx });
  const ids = ex.annotations.filter((a) => a.kind === 'level').map((a) => a.id).sort();
  // In a bullish lean the read's support IS its invalidation: one line, not two.
  assert.deepEqual(ids, ['lv:4361.67', 'lv:4387.31']);

  // With no read there is nothing for the words to mean.
  const none = buildExplanation({ responseId: 'r', text: 'Support is holding and resistance is next.', ctx: { ...ctx, read: null, scenarios: [] } });
  assert.deepEqual(none.annotations, []);
});

test('a level named aloud is marked only when exactly one real level has that name', () => {
  const { ctx } = BULL;
  const ex = buildExplanation({ responseId: 'r', text: 'Price is back above the London low, and yesterday’s high is below us.', ctx });
  const ids = ex.annotations.map((a) => a.id);
  assert.ok(ids.includes('lv:4371.77'), 'the London low');
  assert.ok(ids.includes('lv:4360.91'), "yesterday's high (a curly apostrophe is still the same name)");
  const two = buildExplanation({ responseId: 'r', text: 'Back above the London low.', ctx: { ...ctx, levels: [...ctx.levels, { kind: 'london_low', price: 4350, label: 'london low' }] } });
  assert.ok(!two.annotations.some((a) => a.id === 'lv:4371.77' || a.id === 'lv:4350.00'), 'two levels with that name: not drawn');
});

test('candles: one named by its close time, the last few closed ones, the forming one — never an invented candle', () => {
  const { ctx } = BULL;
  const bars = ctx.bars['5m']!;
  const M5 = 300_000;
  // The context's clock is inside the newest candle: it is still forming.
  const forming = bars[bars.length - 1];
  const live: ExplainContext = { ...ctx, now: forming.t + 120_000 };
  const closedBar = bars[bars.length - 4];
  const hhmm = new Date(closedBar.t + M5).toISOString().slice(11, 16);

  const ex = buildExplanation({ responseId: 'r', text: `The 5-minute candle that closed at ${hhmm} UTC rejected the high. The last three closed 5-minute candles made lower highs. The candle that is forming has not confirmed anything.`, ctx: live });
  const cd = ex.annotations.find((a) => a.kind === 'candle');
  assert.ok(cd && cd.kind === 'candle' && cd.tf === '5m' && cd.t === closedBar.t, 'the candle whose CLOSE is that time');
  const run = ex.annotations.find((a) => a.kind === 'candles');
  assert.ok(run && run.kind === 'candles', 'the run');
  const closed = bars.filter((b) => b.t + M5 <= live.now);
  assert.equal(run.to, closed[closed.length - 1].t, 'ends at the last CLOSED candle');
  assert.equal(run.from, closed[closed.length - 3].t);
  assert.notEqual(run.to, forming.t, 'the forming candle is not one of the closed ones');
  assert.ok(ex.annotations.some((a) => a.kind === 'current'), 'the forming candle is marked as the current one');

  const none = buildExplanation({ responseId: 'r', text: 'The 5-minute candle that closed at 03:07 UTC was the turn. The 15-minute candle that closed at 14:30 UTC too.', ctx: live });
  assert.deepEqual(none.annotations.filter((a) => a.kind === 'candle'), [], 'no candle closed at 03:07, and there are no 15-minute candles on hand');
});

test('a range between two real prices is a zone; a conditional path is only ever a real scenario', () => {
  const { ctx } = BULL;
  const ex = buildExplanation({ responseId: 'r', text: 'Price is rotating between 4,361.67 and 4,387.31.', ctx });
  const z = ex.annotations.find((a) => a.kind === 'zone');
  assert.ok(z && z.kind === 'zone' && z.from === 4361.67 && z.to === 4387.31 && z.id === 'zn:4361.67:4387.31');

  const base = buildExplanation({ responseId: 'r', text: 'The base case is continuation higher.', ctx });
  const sc = base.annotations.find((a) => a.kind === 'scenario');
  assert.ok(sc && sc.kind === 'scenario');
  assert.equal(ctx.scenarios.find((s) => s.id === sc.scenarioId)?.role, 'base');

  // No live scenario → no path, however the answer is worded.
  const dead: Scenario[] = ctx.scenarios.map((s) => ({ ...s, status: 'invalidated' as const }));
  const none = buildExplanation({ responseId: 'r', text: 'The base case is continuation higher. If it breaks above resistance the scenario plays out.', ctx: { ...ctx, scenarios: dead } });
  assert.ok(!none.annotations.some((a) => a.kind === 'scenario'), 'an invalidated scenario is never drawn as if it stood');
});

test("the server's validated chart actions ride along, as the same stable annotations", () => {
  const { ctx } = BULL;
  const lv = ctx.levels.find((l) => l.kind === 'pdh')!;
  const a = annotationOfAction({ type: 'highlight_level', levelId: `pdh@${lv.price.toFixed(2)}`, price: lv.price, label: "yesterday's high 4,360.91" });
  assert.deepEqual(a, { id: annId.level(lv.price), kind: 'level', price: lv.price, label: "Yesterday's high", levelId: `pdh@${lv.price.toFixed(2)}`, role: 'level' });
  assert.equal(annotationOfAction({ type: 'timeframe', tf: '15m' }), null, 'a timeframe switch is not a drawing');
  assert.equal(annotationOfAction({ type: 'clear' }), null);

  const ex = buildExplanation({ responseId: 'r', text: 'Buyers reclaimed it.', ctx, actions: [
    { type: 'highlight_level', levelId: `pdh@${lv.price.toFixed(2)}`, price: lv.price, label: "yesterday's high" },
    { type: 'show_zone', from: 4361.67, to: 4371.77, label: 'the pocket' },
  ] });
  assert.deepEqual(ex.annotations.map((x) => x.id), [annId.level(lv.price), 'zn:4361.67:4371.77']);
  assert.equal(ex.segments[0].annotations.length, 2, 'attached to the answer');
});

/* ── 3. playing it ─────────────────────────────────────────────────────────────────────────────────── */

test('annotations appear as their phrase is reached, are emphasised while it is spoken, then rest', () => {
  const ex = buildExplanation({ responseId: 'r1', text: BULL_ANSWER, ctx: BULL.ctx });
  let s = play(ex);
  assert.equal(s.status, 'explaining');
  assert.deepEqual(s.shown, [], 'nothing is drawn before it is said');

  const at = (needle: string) => ex.text.indexOf(needle);
  s = explainStep(s, { type: 'progress', responseId: 'r1', chars: 20 }, ex.at + 1000);
  assert.equal(s.segment, 0);
  assert.deepEqual(s.shown, [], 'the first sentence names no level');

  s = explainStep(s, { type: 'progress', responseId: 'r1', chars: at('4,361.67') }, ex.at + 3000);
  assert.equal(s.segment, 1);
  assert.deepEqual(activeIds(s).sort(), ['lv:4361.67', 'sw:15m:1789742700000'], 'the level and its swing light up on the phrase');

  s = explainStep(s, { type: 'progress', responseId: 'r1', chars: at('4,387.31') }, ex.at + 6000);
  assert.equal(s.segment, 2);
  assert.ok(activeIds(s).includes('lv:4387.31') && activeIds(s).includes('ds:4387.31'));
  assert.ok(shownIds(s).includes('lv:4361.67') && !activeIds(s).includes('lv:4361.67'), 'the earlier evidence stays, at rest');

  // Progress never runs backwards (a late event from the audio clock changes nothing).
  const back = explainStep(s, { type: 'progress', responseId: 'r1', chars: 10 }, ex.at + 6100);
  assert.equal(back, s);

  // The last sentence names 4,361.67 again: the same line is emphasised again when that phrase is reached.
  const again = ex.text.lastIndexOf('4,361.67');
  s = explainStep(s, { type: 'progress', responseId: 'r1', chars: again - 10 }, ex.at + 9000);
  assert.equal(s.segment, 3);
  assert.ok(!activeIds(s).includes('lv:4361.67'), 'not before the phrase');
  s = explainStep(s, { type: 'progress', responseId: 'r1', chars: again }, ex.at + 10000);
  assert.ok(activeIds(s).includes('lv:4361.67') && !activeIds(s).includes('lv:4387.31'));
  assert.equal(s.shown.filter((x) => x.ann.id === 'lv:4361.67').length, 1);

  s = explainStep(s, { type: 'end', responseId: 'r1' }, ex.at + 12000);
  assert.equal(s.status, 'done');
  assert.deepEqual(activeIds(s), [], 'when it has been said, everything rests');
  assert.equal(shownIds(s).length, ex.annotations.length, 'and everything it referred to is on the chart');
  assert.equal(segmentAt(ex, 0), 0); assert.equal(segmentAt(ex, ex.text.length), 3);
});

test('an interruption cancels what was still to come and removes the abandoned scenario path; evidence stays', () => {
  const ex = buildExplanation({ responseId: 'r1', text: BULL_ANSWER, ctx: BULL.ctx });
  const all = explainStep(play(ex), { type: 'progress', responseId: 'r1', chars: ex.text.length }, ex.at + 1);
  assert.ok(all.shown.some((x) => x.ann.kind === 'scenario') && all.shown.some((x) => x.ann.kind === 'distance'));

  const cut = explainStep(all, { type: 'cancel', responseId: 'r1' }, ex.at + 2);
  assert.equal(cut.status, 'cancelled');
  assert.ok(!cut.shown.some((x) => isTransient(x.ann)), 'the conditional path, the distance read-out and the current-candle marker go');
  assert.ok(shownIds(cut).includes('lv:4361.67') && shownIds(cut).includes('lv:4387.31'), 'real evidence already shown stays');
  assert.deepEqual(activeIds(cut), []);

  // Interrupted early: what had not been said yet never appears.
  const early = explainStep(explainStep(play(ex), { type: 'progress', responseId: 'r1', chars: ex.text.indexOf('4,361.67') }, 1), { type: 'cancel', responseId: 'r1' }, 2);
  assert.ok(!shownIds(early).includes('lv:4387.31'));
  const late = explainStep(early, { type: 'progress', responseId: 'r1', chars: ex.text.length }, 3);
  assert.equal(late, early, 'audio still arriving from a cancelled answer draws nothing');
  assert.equal(explainStep(early, { type: 'end', responseId: 'r1' }, 4), early);
});

test('an older response can never overwrite a newer one', () => {
  const { ctx } = BULL;
  const older = buildExplanation({ responseId: 'old', text: 'Resistance is 4,387.31.', ctx });
  const newer = buildExplanation({ responseId: 'new', text: 'The London low is 4,371.77.', ctx });
  let s = play(newer, 5);
  s = explainStep(s, { type: 'progress', responseId: 'new', chars: 99 }, 1);
  const before = s;
  s = explainStep(s, { type: 'begin', seq: 4, explanation: older }, 2);
  assert.equal(s, before, 'a response that started earlier arrives late: ignored');
  s = explainStep(s, { type: 'progress', responseId: 'old', chars: 99 }, 3);
  s = explainStep(s, { type: 'end', responseId: 'old' }, 4);
  s = explainStep(s, { type: 'cancel', responseId: 'old' }, 5);
  s = explainStep(s, { type: 'correct', responseId: 'old', text: 'x' }, 6);
  assert.equal(s, before, 'and none of its events touch the chart');
  assert.deepEqual(shownIds(s), ['lv:4371.77']);
});

test('a new answer keeps the evidence that is still on the chart and drops the last answer\'s scenario', () => {
  const { ctx } = BULL;
  const first = buildExplanation({ responseId: 'a', text: BULL_ANSWER, ctx });
  let s = explainStep(explainStep(play(first, 1), { type: 'progress', responseId: 'a', chars: first.text.length }, 1), { type: 'end', responseId: 'a' }, 2);
  assert.ok(s.shown.some((x) => x.ann.kind === 'scenario'));
  const second = buildExplanation({ responseId: 'b', text: 'Resistance at 4,387.31 is still the level.', ctx });
  s = explainStep(s, { type: 'begin', seq: 2, explanation: second }, 3);
  assert.ok(!s.shown.some((x) => isTransient(x.ann)), 'the abandoned scenario path is not left standing');
  assert.ok(shownIds(s).includes('lv:4361.67'), 'useful evidence stays visible');
  s = explainStep(s, { type: 'progress', responseId: 'b', chars: second.text.length }, 4);
  assert.equal(s.shown.filter((x) => x.ann.id === 'lv:4387.31').length, 1, 'the same level is one line, updated — not two');
  assert.deepEqual(activeIds(s), ['lv:4387.31']);
  assert.equal(s.shown.find((x) => x.ann.id === 'lv:4387.31')!.responseId, 'b');
});

test('more of the same spoken answer arriving updates it in place — nothing replays, nothing flickers', () => {
  const { ctx } = BULL;
  const partial = buildExplanation({ responseId: 'v', text: 'Bullish lean on the 1-hour. The 15-minute closed above 4,361.67.', ctx });
  let s = explainStep(play(partial), { type: 'progress', responseId: 'v', chars: partial.text.length }, 1);
  const shownBefore = shownIds(s).sort();
  const full = buildExplanation({ responseId: 'v', text: BULL_ANSWER.replace('the last lower high at ', ''), ctx: { ...ctx, now: ctx.now + 900, price: (ctx.price as number) + 0.4 } });
  const u = explainStep(s, { type: 'update', responseId: 'v', explanation: full }, 2);
  assert.equal(u.status, 'explaining');
  assert.equal(u.chars, s.chars, 'what has been spoken is unchanged');
  assert.deepEqual(shownIds(u).sort(), shownBefore, 'nothing already on the chart moved');
  assert.equal(u.explanation!.at, partial.at, 'the briefing keeps the moment it started');
  assert.equal(u.explanation!.priceAt, partial.priceAt);
  assert.equal(u.explanation!.segments.length, 4);
  s = explainStep(u, { type: 'progress', responseId: 'v', chars: full.text.length }, 3);
  assert.ok(shownIds(s).includes('lv:4387.31'), 'the rest of the answer plays on from where it was');
  // An update for another response, or after it was stopped, is ignored.
  assert.equal(explainStep(u, { type: 'update', responseId: 'other', explanation: full }, 4), u);
  const stopped = explainStep(u, { type: 'cancel', responseId: 'v' }, 5);
  assert.equal(explainStep(stopped, { type: 'update', responseId: 'v', explanation: full }, 6), stopped);
});

test('"Show me" steps through what the last answer pointed at; clearing removes ATLAS\'s drawings', () => {
  const ex = buildExplanation({ responseId: 'r1', text: BULL_ANSWER, ctx: BULL.ctx });
  let s = explainStep(play(ex), { type: 'end', responseId: 'r1' }, 1);
  assert.equal(nextShownSegment(ex, -1), 1, 'the first sentence that points at something');
  s = explainStep(s, { type: 'show', segment: 1 }, 2);
  assert.equal(s.status, 'showing');
  assert.deepEqual(activeIds(s).sort(), ['lv:4361.67', 'sw:15m:1789742700000']);
  s = explainStep(s, { type: 'show', segment: nextShownSegment(ex, 1) }, 3);
  assert.equal(s.segment, 2);
  assert.ok(activeIds(s).includes('lv:4387.31') && !activeIds(s).includes('lv:4361.67'));
  s = explainStep(s, { type: 'show', segment: nextShownSegment(ex, 2) }, 3);
  assert.equal(s.segment, 3);
  assert.ok(activeIds(s).includes('lv:4361.67') && activeIds(s).some((id) => id.startsWith('sc:')), 'the conditional sentence: its level and its scenario');
  assert.equal(nextShownSegment(ex, 3), 1, 'and round again');
  assert.equal(nextShownSegment(buildExplanation({ responseId: 'x', text: 'Nothing to point at.', ctx: BULL.ctx }), -1), -1);

  const rested = explainStep(s, { type: 'rest' }, 4);
  assert.equal(rested.status, 'done'); assert.deepEqual(activeIds(rested), []); assert.equal(rested.shown.length, s.shown.length);

  const one = explainStep(rested, { type: 'remove', id: 'lv:4387.31' }, 5);
  assert.ok(!shownIds(one).includes('lv:4387.31') && shownIds(one).includes('lv:4361.67'), 'fade or remove one by its ID');
  const focused = explainStep(one, { type: 'focus', id: 'lv:4361.67' }, 6);
  assert.deepEqual(activeIds(focused), ['lv:4361.67']);

  const cleared = explainStep(focused, { type: 'clear' }, 7);
  assert.deepEqual(cleared.shown, []); assert.equal(cleared.status, 'idle');
  assert.equal(cleared.seq, focused.seq, 'the sequence survives a clear, so a late old answer still cannot draw');

  // A live explanation is never stepped over by "Show me".
  const live = play(ex, 9);
  assert.equal(explainStep(live, { type: 'show', segment: 1 }, 8), live);
});

test('evidence at rest does not stay for ever, and the chart never fills up', () => {
  const { ctx } = BULL;
  const ex = buildExplanation({ responseId: 'r1', text: BULL_ANSWER, ctx });
  let s = explainStep(explainStep(play(ex), { type: 'progress', responseId: 'r1', chars: ex.text.length }, 1000), { type: 'end', responseId: 'r1' }, 2000);
  assert.equal(explainStep(s, { type: 'prune' }, 2000 + EXPLAIN_RULES.REST_TTL_MS - 5000), s, 'still inside its time');
  const pruned = explainStep(s, { type: 'prune' }, 2000 + EXPLAIN_RULES.REST_TTL_MS + 5000);
  assert.deepEqual(pruned.shown, []);

  // Many levels in one answer: at rest, only the newest few remain.
  const many = ctx.levels.slice(0, 12).map((l) => `The ${l.label} is ${l.price.toFixed(2)}.`).join(' ');
  const big = buildExplanation({ responseId: 'big', text: many, ctx });
  assert.ok(big.annotations.length > EXPLAIN_RULES.MAX_REST);
  s = explainStep(explainStep(NO_EXPLANATION, { type: 'begin', seq: 1, explanation: big }, 1), { type: 'end', responseId: 'big' }, 2);
  assert.equal(s.shown.length, EXPLAIN_RULES.MAX_REST);
});

/* ── 4. when the market overtakes the answer ───────────────────────────────────────────────────────── */

test('a price crossing a discussed level is detected deterministically, once, and corrected in one line', () => {
  const { ctx } = BULL;
  const ex = buildExplanation({ responseId: 'r1', text: BULL_ANSWER, ctx });
  const now = ex.at + 5000;
  assert.equal(crossedWatch(ex, ctx.price, now), null, 'nothing has been crossed at the price it was said');
  assert.equal(crossedWatch(ex, 4361.67 - EXPLAIN_RULES.CROSS + 0.01, now), null, 'sitting on the level is not through it');
  assert.equal(crossedWatch(ex, 4387.31 + EXPLAIN_RULES.CROSS - 0.01, now), null);
  const down = crossedWatch(ex, 4361.2, now);
  assert.deepEqual(down && [down.price, down.side], [4361.67, 'above']);
  const up = crossedWatch(ex, 4387.9, now);
  assert.deepEqual(up && [up.price, up.side], [4387.31, 'below']);
  assert.equal(crossedWatch(ex, 4361.2, ex.expiresAt + 1), null, 'an expired explanation corrects nothing');
  assert.equal(crossedWatch(ex, Number.NaN, now), null); assert.equal(crossedWatch(null, 4361.2, now), null);

  const line = correctionLine(down!, 4361.2);
  assert.equal(line, 'Correction: gold has just traded below 4,361.67 (read invalidation). It is 4,361.20 now, so what I said about that level no longer stands.');
  assert.ok(line.length < 200, 'concise');
  assert.match(correctionLine(up!, 4387.9), /traded above 4,387\.31/);

  // On the chart: the obsolete conditional path goes, the correction is shown, and it is said only once.
  let s = explainStep(play(ex), { type: 'progress', responseId: 'r1', chars: ex.text.length }, now);
  s = explainStep(s, { type: 'correct', responseId: 'r1', text: line }, now);
  assert.equal(s.status, 'corrected'); assert.equal(s.correction, line);
  assert.ok(!s.shown.some((x) => isTransient(x.ann)));
  assert.deepEqual(s.explanation!.watch, [], 'a corrected answer watches nothing further');
  assert.equal(crossedWatch(s.explanation, 4361.2, now), null);
  assert.equal(explainStep(s, { type: 'correct', responseId: 'r1', text: 'again' }, now + 1), s);
  assert.equal(explainStep(s, { type: 'progress', responseId: 'r1', chars: 9999 }, now + 2), s, 'queued segments of the obsolete answer draw nothing');

  assert.equal(movedSince(ex, (ctx.price as number) + 1.2), 12, 'how far gold has moved since the briefing, in pips');
  assert.equal(movedSince(ex, null), null);
});

test('the desk\'s store: typed answers point at their first evidence, corrections fire once, and the member\'s lines are never ATLAS\'s to clear', () => {
  explainBus.reset();
  assert.equal(explainBus.begin('chat-1', BULL_ANSWER, { typed: true }), null, 'no screen context: nothing is explained (the classic console applies the validated actions itself)');

  const { ctx } = BULL;
  explainBus.setContext(ctx);
  const said: [string, boolean][] = [];
  const off = explainBus.onCorrection((text, during) => said.push([text, during]));

  const ex = explainBus.begin('chat-1', BULL_ANSWER, { typed: true })!;
  let s = explainBus.get();
  assert.equal(s.status, 'showing', 'a typed answer has no audio to follow: it points at the first thing it refers to');
  assert.equal(s.segment, 1);
  assert.equal(s.shown.length, ex.annotations.length, 'with the rest of its evidence on the chart at rest');
  assert.ok(explainBus.showNext()); assert.equal(explainBus.get().segment, 2);

  // The member draws their own line; ATLAS's clear never touches it.
  userDrawings.clear();
  userDrawings.add(4375.555);
  userDrawings.add(4375.555);
  assert.deepEqual(userDrawings.get().map((l) => l.price), [4375.56], 'one line per price');
  explainBus.clear();
  assert.deepEqual(explainBus.get().shown, []);
  assert.equal(userDrawings.get().length, 1, '"Clear Atlas drawings" leaves the member\'s line');
  userDrawings.clear();
  assert.equal(userDrawings.get().length, 0);

  // A spoken answer, overtaken by the market while it is being said.
  explainBus.begin('voice-7', BULL_ANSWER);
  explainBus.progress('voice-7', 60);
  assert.equal(explainBus.onPrice(ctx.price), null);
  const line = explainBus.onPrice(4361.1);
  assert.match(line ?? '', /^Correction: gold has just traded below 4,361\.67/);
  assert.equal(explainBus.onPrice(4360.9), null, 'said once');
  assert.deepEqual(said.map((x) => x[1]), [true], 'the voice line is told it happened DURING playback');
  assert.equal(explainBus.get().status, 'corrected');
  explainBus.rest();
  assert.equal(explainBus.get().status, 'done');
  assert.equal(explainBus.onPrice(4360.5), null, 'dismissing the caption does not bring the correction back');

  /* REVALIDATED BEFORE IT IS SHOWN: the typed answer was built on 4,362.40 (above the level). By the time it
     arrives the screen's live price is the fixture's 4,383.71 — still above, so nothing is corrected … */
  explainBus.begin('chat-2', BULL_ANSWER, { typed: true, priceAt: 4362.4 });
  assert.equal(explainBus.get().status, 'showing');
  assert.equal(explainBus.get().explanation?.priceAt, 4362.4, 'the briefing is stamped with the price it was built from');
  assert.equal(said.length, 1);
  // … but an answer built while gold was still BELOW resistance, arriving after it has traded through, is corrected at once.
  explainBus.setContext({ ...ctx, price: 4388.2 });
  explainBus.begin('chat-3', BULL_ANSWER, { typed: true, priceAt: 4383.71 });
  assert.equal(explainBus.get().status, 'corrected');
  assert.match(explainBus.get().correction ?? '', /traded above 4,387\.31/);
  assert.deepEqual(said.map((x) => x[1]), [true, false], 'not during playback: shown on the chart, not spoken');
  explainBus.setContext(ctx);

  /* "EXPLAIN THIS CANDLE": the candle the member tapped is marked from the answer's first word, whatever words
     the answer uses — and only for the answer to that question. */
  const tapped = ctx.bars['5m']![ctx.bars['5m']!.length - 6];
  const tappedAnn = { id: annId.candle('5m', tapped.t), kind: 'candle' as const, tf: '5m' as const, t: tapped.t, label: '5-minute candle' };
  explainBus.pointNextAt([tappedAnn]);
  explainBus.begin('voice-c', 'It was a rejection.');
  explainBus.progress('voice-c', 1);
  assert.deepEqual(explainBus.get().shown.filter((x) => x.active).map((x) => x.ann.id), [tappedAnn.id], 'marked as the answer starts (earlier evidence rests)');
  assert.ok(explainBus.update('voice-c', 'It was a rejection. Sellers stepped in.'));
  assert.ok(explainBus.get().shown.some((x) => x.ann.id === tappedAnn.id), 'more of the answer arriving keeps it');
  explainBus.end('voice-c');
  explainBus.begin('voice-d', 'Nothing else to add.');
  explainBus.end('voice-d');
  assert.equal(explainBus.get().explanation?.annotations.length, 0, 'the next answer does not inherit it');

  // A late event from the older voice reply cannot touch a newer answer.
  explainBus.begin('voice-8', 'Resistance is 4,387.31.');
  explainBus.progress('voice-7', 9999); explainBus.end('voice-7'); explainBus.cancel('voice-7');
  assert.equal(explainBus.get().explanation?.responseId, 'voice-8');
  assert.equal(explainBus.get().status, 'explaining');
  // More of the same reply arriving completes it in place.
  explainBus.progress('voice-8', 23);
  assert.ok(explainBus.update('voice-8', 'Resistance is 4,387.31. The London low is 4,371.77.'));
  assert.equal(explainBus.get().explanation?.segments.length, 2);
  assert.equal(explainBus.get().chars, 23);
  assert.ok(!explainBus.update('voice-7', 'x'), 'never for another reply');
  explainBus.cancelCurrent();
  assert.equal(explainBus.get().status, 'cancelled');
  off();
  explainBus.reset();
});

/* ── 5. one spoken question, one turn ──────────────────────────────────────────────────────────────── */

test('one question produces one turn: typed echoes, repeated finals and longer re-finals are not new questions', () => {
  const t0 = 1_000_000;
  const typed: TurnMemory = { typed: { key: turnKey('What changes your view?'), at: t0 }, heard: null };
  assert.equal(judgeUserTurn('what changes your view', typed, t0 + 800, null), 'typed_echo', 'the provider echoing a typed turn back');
  assert.equal(judgeUserTurn('What changes your view?', typed, t0 + TYPED_ECHO_MS + 1, null), 'new', 'much later it is a new question');

  const heard: TurnMemory = { typed: null, heard: { key: turnKey("What's gold doing?"), at: t0 } };
  assert.equal(judgeUserTurn("What's gold doing", heard, t0 + 1200, null), 'duplicate', 'the same final delivered twice');
  assert.equal(judgeUserTurn("What's gold doing?", heard, t0 + DUPLICATE_MS + 1, null), 'new', 'asking again later is allowed');
  assert.equal(judgeUserTurn("What's gold doing right now", heard, t0 + 900, null), 'extends', 'the same utterance, a few words longer');
  assert.equal(judgeUserTurn("What's gold doing right now", heard, t0 + EXTENDS_MS + 1, null), 'new');
  assert.equal(judgeUserTurn('Where is the stop?', heard, t0 + 900, null), 'new');
  assert.equal(judgeUserTurn('   ', NO_TURN_MEMORY, t0, null), 'duplicate', 'nothing was said');
  assert.equal(turnKey('  What’s GOLD   doing?! '), 'what s gold doing');
});

test('the typed console de-duplicates a request: the same words twice in a moment are asked once', () => {
  const t0 = 9_000_000;
  const last = { key: turnKey("What's your read right now?"), at: t0 };
  assert.ok(isRepeatAsk("What's your read right now?", last, t0 + 120), 'a double Enter or a double tap');
  assert.ok(isRepeatAsk('whats your read right now', { key: turnKey('whats your read right now'), at: t0 }, t0 + 900), 'a recogniser that ends twice');
  assert.ok(!isRepeatAsk("What's your read right now?", last, t0 + REPEAT_ASK_MS), 'asking again later is the member\'s choice');
  assert.ok(!isRepeatAsk('And the key levels?', last, t0 + 120), 'a different question');
  assert.ok(!isRepeatAsk("What's your read right now?", null, t0), 'the first question');
  assert.ok(!isRepeatAsk('  ', { key: '', at: t0 }, t0 + 1));
  const consoleSrc = src('src/components/command-center/BrainConsole.tsx');
  assert.match(consoleSrc, /if \(!opts\.auto && isRepeatAsk\(q, lastAskRef\.current, askedAt\)\) return;/, 'checked before the turn is added or the request sent');
  assert.ok(consoleSrc.indexOf('isRepeatAsk(q, lastAskRef.current') < consoleSrc.indexOf('setTurns((t) => [...t, { role: "user"'), 'so a repeat adds no second user turn');
  assert.match(consoleSrc, /const t = transcriptOf\(e\.results\);/, 'and the recogniser\'s results are rebuilt, never added up');
});

test("ATLAS's own voice coming back through the microphone is not a question", () => {
  const atlas = 'Bullish lean on the one-hour. Sellers defended forty-three ninety-two ten and buyers are holding above the London low.';
  assert.ok(looksLikeEcho('sellers defended forty-three ninety-two ten and buyers', atlas));
  assert.ok(looksLikeEcho('Buyers are holding above the London low', atlas));
  assert.ok(!looksLikeEcho('the London low?', atlas), 'a member repeating a short phrase back is a question');
  assert.ok(!looksLikeEcho('why are buyers holding there and what would change it', atlas), 'different words');
  assert.ok(!looksLikeEcho('sellers defended forty-three', 'short'), 'nothing recent to compare with');

  const t0 = 5_000_000;
  const said = { text: atlas, at: t0 };
  assert.equal(judgeUserTurn('sellers defended forty-three ninety-two ten and buyers are holding', NO_TURN_MEMORY, t0 + 2000, said), 'atlas_echo');
  assert.equal(judgeUserTurn('sellers defended forty-three ninety-two ten and buyers are holding', NO_TURN_MEMORY, t0 + ECHO_WINDOW_MS + 1, said), 'new', 'only while ATLAS has just been speaking');
  assert.equal(judgeUserTurn('what would change your view', NO_TURN_MEMORY, t0 + 2000, said), 'new');
});

test('"show me that" is recognised as a request to point at the last evidence — and a real question is not', () => {
  for (const yes of ['Show me.', 'show me that', 'Show me that again', 'ATLAS, show me on the chart', 'Can you show me where?', 'point to that', 'Where is that?', "where's it on the chart", 'Show me what you mean', 'show me that please']) {
    assert.ok(asksToShow(yes), yes);
  }
  for (const no of ['Show me the scenarios', 'show me why gold is falling', 'Where is support?', 'What changes your view?', 'show me the key levels above price', '', 'Where is that level you mentioned yesterday relative to the daily open']) {
    assert.ok(!asksToShow(no), no);
  }
});

test('a timeframe is switched only on the member\'s own explicit instruction', () => {
  assert.equal(asksTimeframe('Switch to the fifteen-minute.'), '15m');
  assert.equal(asksTimeframe('ATLAS, go to the 5 minute chart'), '5m');
  assert.equal(asksTimeframe('show me the one hour'), '1h');
  assert.equal(asksTimeframe('Pull up the 4-hour chart please'), '4h');
  assert.equal(asksTimeframe('switch to the daily'), '1d');
  assert.equal(asksTimeframe('zoom in to the five minute'), '5m');
  for (const no of ['What does the 15-minute say?', 'Is the one hour still bullish', 'show me the fifteen-minute swing high', 'switch to the 3 minute', 'go to the thirty minute chart', 'show me', '']) {
    assert.equal(asksTimeframe(no), null, no);
  }
  const voice = src('src/components/command-center/VoiceSession.tsx');
  assert.match(voice, /const wantTf = asksTimeframe\(text\);/, 'read from the member\'s transcript');
  assert.ok(!/asksTimeframe\((?!text\))/.test(voice), 'never from what ATLAS said');
});

test("the browser's speech recognition is read once: re-delivered finals do not double the question", () => {
  const res = (...xs: [string, boolean][]) => xs.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } }));
  // Chrome on Android: each final is the whole utterance so far.
  assert.deepEqual(transcriptOf(res(['what is gold', true], ['what is gold doing', true], ['what is gold doing right now', true])), { final: 'what is gold doing right now', interim: '' });
  // The same final twice.
  assert.deepEqual(transcriptOf(res(['what is gold doing', true], ['what is gold doing', true])), { final: 'what is gold doing', interim: '' });
  // Desktop: separate phrases are still joined.
  assert.deepEqual(transcriptOf(res(['what is gold doing', true], ['and where is support', true])), { final: 'what is gold doing and where is support', interim: '' });
  // An interim that only repeats the final adds nothing; a new one is kept apart.
  assert.deepEqual(transcriptOf(res(['what is gold doing', true], ['gold doing', false])), { final: 'what is gold doing', interim: '' });
  assert.deepEqual(transcriptOf(res(['what is gold doing', true], ['and where', false])), { final: 'what is gold doing', interim: 'and where' });
  assert.deepEqual(transcriptOf([]), { final: '', interim: '' });
});

test('without character timing the chart follows the share of audio that has PLAYED — and never runs ahead', () => {
  const L = 310;                                   // characters; about 20 s of speech
  assert.equal(spokenCharsEstimate(L, 0, 4, false), 0, 'nothing has played');
  // Early in a reply only the first chunk has arrived: the estimate assumes normal pace, not "this chunk is all of it".
  const early = spokenCharsEstimate(L, 2, 2.2, false);
  assert.ok(early > 0 && early < L * 0.15, `2 s into a 20 s answer is not most of it (${early})`);
  let last = 0;
  for (let t = 0; t <= 20; t += 0.5) {
    const c = spokenCharsEstimate(L, t, 20, true);
    assert.ok(c >= last, 'never backwards');
    last = c;
  }
  assert.equal(spokenCharsEstimate(L, 20, 20, true), L, 'all of it once it has all played');
  assert.equal(spokenCharsEstimate(L, 99, 20, true), L);
  assert.equal(spokenCharsEstimate(0, 5, 5, true), 0);
});

/* ── 6. guards ─────────────────────────────────────────────────────────────────────────────────────── */

test('the explanation is pure and takes nothing from a model: no clock, no randomness, no network, no DOM', () => {
  const code = src('command-center/core/explain.ts');
  const imports = [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./atlasContract'], 'the contract types only');
  const body = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['Date.now', 'Math.random', 'fetch(', 'window.', 'document.', 'setTimeout', 'setInterval', 'localStorage', '(?<']) {
    assert.ok(!body.includes(banned), `core/explain.ts must not use ${banned}`);
  }
  // Same input, same sequence.
  const a = buildExplanation({ responseId: 'r', text: BULL_ANSWER, ctx: BULL.ctx }), b = buildExplanation({ responseId: 'r', text: BULL_ANSWER, ctx: BULL.ctx });
  assert.deepEqual(a, b);
  // The level list the screen points at is the pure one both the live read and the replay use.
  assert.deepEqual(allLevels(BULL.r.snapshot), BULL.r.state.levelsAll);
});

test('the chart is advanced by the audio clock — not by a timer of its own', () => {
  const bus = src('src/components/command-center/hud/explainBus.ts');
  assert.ok(!/setTimeout|setInterval|requestAnimationFrame/.test(bus), 'the store keeps no timers: its callers say how far the audio is');
  const voice = src('src/components/command-center/VoiceSession.tsx');
  assert.match(voice, /explainBus\.progress\(`voice-\$\{rid\}`, chars\)/);
  assert.match(voice, /said != null \? explainText\(said\)\.length/, 'provider character timing when it exists');
  assert.match(voice, /spokenCharsEstimate\(rt\.text\.length, ctx\.currentTime - rt\.firstAt, rt\.scheduled/, 'otherwise the share of audio played, on the audio clock');
  assert.match(voice, /explainBus\.cancel\(`voice-\$\{id\}`\)/, 'stopping playback cancels the pending visuals');
  assert.match(voice, /judgeUserTurn\(text, turnMemory\.current, now, atlasSaid\.current\)/, 'every final transcript is judged before it becomes a turn');
  const layer = src('src/components/command-center/hud/AtlasAnnotations.tsx');
  assert.ok(!/setTimeout|setInterval|requestAnimationFrame/.test(layer), 'the drawing layer has no timeline of its own');
});

test('a conditional path is labelled as one and is never drawn as candles; the two layers stay separate', () => {
  const chart = src('src/components/command-center/hud/GoldChart.tsx');
  assert.match(chart, /CONDITIONAL SCENARIO/, 'the path is labelled');
  const overlay = chart.slice(chart.indexOf('export function ScenarioOverlay'), chart.indexOf('export function GoldChart'));
  assert.match(overlay, /strokeDasharray/, 'dashed');
  assert.ok(!/<rect[^>]*data-candle|candleBody|wick/i.test(overlay), 'no projected candles');
  assert.match(chart, /<UserLineLayer /); assert.match(chart, /<AnnotationLayer /);
  assert.match(chart, /Clear Atlas drawings/);
  const layer = src('src/components/command-center/hud/AtlasAnnotations.tsx');
  assert.match(layer, /data-overlay="user-drawings"/); assert.match(layer, /data-overlay="atlas-annotations"/);
  assert.match(layer, /Why does this matter\?/); assert.match(layer, /What happens if this breaks\?/);
  const css = src('src/components/command-center/hud/Hud.tsx');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /atlas-emph/);
  const hud = src('src/components/command-center/hud/CommandCenterHud.tsx');
  for (const label of ['Show me', 'Explain this candle', 'What changes your view?', 'Clear Atlas drawings', 'Return to live']) assert.ok(hud.includes(label), `control: ${label}`);
});

test('explaining on the chart changes nothing about trading: no trading path imports it', () => {
  const tradingPaths = [
    'command-center/engines/setup.ts', 'command-center/engines/validator.ts', 'command-center/engines/executor.ts',
    'command-center/engines/tradeLive.ts', 'command-center/engines/watch.ts', 'command-center/core/risk.ts',
    'src/app/api/command-center/trade/route.ts',
  ];
  for (const p of tradingPaths) {
    const code = src(p);
    assert.ok(!/core\/explain|explainBus|AtlasAnnotations/.test(code), `${p} must not import the explanation`);
  }
  const bus = src('src/components/command-center/hud/explainBus.ts');
  assert.ok(!/fetch\(|\/api\//.test(bus), 'the explanation store makes no requests at all');
});
