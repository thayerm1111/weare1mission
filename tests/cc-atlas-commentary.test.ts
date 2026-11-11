import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialCommentaryState, observeCommentary, takeNextCommentary, retuneCommentary, feedViewOf,
  commentaryCooldownMs, statusEveryMs, volunteeredTurn, parseVolunteeredTurn, isVolunteeredTurn,
  VOLUNTEERED_MARK, VOLUNTEERED_MAX_CHARS, WATCH_COOLDOWN_MS, URGENT_FLOOR_MS, MAX_QUEUE, FEED_DEBOUNCE_MS,
  INPUT_STALE_MS, ANALYSIS_STALE_MS,
  type CommentaryInput, type CommentarySettings, type CommentaryState, type CommentaryItem,
} from '../command-center/core/commentary';
import type { AtlasRead, Lean, Scenario, ScenarioStatus } from '../command-center/core/atlasContract';

/*
 * ATLAS COMMENTARY — what it volunteers, and what it keeps to itself.
 *
 * Every test drives the pure engine with successive live payloads and an explicit clock, exactly as the
 * browser does: observe a payload, then ask whether anything is worth saying yet.
 */

const T0 = Date.UTC(2026, 10, 10, 14, 0, 0);
const S = 1000, MIN = 60_000;
const WATCH: CommentarySettings = { mode: 'watch', copilotCooldownMs: 90_000 };
const COPILOT: CommentarySettings = { mode: 'copilot', copilotCooldownMs: 120_000 };
const QUIET: CommentarySettings = { mode: 'quiet', copilotCooldownMs: 90_000 };

function read(lean: Lean, since: number, at = since, extra: Partial<AtlasRead> = {}): AtlasRead {
  return {
    version: 'read-1', at, snapshotId: 1, horizon: 'intraday', horizonTf: '15m', lean, strength: 'clear', score: 40,
    htfTrend: { tf: '1h', state: 'down', text: '1h lower highs' },
    momentum: { tf: '5m', state: 'falling', text: 'falling' },
    setupStage: 'watching', entry: 'none',
    evidenceFor: [{ text: 'price lost the 4,352 shelf', weight: 2 }], evidenceAgainst: [],
    nextWatch: { text: 'the 4,340 low', ref: { kind: 'level', levelId: 'pdl@4340.00', price: 4340 } },
    invalidation: { text: 'acceptance back above 4,365', price: 4365 },
    since, previous: null, summary: 'Bearish lean on the 15-minute; price lost 4,352 and the 1-hour is rolling over.',
    ...extra,
  };
}

function scenario(id: string, status: ScenarioStatus, at: number, extra: Partial<Scenario> = {}): Scenario {
  return {
    id, role: 'base', title: 'Rejection at 4,365 extends to 4,340', tf: '15m', direction: 'down',
    evidence: [], trigger: { text: 'a 15m close below 4,350', price: 4350 },
    invalidation: { text: 'a 15m close above 4,365', price: 4365 },
    status, since: at - 10 * MIN, updatedAt: at, history: [{ at, status, reason: 'price closed below 4,350' }],
    ...extra,
  };
}

const liveFeed = (now: number) => ({ provider: 'Twelve Data', symbol: 'XAU/USD', quoteType: 'mid' as const, transport: 'websocket_relay' as const, price: 4350, providerTs: now, receivedTs: now, ageMs: 900, status: 'live' as const, reason: 'streamed tick 1s old', checkedAt: now });

function payload(now: number, extra: Partial<CommentaryInput> = {}): CommentaryInput {
  return {
    ok: true, at: now - 20 * S, live: true, connected: true, marketOpen: true, reason: null,
    feed: liveFeed(now), read: read('bearish_lean', T0 - 30 * MIN, now - 20 * S), scenarios: [], events: [],
    thesis: { watching: [4340, 4365], invalidationPrice: 4365 }, watches: [], intel: { news: null },
    ...extra,
  };
}

