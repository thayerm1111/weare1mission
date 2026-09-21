import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../command-center/engines/snapshot';
import { diffSnapshots, diffSet, pickHistory } from '../command-center/brain/diff';
import { detect, nearestLevel } from '../command-center/brain/perception';
import { significant, score, route } from '../command-center/brain/significance';
import { propose, update as updateThesis, open as openThesis, biasDirection, strengthOf } from '../command-center/brain/thesis';
import { brainState, weather, velocityBand, intensity } from '../command-center/brain/presence';
import { emptyRolling, pushEvents, pushSnapshot, pushStatement, pushThesis, currentThesis, priorThesis, memoryOf, journal } from '../command-center/brain/memory';
import { perceive } from '../command-center/brain';
import { briefing, whatChanged, why, whatWouldChangeMyMind, answer, classify } from '../command-center/brain/language';
import { contextPacket, BRAIN_SYSTEM } from '../command-center/brain/context';
import type { Bar, MarketSnapshot } from '../command-center/core/types';
import type { PerceptionEvent } from '../command-center/brain/types';

const M = 60_000;
const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c });

/** A believable 5-minute series: a drift with pullbacks, so structure actually confirms swings. */
function series(n: number, start: number, drift: number, t0: number, noise = 1.2): Bar[] {
  const out: Bar[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 7) * noise * 2;
    const o = p;
    const c = p + drift + wave * 0.35;
    out.push(bar(t0 + i * 5 * M, o, Math.max(o, c) + noise, Math.min(o, c) - noise, c));
    p = c;
  }
  return out;
}

const NOW = Date.UTC(2026, 8, 16, 14, 0, 0);      // Wednesday, New York session — the market is open

/**
 * A series whose LAST bar closes at NOW. This matters: the engine refuses to speak about data that is
 * hours behind (it lowers confidence and raises exec_data_behind), which is correct behaviour and which
 * a fixture anchored in the distant past would hide.
 */
const fresh = (n: number, start: number, drift: number, noise = 1.2): Bar[] =>
  series(n, start, drift, NOW - n * 5 * M, noise);
const snapAt = (at: number, bars: Bar[], price?: number): MarketSnapshot =>
  buildSnapshot({
    now: at,
    bars: { '5m': bars, '15m': bars, '1h': bars, '4h': bars, '1d': bars },
    price: price ?? bars[bars.length - 1].c,
    feeds: [{ feed: 'twelvedata', state: 'live', lastTickMs: bars[bars.length - 1].t, ageMs: 4_000 }],
  });

/* ─────────────────────────── the difference engine ─────────────────────────── */

test('a diff is a subtraction between two real snapshots, never an estimate', () => {
  const t0 = NOW - 200 * 5 * M;
  const older = series(120, 4300, 0.3, t0);
  const newer = [...older, ...series(12, older[older.length - 1].c, 0.9, older[older.length - 1].t + 5 * M)];
  const a = snapAt(NOW - 10 * M, older, 4320);
  const b = snapAt(NOW, newer, 4335);
  const d = diffSnapshots(a, b, '5m');
  assert.equal(d.priceFrom, 4320);
  assert.equal(d.priceTo, 4335);
  assert.equal(d.priceMove, 15);
  assert.equal(d.pipsMove, 150);
  assert.equal(d.actualMs, 10 * M);
});

test('a horizon with no snapshot near enough is ABSENT rather than approximated', () => {
  const bars = fresh(120, 4300, 0.2);
  const only = snapAt(NOW - 90 * M, bars);       // 90 minutes old
  const picked = pickHistory(NOW, [only]);
  // It can legitimately serve the 1h horizon (within tolerance) but never the 1m one.
  assert.ok(!picked.some((p) => p.horizon === '1m'), 'a 90-minute-old read is not "one minute ago"');
  assert.ok(!picked.some((p) => p.horizon === '5m'));
});