/** Observe a sequence; return the final state and everything queued along the way. */
function run(steps: [number, CommentaryInput][], settings: CommentarySettings, start: CommentaryState = initialCommentaryState()) {
  let s = start;
  const added: CommentaryItem[] = [];
  const cancelled: CommentaryItem[] = [];
  for (const [now, p] of steps) {
    const r = observeCommentary(s, p, now, settings);
    s = r.state; added.push(...r.added); cancelled.push(...r.cancelled);
  }
  return { s, added, cancelled };
}

/* ── detection ────────────────────────────────────────────────────────────────────────────────────── */

test('the first payload is the baseline: what is already on screen is not news', () => {
  const now = T0;
  const { s, added } = run([[now, payload(now, {
    scenarios: [scenario('a', 'developing', now - MIN)],
    events: [{ key: 'STRUCTURE_BREAK:5m:-:1', at: now - 30 * S, code: 'STRUCTURE_BREAK', detail: '5-minute structure broke to the downside.', channel: 'voice', lean: 'bearish', data: { direction: 'down' } }],
    intel: { news: null },
  })]], WATCH);
  assert.equal(added.length, 0);
  assert.equal(s.queue.length, 0);
  assert.equal(s.lean?.lean, 'bearish_lean');
});

test('a material lean change is detected, worded with what changed, why, and what is next', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const { s, added } = run([
    [t1, payload(t1, { read: read('bullish_lean', T0 - 40 * MIN, t1) })],
    [t2, payload(t2, { read: read('bearish_lean', t2 - 10 * S, t2, { previous: { lean: 'bullish_lean', until: t2 - 10 * S, reason: 'price lost the 4,352 shelf' } }) })],
  ], WATCH);
  assert.equal(added.length, 1);
  const it = added[0];
  assert.equal(it.kind, 'lean');
  assert.equal(it.stateKey, 'bearish_lean');
  assert.match(it.text, /now a bearish lean on the 15-minute \(clear\), from a bullish lean/);
  assert.match(it.text, /Price lost the 4,352 shelf\./, 'the reason the old lean ended');
  assert.match(it.text, /Watching the 4,340 low\./, 'and what matters next');
  assert.ok(it.modes.includes('watch') && it.modes.includes('copilot'));
  assert.equal(s.queue.length, 1);
});

test('the same lean restarting (new since, same lean) is not a material change', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const { added } = run([
    [t1, payload(t1, { read: read('bearish_lean', T0 - 40 * MIN, t1) })],
    [t2, payload(t2, { read: read('bearish_lean', t2 - 5 * S, t2) })],
  ], WATCH);
  assert.equal(added.length, 0);
});

test('scenario status changes: confirmed and invalidated speak in Watch; developing only in Session copilot', () => {
  const t1 = T0, t2 = T0 + 30 * S, t3 = T0 + 60 * S;
  const steps: [number, CommentaryInput][] = [
    [t1, payload(t1, { scenarios: [scenario('a', 'watching', t1 - MIN)] })],
    [t2, payload(t2, { scenarios: [scenario('a', 'developing', t2)] })],
    [t3, payload(t3, { scenarios: [scenario('a', 'confirmed', t3)] })],
  ];
  const watch = run(steps, WATCH);
  assert.deepEqual(watch.added.map((i) => i.text.split(':')[0]), ['Base case confirmed']);
  assert.match(watch.added[0].text, /Price closed below 4,350\./);

  const copilot = run(steps, COPILOT);
  assert.deepEqual(copilot.added.map((i) => i.basis), ['developing', 'confirmed']);
  // Obsolescence: the newer status replaced the waiting one on the same scenario.
  assert.deepEqual(copilot.s.queue.map((i) => i.basis), ['confirmed']);
  assert.ok(copilot.cancelled.some((i) => i.basis === 'developing'));
});

test('a new scenario appearing after the baseline is mentioned only by Session copilot, and only a base case', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const steps: [number, CommentaryInput][] = [
    [t1, payload(t1, { scenarios: [] })],
    [t2, payload(t2, { scenarios: [scenario('b', 'watching', t2), scenario('c', 'watching', t2, { role: 'alternative' })] })],
  ];
  assert.equal(run(steps, WATCH).added.length, 0);
  const c = run(steps, COPILOT).added;
  assert.equal(c.length, 1);
  assert.match(c[0].text, /^New base case: /);
});

test('a confirmed structure break is announced once, however many horizons report it', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const brk = (h: string) => ({ key: `STRUCTURE_BREAK:${h}:-:${Math.floor(t2 / MIN)}`, at: t2 - 5 * S, code: 'STRUCTURE_BREAK', detail: '5-minute structure broke to the downside.', channel: 'voice', lean: 'bearish', data: { direction: 'down' } });
  const { added } = run([
    [t1, payload(t1, { events: [] })],
    [t2, payload(t2, { events: [brk('5m'), brk('15m'), brk('1h')] })],
  ], WATCH);
  assert.equal(added.length, 1);
  assert.equal(added[0].kind, 'structure');
  assert.equal(added[0].text, 'Confirmed: 5-minute structure broke to the downside.');
});

test('a failed breakout supersedes the waiting structure break it contradicts', () => {
  const t1 = T0, t2 = T0 + 30 * S, t3 = T0 + 60 * S;
  const { s, cancelled } = run([
    [t1, payload(t1, { events: [] })],
    [t2, payload(t2, { events: [{ key: 'b1', at: t2, code: 'STRUCTURE_BREAK', detail: '5-minute structure broke to the downside.', lean: 'bearish', data: { direction: 'down' } }] })],
    [t3, payload(t3, { events: [{ key: 'f1', at: t3, code: 'FAILED_BREAKOUT', detail: 'That downside break failed — price came back inside.', lean: 'bullish', data: { direction: 'down' } }] })],
  ], WATCH);
  assert.deepEqual(s.queue.map((i) => i.dedupeKey), ['structure:FAILED_BREAKOUT:down']);
  assert.ok(cancelled.some((i) => i.dedupeKey === 'structure:STRUCTURE_BREAK:down'));
});

test('stale perception events are history, not news', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const { added } = run([
    [t1, payload(t1, { events: [] })],
    [t2, payload(t2, { events: [{ key: 'old', at: t2 - 10 * MIN, code: 'STRUCTURE_BREAK', detail: 'old break', data: { direction: 'up' } }] })],
  ], WATCH);
  assert.equal(added.length, 0);
});

test('level interactions speak only for watched levels — and say why the level matters', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const lv = (key: string, code: string, price: number, channel = 'text') =>
    ({ key, at: t2, code, detail: `Level ${price} event.`, channel, lean: 'neutral', level: { price, label: 'L' }, data: {} });
  const steps: [number, CommentaryInput][] = [
    [t1, payload(t1, { events: [] })],
    [t2, payload(t2, {
      watches: [{ price: 4321.5, label: 'member level' }],
      events: [
        lv('e1', 'LEVEL_REJECTION', 4365.2),          // the read's invalidation (within tolerance)
        lv('e2', 'LEVEL_TOUCH', 4321.5),               // the member asked to watch it
        lv('e3', 'LEVEL_ACCEPTANCE', 4400, 'text'),    // nobody is watching it, and the engine kept it quiet
        lv('e4', 'LEVEL_ACCEPTANCE', 4410, 'voice'),   // nobody is watching it, but the engine rated it loud
        lv('e5', 'LEVEL_APPROACH', 4340),              // approaching a watched level: copilot only
      ],
    })],
  ];
  const w = run(steps, WATCH).added;
  assert.equal(w.length, 2);
  assert.match(w.find((i) => i.dedupeKey.includes('4365.2'))!.text, /That's where my read fails\./);
  assert.match(w.find((i) => i.dedupeKey.includes('4321.5'))!.text, /You asked me to watch that level\./);

  const c = run(steps, COPILOT).added.map((i) => i.dedupeKey).sort();
  assert.deepEqual(c, ['level:4321.5:touch', 'level:4340.0:approach', 'level:4365.2:reject', 'level:4410.0:accept']);
});