test('diffSet returns one diff per horizon it can actually serve', () => {
  const bars = fresh(140, 4300, 0.25);
  const history = [60, 15, 5, 1].map((m) => snapAt(NOW - m * M, bars, 4300 + m));
  const now = snapAt(NOW, bars, 4350);
  const diffs = diffSet(now, history);
  assert.ok(diffs.length >= 3, 'several horizons are available');
  assert.deepEqual([...new Set(diffs.map((d) => d.horizon))].length, diffs.length, 'no horizon appears twice');
});

/* ─────────────────────────── perception ─────────────────────────── */

test('a quiet market produces no movement events — silence is a real output', () => {
  const flat = Array.from({ length: 120 }, (_, i) => bar(NOW - (120 - i) * 5 * M, 4300, 4300.4, 4299.6, 4300));
  const a = snapAt(NOW - 5 * M, flat, 4300);
  const b = snapAt(NOW, flat, 4300.02);
  const events = detect({ now: b, prev: a, diffs: [diffSnapshots(a, b, '5m')] });
  const movement = events.filter((e) => e.code === 'MOMENTUM_ACCELERATION' || e.code === 'PRICE_ACCELERATION');
  assert.equal(movement.length, 0, 'nothing moved, so nothing is reported as moving');
});

test('a decisive move IS noticed, and the sentence is trader language not a metric dump', () => {
  const bars = fresh(130, 4300, 0.35);
  const a = snapAt(NOW - 5 * M, bars, 4320);
  const b = snapAt(NOW, bars, 4338);
  const events = detect({ now: b, prev: a, diffs: [diffSnapshots(a, b, '5m')] });
  const move = events.find((e) => e.code === 'MOMENTUM_ACCELERATION');
  assert.ok(move, 'an 18-dollar move in five minutes is an event');
  assert.match(move!.detail, /push higher|drop/, 'it reads like a trader, not a report generator');
  assert.ok(!/score|coefficient|z-score/i.test(move!.detail));
});

test('market closed and degraded feeds are raised as events before any market opinion', () => {
  const bars = series(120, 4300, 0.2, Date.UTC(2026, 8, 19, 2, 0, 0) - 200 * 5 * M);
  const weekend = Date.UTC(2026, 8, 19, 2, 0, 0);     // Saturday 02:00 UTC — Friday night in New York
  const s = snapAt(weekend, bars);
  const events = detect({ now: s, prev: null, diffs: [] });
  assert.ok(events.some((e) => e.code === 'MARKET_CLOSED'), 'it says the market is closed');
});

test('nearestLevel measures distance in ATR, not dollars', () => {
  const bars = fresh(140, 4300, 0.3);
  const s = snapAt(NOW, bars);
  const n = nearestLevel(s);
  if (n) {
    assert.ok(n.distAtr >= 0, 'distance is a real ATR multiple');
    assert.ok(Number.isFinite(n.distAtr));
  }
});

/* ─────────────────────────── significance ─────────────────────────── */

const rawEvent = (code: PerceptionEvent['code'], at = NOW) => ({
  key: `${code}:${at}`, at, code, horizon: '5m' as const, timeframe: null,
  detail: 'x', data: {}, level: null, lean: 'neutral' as const,
});

test('repeating itself is punished: the same observation twice in a minute loses its novelty', () => {
  const bars = fresh(130, 4300, 0.3);
  const s = snapAt(NOW, bars);
  const first = score(rawEvent('BULLISH_PRESSURE_RISING'), { snapshot: s, recent: [], lastSpokeAt: null });
  const already: PerceptionEvent = { ...rawEvent('BULLISH_PRESSURE_RISING', NOW - 30_000), significance: first, channel: 'stream' };
  const second = score(rawEvent('BULLISH_PRESSURE_RISING'), { snapshot: s, recent: [already], lastSpokeAt: null });
  assert.equal(first.novelty, 100);
  assert.ok(second.novelty < 20, 'saying the same thing 30 seconds later is not news');
  assert.ok(second.score < first.score);
});