test('a level touched every minute while price sits on it is said once inside its window', () => {
  const t1 = T0;
  const touch = (n: number) => ({ key: `LEVEL_TOUCH:-:4340.00:${n}`, at: t1 + n * MIN, code: 'LEVEL_TOUCH', detail: 'Price is right at PDL (4340.00).', channel: 'text', level: { price: 4340 }, data: {} });
  const steps: [number, CommentaryInput][] = [[t1, payload(t1, { events: [] })]];
  for (let n = 1; n <= 5; n++) steps.push([t1 + n * MIN, payload(t1 + n * MIN, { events: [touch(n)] })]);
  // Delivered as soon as it is queued, so dedupe — not supersede — is what keeps the rest quiet.
  let s = initialCommentaryState();
  const said: string[] = [];
  for (const [now, p] of steps) {
    s = observeCommentary(s, p, now, WATCH).state;
    const r = takeNextCommentary(s, now, WATCH); s = r.state;
    if (r.item) said.push(r.item.dedupeKey);
  }
  assert.deepEqual(said, ['level:4340.0:touch']);
});

test('scheduled high-impact news inside 15 minutes is announced once, and only while it is ahead', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const releaseAt = t2 + 12 * MIN;
  const news = (importance: string, at = releaseAt) => ({ news: { name: 'US CPI', at, importance, minutesTo: (at - t2) / MIN } });
  const high = run([[t1, payload(t1)], [t2, payload(t2, { intel: news('high') })]], WATCH);
  assert.equal(high.added.length, 1);
  assert.equal(high.added[0].text, 'High-impact news: US CPI in 12 minutes. Expect a volatility spike and wider spreads around the release.');
  assert.equal(high.added[0].market, false, 'a calendar fact, still true when the feed is not');
  assert.equal(high.added[0].expiresAt, releaseAt, 'and worthless once the release has passed');

  assert.equal(run([[t1, payload(t1)], [t2, payload(t2, { intel: news('medium') })]], WATCH).added.length, 0, 'not high impact');
  assert.equal(run([[t1, payload(t1)], [t2, payload(t2, { intel: news('high', t2 + 20 * MIN) })]], WATCH).added.length, 0, 'not inside 15 minutes');

  // The perception event for the same release, and later polls, add nothing.
  const t3 = t2 + MIN;
  const again = run([
    [t1, payload(t1)], [t2, payload(t2, { intel: news('high') })],
    [t3, payload(t3, { intel: news('high'), events: [{ key: 'n1', at: t3, code: 'NEWS_APPROACHING', detail: 'US CPI is 11 minutes away.', data: { minutes: 11, importance: 'high' } }] })],
  ], WATCH);
  assert.equal(again.added.length, 1);

  // Past the release, it is dropped rather than said late.
  const late = takeNextCommentary(high.s, releaseAt + S, WATCH);
  assert.equal(late.item, null);
  assert.equal(late.dropped.length, 1);
});

test('news inside five minutes is urgent and the release name can come from the perception event alone', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const { added } = run([[t1, payload(t1)], [t2, payload(t2, {
    events: [{ key: 'n1', at: t2, code: 'NEWS_APPROACHING', detail: 'FOMC Statement is 4 minutes away.', data: { minutes: 4, importance: 'high' } }],
  })]], WATCH);
  assert.equal(added.length, 1);
  assert.match(added[0].text, /^High-impact news: FOMC Statement in 4 minutes\./);
  assert.ok(added[0].priority >= 90);
});

/* ── dedupe, obsolescence, cap ────────────────────────────────────────────────────────────────────── */

test('a lean change that reverses before it was said cancels out — nothing is volunteered', () => {
  const t1 = T0, t2 = T0 + 30 * S, t3 = T0 + 60 * S;
  const { s, cancelled } = run([
    [t1, payload(t1, { read: read('bearish_lean', T0 - 40 * MIN, t1) })],
    [t2, payload(t2, { read: read('balanced', t2, t2) })],
    [t3, payload(t3, { read: read('bearish_lean', t3, t3) })],
  ], WATCH);
  assert.equal(s.queue.length, 0);
  assert.equal(cancelled.length, 1, 'the waiting "balanced" item was cancelled');
  assert.equal(takeNextCommentary(s, t3, WATCH).item, null);
});

test('an older lean change is superseded by a newer one; only the latest state is said', () => {
  const t1 = T0, t2 = T0 + 30 * S, t3 = T0 + 60 * S;
  const { s } = run([
    [t1, payload(t1, { read: read('bearish_lean', T0 - 40 * MIN, t1) })],
    [t2, payload(t2, { read: read('balanced', t2, t2) })],
    [t3, payload(t3, { read: read('bullish_lean', t3, t3) })],
  ], WATCH);
  assert.equal(s.queue.length, 1);
  assert.equal(s.queue[0].stateKey, 'bullish_lean');
  assert.match(s.queue[0].text, /now a bullish lean .* from balanced, range-bound/);
});

test('a real flip back after being said is said again — state changes are not swallowed by a dedupe timer', () => {
  let s = initialCommentaryState();
  const said: string[] = [];
  const leans: Lean[] = ['bearish_lean', 'bullish_lean', 'bearish_lean', 'bullish_lean'];
  leans.forEach((lean, i) => {
    const now = T0 + i * 50 * S;          // 50 s apart: past the Watch cooldown each time
    s = observeCommentary(s, payload(now, { read: read(lean, now, now) }), now, WATCH).state;
    const r = takeNextCommentary(s, now, WATCH); s = r.state;
    if (r.item) said.push(r.item.stateKey!);
  });
  assert.deepEqual(said, ['bullish_lean', 'bearish_lean', 'bullish_lean']);
});

test('the queue is capped; the least important item goes first', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const evs = Array.from({ length: 9 }, (_, i) => ({
    key: `acc${i}`, at: t2, code: 'LEVEL_ACCEPTANCE', detail: `Accepted ${4300 + i * 10}.`, channel: 'voice',
    level: { price: 4300 + i * 10 }, data: {},
  }));
  const { s, cancelled } = run([[t1, payload(t1, { events: [] })], [t2, payload(t2, {
    events: [...evs, { key: 'brk', at: t2, code: 'STRUCTURE_BREAK', detail: 'Structure broke down.', data: { direction: 'down' } }],
  })]], COPILOT);
  assert.equal(s.queue.length, MAX_QUEUE);
  assert.ok(s.queue.some((i) => i.kind === 'structure'), 'the structure break outranks unwatched level noise');
  assert.ok(cancelled.length >= 4);
});

/* ── pacing per mode ──────────────────────────────────────────────────────────────────────────────── */

function queueTwo(settings: CommentarySettings) {
  const t1 = T0, t2 = T0 + 30 * S;
  return run([[t1, payload(t1, { events: [], scenarios: [scenario('a', 'developing', t1 - MIN)] })], [t2, payload(t2, {
    scenarios: [scenario('a', 'confirmed', t2)],
    events: [{ key: 'b', at: t2, code: 'STRUCTURE_BREAK', detail: 'Structure broke down.', data: { direction: 'down' } }],
  })]], settings).s;
}

/** The page keeps polling: a fresh payload that changes nothing, so market items stay deliverable. */
const fresh = (s: CommentaryState, now: number, settings: CommentarySettings) =>
  observeCommentary(s, payload(now, { scenarios: [scenario('a', 'confirmed', T0 + 30 * S)] }), now, settings).state;

test('Watch: one item, then nothing until its cooldown has passed', () => {
  let s = queueTwo(WATCH);
  const now = T0 + 31 * S;
  let r = takeNextCommentary(s, now, WATCH); s = r.state;
  assert.equal(r.item?.kind, 'scenario', 'the most important first');
  s = fresh(s, now + WATCH_COOLDOWN_MS - S, WATCH);
  r = takeNextCommentary(s, now + WATCH_COOLDOWN_MS - S, WATCH); s = r.state;
  assert.equal(r.item, null);
  s = fresh(s, now + WATCH_COOLDOWN_MS, WATCH);
  r = takeNextCommentary(s, now + WATCH_COOLDOWN_MS, WATCH); s = r.state;
  assert.equal(r.item?.kind, 'structure');
});