test('a degraded feed lowers confidence, and low confidence is never allowed to speak', () => {
  const bars = fresh(130, 4300, 0.3);
  const good = snapAt(NOW, bars);
  const bad = buildSnapshot({
    now: NOW, bars: { '5m': bars, '1h': bars }, price: 4330,
    feeds: [{ feed: 'twelvedata', state: 'stale', lastTickMs: NOW - 400_000, ageMs: 400_000 }],
  });
  const a = score(rawEvent('REGIME_CHANGE'), { snapshot: good, recent: [], lastSpokeAt: null });
  const b = score(rawEvent('REGIME_CHANGE'), { snapshot: bad, recent: [], lastSpokeAt: null });
  assert.ok(b.confidence < a.confidence - 20, 'a stale feed is less trustworthy');
  const ch = route(b, 'REGIME_CHANGE', { snapshot: bad, recent: [], lastSpokeAt: null });
  assert.ok(ch !== 'voice' && ch !== 'urgent', 'it does not speak about data it cannot trust');
});

test('restraint: having just spoken, an ordinary event does not speak again', () => {
  const bars = fresh(130, 4300, 0.3);
  const s = snapAt(NOW, bars);
  const sig = score(rawEvent('LEVEL_ACCEPTANCE'), { snapshot: s, recent: [], lastSpokeAt: null });
  const quiet = route(sig, 'LEVEL_ACCEPTANCE', { snapshot: s, recent: [], lastSpokeAt: NOW - 5_000 });
  const free = route(sig, 'LEVEL_ACCEPTANCE', { snapshot: s, recent: [], lastSpokeAt: NOW - 20 * M });
  assert.ok(free === 'voice' || free === 'text');
  assert.ok(quiet !== 'voice', 'it does not talk over itself');
});

test('a broken feed still interrupts — urgency outranks restraint', () => {
  const bars = fresh(130, 4300, 0.3);
  const s = snapAt(NOW, bars);
  const sig = score(rawEvent('FEED_DEGRADED'), { snapshot: s, recent: [], lastSpokeAt: NOW - 1_000 });
  assert.equal(route(sig, 'FEED_DEGRADED', { snapshot: s, recent: [], lastSpokeAt: NOW - 1_000 }), 'urgent');
});

test('silent events never reach the product', () => {
  const bars = fresh(130, 4300, 0.3);
  const s = snapAt(NOW, bars);
  const out = significant([rawEvent('LEVEL_APPROACH')], { snapshot: s, recent: Array.from({ length: 4 }, (_, i) => ({ ...rawEvent('LEVEL_APPROACH', NOW - i * 20_000), significance: { importance: 0, novelty: 0, urgency: 0, confidence: 0, score: 0 }, channel: 'stream' as const })), lastSpokeAt: null });
  assert.ok(out.every((e) => e.channel !== 'silent'));
});

/* ─────────────────────────── thesis ─────────────────────────── */

test('it is willing to have NO opinion — blockers force stand aside', () => {
  const bars = fresh(120, 4300, 0.3);
  const blocked = buildSnapshot({
    now: NOW, bars: { '5m': bars }, price: 4330,
    feeds: [{ feed: 'twelvedata', state: 'disconnected', lastTickMs: null, ageMs: null }],
  });
  const p = propose(blocked);
  assert.equal(p.bias, 'stand_aside');
});

test('a thesis is closed with a reason and replaced — never silently rewritten', () => {
  const bars = fresh(150, 4300, 0.4);
  const s1 = snapAt(NOW - 10 * M, bars, 4360);
  const first = openThesis({ bias: 'bullish_continuation', confidence: 70, reasons: ['Higher timeframes lean bullish.'], watching: [4370], invalidation: 4350 }, s1);
  const s2 = snapAt(NOW, bars, 4340);       // straight through the invalidation
  const u = updateThesis(first, s2, [], []);
  assert.equal(u.change, 'changed_mind');
  assert.ok(u.previous, 'the old thesis is closed, not edited');
  assert.equal(u.previous!.endedAt, s2.at);
  assert.ok(u.previous!.reasonEnded && u.previous!.reasonEnded.length > 0, 'it records WHY it was wrong');
  assert.match(u.statement, /changed my read/i, 'it says so out loud instead of pretending');
  assert.notEqual(u.thesis.id, first.id);
});