test('Session copilot: the cooldown is the member\'s commentary-frequency setting', () => {
  assert.equal(commentaryCooldownMs(COPILOT), 120_000);
  assert.equal(commentaryCooldownMs({ mode: 'copilot', copilotCooldownMs: 1 }), 15_000, 'clamped: never machine-gun');
  let s = queueTwo(COPILOT);
  const now = T0 + 31 * S;
  let r = takeNextCommentary(s, now, COPILOT); s = r.state;
  assert.ok(r.item);
  s = fresh(s, now + 119 * S, COPILOT);
  r = takeNextCommentary(s, now + 119 * S, COPILOT); s = r.state;
  assert.equal(r.item, null);
  s = fresh(s, now + 120 * S, COPILOT);
  r = takeNextCommentary(s, now + 120 * S, COPILOT);
  assert.equal(r.item?.kind, 'structure');
});

test('Quiet volunteers nothing, and switching modes drops what the new mode would not say', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const quiet = run([[t1, payload(t1, { read: read('bullish_lean', T0 - 40 * MIN, t1) })], [t2, payload(t2, { read: read('bearish_lean', t2, t2) })]], QUIET);
  assert.equal(quiet.added.length, 0);
  assert.equal(quiet.s.announced.lean, 'bearish_lean', 'the change is on screen, so it is the state the member knows');
  assert.equal(commentaryCooldownMs(QUIET), Number.POSITIVE_INFINITY);

  const s = queueTwo(COPILOT);
  const withDeveloping = observeCommentary(s, payload(T0 + 40 * S, { scenarios: [scenario('d', 'watching', T0)] }), T0 + 40 * S, COPILOT).state;
  const toWatch = retuneCommentary(withDeveloping, WATCH);
  assert.ok(toWatch.queue.every((i) => i.modes.includes('watch')));
  assert.equal(retuneCommentary(s, QUIET).queue.length, 0);
  const r = takeNextCommentary(s, T0 + 31 * S, QUIET);
  assert.equal(r.item, null);
  assert.equal(r.state.queue.length, 0);
});

test('an urgent item may jump the cooldown, but never inside the urgent floor', () => {
  let s = queueTwo(COPILOT);
  let now = T0 + 31 * S;
  s = takeNextCommentary(s, now, COPILOT).state;                 // something was just said
  // News four minutes out: urgent.
  now += 5 * S;
  s = observeCommentary(s, payload(now, { intel: { news: { name: 'NFP', at: now + 4 * MIN, importance: 'high', minutesTo: 4 } } }), now, COPILOT).state;
  assert.equal(takeNextCommentary(s, now, COPILOT).item, null, 'inside the 15 s floor');
  const r = takeNextCommentary(s, T0 + 31 * S + URGENT_FLOOR_MS, COPILOT);
  assert.equal(r.item?.kind, 'news', 'past the floor, ahead of the two-minute copilot cooldown');
});

test('Session copilot adds a short status line when the desk has been quiet; Watch never does', () => {
  const settings: CommentarySettings = { mode: 'copilot', copilotCooldownMs: 30_000 };
  const every = statusEveryMs(settings);
  const t1 = T0;
  let s = observeCommentary(initialCommentaryState(), payload(t1), t1, settings).state;
  const t2 = t1 + every;
  const r = observeCommentary(s, payload(t2), t2, settings);
  assert.equal(r.added.length, 1);
  assert.match(r.added[0].text, /^Status check — Bearish lean on the 15-minute/);
  s = run([[t1, payload(t1)], [t2, payload(t2)]], WATCH).s;
  assert.equal(s.queue.length, 0);
});

/* ── the feed: stale is said, and nothing is narrated as current ─────────────────────────────────────── */

const staleFeed = (now: number, ageMs = 95_000) => ({ ...liveFeed(now), status: 'stale' as const, ageMs, reason: 'no tick for 95 s' });

test('a stale feed cancels waiting market commentary, holds new market items, and says so once it holds', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  // A lean change is waiting to be said…
  let { s } = run([
    [t1, payload(t1, { read: read('bullish_lean', T0 - 40 * MIN, t1) })],
    [t2, payload(t2, { read: read('bearish_lean', t2, t2) })],
  ], WATCH);
  assert.equal(s.queue.length, 1);
  // …when the feed goes stale. It is cancelled at once: it can no longer be vouched for.
  const t3 = t2 + 5 * S;
  let r = observeCommentary(s, payload(t3, { feed: staleFeed(t3), read: read('bearish_lean', t2, t2) }), t3, WATCH);
  s = r.state;
  assert.deepEqual(r.cancelled.map((i) => i.kind), ['lean']);
  assert.equal(s.queue.length, 0, 'nothing announced yet: one bad poll is not an outage');
  // New market events while stale are not queued.
  const t4 = t3 + 5 * S;
  r = observeCommentary(s, payload(t4, { feed: staleFeed(t4), read: read('balanced', t4, t4), events: [{ key: 'x', at: t4, code: 'STRUCTURE_BREAK', detail: 'broke', data: { direction: 'up' } }] }), t4, WATCH);
  s = r.state;
  assert.ok(r.added.every((i) => i.kind === 'feed'));
  // Once it has held past the debounce, ATLAS says the feed is stale instead of narrating.
  const t5 = t3 + FEED_DEBOUNCE_MS;
  r = observeCommentary(s, payload(t5, { feed: staleFeed(t5), read: read('balanced', t4, t4) }), t5, WATCH);
  s = r.state;
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].kind, 'feed');
  assert.match(r.added[0].text, /price feed has gone stale; the last price is 95 seconds old\. I'll hold market commentary/);
  const said = takeNextCommentary(s, t5, WATCH);
  assert.equal(said.item?.kind, 'feed');
  assert.ok(said.item!.priority >= 90, 'urgent');
  s = said.state;
  // Recovery: said once it holds, carrying the CURRENT read — the lean that moved while the feed was down is
  // not narrated after the fact as though it had just happened.
  const t6 = t5 + 20 * S, t7 = t6 + FEED_DEBOUNCE_MS;
  s = observeCommentary(s, payload(t6, { read: read('balanced', t4, t6) }), t6, WATCH).state;
  r = observeCommentary(s, payload(t7, { read: read('balanced', t4, t7) }), t7, WATCH);
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].text, 'The price feed is live again. Current read: balanced, range-bound on the 15-minute.');
  assert.ok(r.state.queue.every((i) => i.kind !== 'lean'));
});

test('a feed blip shorter than the debounce is never mentioned', () => {
  const t1 = T0, t2 = T0 + 5 * S, t3 = T0 + 9 * S, t4 = T0 + 30 * S;
  const { s, added } = run([
    [t1, payload(t1)], [t2, payload(t2, { feed: staleFeed(t2) })], [t3, payload(t3)], [t4, payload(t4)],
  ], WATCH);
  assert.equal(added.length, 0);
  assert.equal(s.queue.length, 0);
});

test('stale then recovered before the notice was said: the two cancel out', () => {
  const t1 = T0, t2 = T0 + 5 * S, t3 = t2 + FEED_DEBOUNCE_MS, t4 = t3 + 5 * S, t5 = t4 + FEED_DEBOUNCE_MS;
  const { s } = run([
    [t1, payload(t1)], [t2, payload(t2, { feed: staleFeed(t2) })], [t3, payload(t3, { feed: staleFeed(t3) })],
    [t4, payload(t4)], [t5, payload(t5)],
  ], WATCH);
  assert.equal(s.queue.length, 0, 'the member was never told it was stale, so there is nothing to un-tell');
});