test('a thesis does not flip-flop on noise inside its minimum life', () => {
  const bars = fresh(150, 4300, 0.4);
  const s1 = snapAt(NOW - 20_000, bars, 4360);
  const t = openThesis({ bias: 'bullish_continuation', confidence: 70, reasons: ['x'], watching: [], invalidation: null }, s1);
  const s2 = snapAt(NOW, bars, 4361);
  const u = updateThesis(t, s2, [], []);
  assert.notEqual(u.change, 'changed_mind', '20 seconds is not long enough to change its mind without invalidation');
});

test('strength is a function of confidence, and direction is read from the bias', () => {
  assert.equal(strengthOf(80), 'strong');
  assert.equal(strengthOf(60), 'moderate');
  assert.equal(strengthOf(30), 'tentative');
  assert.equal(biasDirection('bullish_continuation'), 'bullish');
  assert.equal(biasDirection('bearish_reversal'), 'bearish');
  assert.equal(biasDirection('range_fade'), 'neutral');
});

/* ─────────────────────────── presence ─────────────────────────── */

test('a closed market is never dressed up as calm, and the visual stops', () => {
  const bars = series(120, 4300, 0.2, Date.UTC(2026, 8, 19, 2, 0, 0) - 200 * 5 * M);
  const s = snapAt(Date.UTC(2026, 8, 19, 2, 0, 0), bars);
  const st = brainState({ snapshot: s, thesis: null, events: [] });
  assert.ok(st.presence === 'market_closed' || st.presence === 'offline');
  assert.ok(st.intensity <= 4, 'nothing is moving, so nothing on screen moves');
});

test('intensity comes from volatility and velocity, not from a clock', () => {
  const calm = Array.from({ length: 140 }, (_, i) => bar(NOW - (140 - i) * 5 * M, 4300, 4300.3, 4299.7, 4300));
  const wild = fresh(140, 4300, 1.6, 6);
  const a = intensity(snapAt(NOW, calm));
  const b = intensity(snapAt(NOW, wild));
  assert.ok(b > a, 'a violent tape reads hotter than a dead one');
  assert.ok(a >= 0 && b <= 100);
});

test('weather and velocity are words a trader would use', () => {
  const calm = Array.from({ length: 140 }, (_, i) => bar(NOW - (140 - i) * 5 * M, 4300, 4300.3, 4299.7, 4300));
  assert.ok(['quiet', 'compressed', 'normal'].includes(weather(snapAt(NOW, calm))));
  assert.ok(['calm', 'building', 'fast', 'accelerating', 'extreme', 'decelerating'].includes(velocityBand(snapAt(NOW, calm))));
});

test('ATLAS always has a question it is trying to answer', () => {
  const bars = fresh(140, 4300, 0.3);
  const st = brainState({ snapshot: snapAt(NOW, bars), thesis: null, events: [] });
  assert.ok(st.question.length > 8 && st.question.endsWith('?'));
});

/* ─────────────────────────── memory ─────────────────────────── */

test('memory is bounded and keeps the open thesis separate from the closed one', () => {
  let r = emptyRolling();
  const bars = fresh(140, 4300, 0.3);
  for (let i = 0; i < 30; i++) r = pushSnapshot(r, snapAt(NOW - (30 - i) * M, bars, 4300 + i));
  const closed = { ...openThesis({ bias: 'bearish_continuation', confidence: 60, reasons: [], watching: [], invalidation: null }, snapAt(NOW - 40 * M, bars)), endedAt: NOW - 20 * M, reasonEnded: 'we lost the level' };
  const open = openThesis({ bias: 'bullish_continuation', confidence: 66, reasons: [], watching: [], invalidation: null }, snapAt(NOW - 10 * M, bars));
  r = pushThesis(r, closed);
  r = pushThesis(r, open);
  assert.equal(currentThesis(r)?.id, open.id);
  assert.equal(priorThesis(r)?.id, closed.id);
  assert.ok(r.snapshots.length <= 260);
  assert.equal(journal(r, NOW - 60 * M).length, 2);
});

test('lastSpokeAt only moves when it actually spoke aloud', () => {
  let r = emptyRolling();
  r = pushStatement(r, { at: NOW, kind: 'observation', text: 'quiet', channel: 'stream', priceAt: 4300, thesisId: null });
  assert.equal(r.lastSpokeAt, null, 'a stream line is not speech');
  r = pushStatement(r, { at: NOW + 1000, kind: 'alert', text: 'loud', channel: 'voice', priceAt: 4300, thesisId: null });
  assert.equal(r.lastSpokeAt, NOW + 1000);
});

test('events are deduped by key when pushed twice', () => {
  const e: PerceptionEvent = { ...rawEvent('REGIME_CHANGE'), significance: { importance: 1, novelty: 1, urgency: 1, confidence: 1, score: 1 }, channel: 'stream' };
  let r = emptyRolling();
  r = pushEvents(r, [e], NOW);
  r = pushEvents(r, [e], NOW);
  assert.equal(r.events.length, 1);
});

/* ─────────────────────────── the full pass ─────────────────────────── */

test('perceive() is pure and deterministic: same input, same output', () => {
  const bars = fresh(160, 4300, 0.35);
  let r = emptyRolling();
  for (let i = 8; i >= 1; i--) r = pushSnapshot(r, snapAt(NOW - i * M, bars, 4320 + i));
  const s = snapAt(NOW, bars, 4341);
  const a = perceive({ rolling: r, snapshot: s });
  const b = perceive({ rolling: r, snapshot: s });
  assert.deepEqual(a.events.map((e) => e.key), b.events.map((e) => e.key));
  assert.equal(a.state.presence, b.state.presence);
  assert.equal(a.thesis.bias, b.thesis.bias);
});

test('a first pass opens a thesis and remembers the snapshot', () => {
  const bars = fresh(160, 4300, 0.35);
  const p = perceive({ rolling: emptyRolling(), snapshot: snapAt(NOW, bars) });
  assert.equal(p.thesisChange, 'opened');
  assert.equal(p.rolling.snapshots.length, 1);
  assert.ok(p.memory.state);
});

/* ─────────────────────────── language ─────────────────────────── */