test('without the feed contract, the legacy fields still say stale and closed honestly', () => {
  assert.equal(feedViewOf({ connected: false, marketOpen: true, reason: 'The last market read was 7 minutes ago.', ageSeconds: 420 }).cls, 'degraded');
  assert.equal(feedViewOf({ connected: true, marketOpen: false }).cls, 'closed');
  assert.equal(feedViewOf({ connected: true, marketOpen: true, live: true }).cls, 'ok');
  assert.equal(feedViewOf({ replay: true }).cls, 'demo');
  // The contract decides when present: DELAYED is a working feed, RECONNECTING is not.
  assert.equal(feedViewOf({ feed: { status: 'delayed' } }).cls, 'ok');
  assert.equal(feedViewOf({ feed: { status: 'reconnecting' } }).cls, 'degraded');
  assert.equal(feedViewOf({ feed: { status: 'live' }, analysis: { analysisAgeMs: ANALYSIS_STALE_MS + 1 } }).why, 'analysis');

  const t1 = T0, t2 = T0 + 30 * S, t3 = t2 + FEED_DEBOUNCE_MS;
  const legacy = (now: number, extra: Partial<CommentaryInput>) => ({ ...payload(now), feed: undefined, ...extra });
  const { added } = run([
    [t1, legacy(t1, {})], [t2, legacy(t2, { marketOpen: false })], [t3, legacy(t3, { marketOpen: false })],
  ], WATCH);
  assert.deepEqual(added.map((i) => i.text), ['Gold is closed now. I\'ll stay quiet until it reopens.']);
});

test('when payloads stop arriving, market items are held rather than said from an old picture', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const { s } = run([
    [t1, payload(t1, { read: read('bullish_lean', T0 - 40 * MIN, t1) })],
    [t2, payload(t2, { read: read('bearish_lean', t2, t2), intel: { news: { name: 'US CPI', at: t2 + 14 * MIN, importance: 'high', minutesTo: 14 } } })],
  ], WATCH);
  const later = t2 + INPUT_STALE_MS + S;
  const r = takeNextCommentary(s, later, WATCH);
  assert.equal(r.item?.kind, 'news', 'a calendar fact is still true');
  const r2 = takeNextCommentary(r.state, later + WATCH_COOLDOWN_MS, WATCH);
  assert.equal(r2.item, null, 'the lean change waits for a fresh payload');
  assert.equal(r2.state.queue.length, 1);
});

/* ── robustness ───────────────────────────────────────────────────────────────────────────────────── */

test('missing or malformed contract fields are ignored, never thrown on', () => {
  const t1 = T0, t2 = T0 + 30 * S;
  const junk = { read: { lean: 'sideways' }, scenarios: [{ id: 3 }, null, { id: 'x', status: 'weird' }], events: [null, { code: 'X' }, 'nope'] } as unknown as CommentaryInput;
  const { added } = run([[t1, payload(t1)], [t2, { ...payload(t2), ...junk }]], COPILOT);
  assert.equal(added.length, 0);
  const s = observeCommentary(initialCommentaryState(), { ok: false } as CommentaryInput, t1, WATCH).state;
  assert.equal(s.started, false, 'an error payload is not a market picture');
  assert.doesNotThrow(() => observeCommentary(initialCommentaryState(), null, t1, WATCH));
});

/* ── the volunteered turn ─────────────────────────────────────────────────────────────────────────── */

test('a volunteered line is marked for the voice endpoint, cleaned, and bounded', () => {
  const turn = volunteeredTurn('Read change: now a **bearish** lean.\u0007 [[UI:SHOW_LEVEL]]');
  assert.ok(turn.startsWith(VOLUNTEERED_MARK));
  assert.ok(isVolunteeredTurn(turn));
  assert.equal(parseVolunteeredTurn(turn), 'Read change: now a bearish lean.');
  assert.equal(parseVolunteeredTurn('what is gold doing?'), null, 'the trader\'s own words are never a volunteered line');
  assert.equal(parseVolunteeredTurn(`${VOLUNTEERED_MARK}   `), null, 'nothing to say is not a line');
  assert.ok((parseVolunteeredTurn(`${VOLUNTEERED_MARK} ${'a'.repeat(2000)}`) ?? '').length <= VOLUNTEERED_MAX_CHARS);
});