test('the narrator never invents a price and admits when it cannot see', () => {
  const m = memoryOf(emptyRolling(), null, [], null);
  const b = briefing(m);
  assert.match(b, /can't see|cannot see/i);
  assert.ok(!/\d{4}\.\d{2}/.test(b), 'with no data it quotes no price');
});

test('with no history it says so rather than inventing a comparison', () => {
  const bars = fresh(140, 4300, 0.3);
  const m = memoryOf(emptyRolling(), snapAt(NOW, bars), [], null);
  assert.match(whatChanged(m), /not.*enough history|just started/i);
});

test('the briefing speaks in sentences, with no markdown and no metric dump', () => {
  const bars = fresh(160, 4300, 0.35);
  let r = emptyRolling();
  for (let i = 20; i >= 1; i--) r = pushSnapshot(r, snapAt(NOW - i * M, bars, 4300 + i * 0.6));
  const p = perceive({ rolling: r, snapshot: snapAt(NOW, bars, 4315) });
  const text = briefing(p.memory);
  assert.ok(text.length > 60);
  assert.ok(!text.includes('*') && !text.includes('#') && !text.includes('\n'), 'this gets spoken aloud');
  assert.ok(!/guarantee|certain|can\'t lose|sure thing/i.test(text), 'no false certainty');
});

test('why() refuses to justify a read it does not have', () => {
  const m = memoryOf(emptyRolling(), null, [], null);
  assert.match(why(m), /don't have|nothing to justify/i);
});

test('what-would-change-my-mind names the actual level, not a platitude', () => {
  const bars = fresh(160, 4300, 0.4);
  const s = snapAt(NOW, bars, 4360);
  const t = openThesis({ bias: 'bullish_continuation', confidence: 70, reasons: [], watching: [4370], invalidation: 4348.5 }, s);
  let r = pushThesis(emptyRolling(), t);
  r = pushSnapshot(r, s);
  const m = memoryOf(r, s, [], null);
  assert.match(whatWouldChangeMyMind(m), /4348\.50/);
});

test('question routing picks the right answer', () => {
  assert.equal(classify('ATLAS, talk to me.').intent, 'briefing');
  assert.equal(classify('what changed over the last five minutes?').intent, 'what_changed');
  assert.equal(classify('why are you bullish?').intent, 'why');
  assert.equal(classify('what would change your mind?').intent, 'change_mind');
  assert.equal(classify('show me the math').intent, 'math');
});

test('the narrator answer is always grounded and labels itself honestly', () => {
  const bars = fresh(160, 4300, 0.35);
  let r = emptyRolling();
  for (let i = 20; i >= 1; i--) r = pushSnapshot(r, snapAt(NOW - i * M, bars, 4300 + i * 0.6));
  const p = perceive({ rolling: r, snapshot: snapAt(NOW, bars, 4315) });
  const a = answer('what changed?', p.memory);
  assert.equal(a.source, 'narrator', 'it never claims to be the model');
  assert.ok(a.spokenText.length > 20);
});

/* ─────────────────────────── the model boundary ─────────────────────────── */

test('the system prompt forbids inventing data and forbids claiming to trade', () => {
  assert.match(BRAIN_SYSTEM, /never invent/i);
  assert.match(BRAIN_SYSTEM, /do not place, modify or close/i);
  assert.match(BRAIN_SYSTEM, /don't know/i);
  assert.match(BRAIN_SYSTEM, /Never promise a result/i);
});

test('the context packet carries measured state and its own past words', () => {
  const bars = fresh(160, 4300, 0.35);
  let r = emptyRolling();
  for (let i = 20; i >= 1; i--) r = pushSnapshot(r, snapAt(NOW - i * M, bars, 4300 + i * 0.6));
  r = pushStatement(r, { at: NOW - 60_000, kind: 'observation', text: 'Buyers are getting stronger.', channel: 'voice', priceAt: 4314, thesisId: null });
  const p = perceive({ rolling: r, snapshot: snapAt(NOW, bars, 4315) });
  const packet = contextPacket(p.memory);
  assert.match(packet, /RIGHT NOW/);
  assert.match(packet, /TIMEFRAMES/);
  assert.match(packet, /MY CURRENT READ/);
  assert.match(packet, /Buyers are getting stronger/, 'it is given what it already said, so it does not repeat itself');
  assert.match(packet, /NOT order flow/, 'pressure is labelled honestly inside the model context too');
});

test('a packet with no market read says so instead of filling in blanks', () => {
  const packet = contextPacket(memoryOf(emptyRolling(), null, [], null));
  assert.match(packet, /No market read available/);
  assert.ok(!/price:/.test(packet));
});

/* ─────────────────────────── restraint, learned from real gold ─────────────────────────── */

test('a standing condition is not re-announced every time it is re-measured', () => {
  const bars = fresh(140, 4300, 0.3);
  const s = snapAt(NOW, bars);
  const earlier: PerceptionEvent = {
    ...rawEvent('PRESSURE_FLIP', NOW - 5 * M),
    significance: { importance: 75, novelty: 100, urgency: 70, confidence: 90, score: 70 }, channel: 'voice',
  };
  const again = significant([rawEvent('PRESSURE_FLIP')], { snapshot: s, recent: [earlier], lastSpokeAt: null });
  assert.equal(again.length, 0, 'sellers being in control five minutes later is the same sentence');
});

test('the same observation seen through two horizons is reported once', () => {
  const bars = fresh(140, 4300, 0.3);
  const s = snapAt(NOW, bars);
  const a = { ...rawEvent('REGIME_CHANGE'), key: 'a', horizon: '5m' as const, data: { from: 'x', to: 'z' } };
  const b = { ...rawEvent('REGIME_CHANGE'), key: 'b', horizon: '1h' as const, data: { from: 'y', to: 'z' } };
  const out = significant([a, b], { snapshot: s, recent: [], lastSpokeAt: null });
  assert.equal(out.filter((e) => e.code === 'REGIME_CHANGE').length, 1, 'one thing happened, so it is said once');
});

test('pressure language respects the SIGN, not just the direction', async () => {
  const { detect: det } = await import('../command-center/brain/perception');
  const bars = fresh(140, 4300, 0.3);
  const a = snapAt(NOW - 5 * M, bars, 4340);
  const b = snapAt(NOW, bars, 4341);
  const d = diffSnapshots(a, b, '5m');
  // sellers easing: -32 → -18 is NOT buyers taking control
  const easing = det({ now: b, prev: a, diffs: [{ ...d, pressureFrom: -32, pressureTo: -18, pressureChange: 14, pressureFlipped: false }] })
    .find((e) => e.code === 'BULLISH_PRESSURE_RISING');
  assert.ok(easing, 'a 14-point move in pressure is noticed');
  assert.match(easing!.detail, /Sellers are easing off/);
  assert.ok(!/Buyers are getting stronger/.test(easing!.detail), 'a downtrend is never described as buyers taking over');

  const buying = det({ now: b, prev: a, diffs: [{ ...d, pressureFrom: 10, pressureTo: 38, pressureChange: 28, pressureFlipped: false }] })
    .find((e) => e.code === 'BULLISH_PRESSURE_RISING');
  assert.match(buying!.detail, /Buyers are getting much stronger/);

  const fading = det({ now: b, prev: a, diffs: [{ ...d, pressureFrom: 30, pressureTo: 10, pressureChange: -20, pressureFlipped: false }] })
    .find((e) => e.code === 'BULLISH_PRESSURE_COLLAPSING');
  assert.match(fading!.detail, /Buyers are losing the grip/);
});

test('a read is not replaced by "neutral" — drifting to no opinion is a weakening, not a new one', () => {
  const bars = fresh(160, 4300, 0.4);
  const s1 = snapAt(NOW - 30 * M, bars, 4360);
  const t = openThesis({ bias: 'bullish_continuation', confidence: 74, reasons: ['x'], watching: [], invalidation: 4200 }, s1);
  const s2 = snapAt(NOW, bars, 4361);
  const u = updateThesis(t, s2, [], []);
  assert.notEqual(u.change, 'changed_mind', 'losing conviction is not the same as changing sides');
});

test('replaying real recorded gold produces a coherent read, not a mood swing per bar', async () => {
  const { replay } = await import('../command-center/engines/replay');
  const r = replay(46);
  assert.ok((r.state.price ?? 0) > 1000, 'it priced real gold');
  assert.equal(r.state.live, false, 'a replay is never presented as live');
  assert.ok(r.state.journal.length >= 1 && r.state.journal.length <= 6, `a coherent number of reads, got ${r.state.journal.length}`);
  assert.ok(r.state.events.length > 0, 'it noticed things');
  const at = r.state.events[0].at;
  const sameMoment = r.state.events.filter((e) => e.at === at);
  const codes = new Set(sameMoment.map((e) => `${e.code}|${e.timeframe ?? ''}`));
  assert.equal(codes.size, sameMoment.length, 'no duplicate observations within one moment');
  assert.ok(r.state.brain, 'it has a state of mind');
  assert.ok(r.state.brain!.question.endsWith('?'));
});
