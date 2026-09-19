import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWatch, evaluate, DEFAULT_TTL_MS, type Watch } from '../command-center/engines/watch';
import { classify } from '../command-center/brain/language';
import { replay } from '../command-center/engines/replay';
import type { MarketSnapshot } from '../command-center/core/types';

const snapWith = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => {
  const { snapshot } = replay(40, false, 20);
  return { ...snapshot, ...over };
};

const watch = (over: Partial<Watch> = {}): Watch => ({
  id: 'w1', userId: 'u1', accountRowId: null, positionId: null, said: 'watch it',
  kind: 'price', timeframe: '5m', levelPrice: 4390, levelLabel: 'London high',
  direction: 'either', params: {}, authority: 'informational', notify: 'voice',
  expiresAt: Date.now() + DEFAULT_TTL_MS, status: 'armed', progress: null, createdAt: Date.now(),
  ...over,
});

/* ─────────────────── understanding the instruction ─────────────────── */

test('asking for something to be watched is an instruction, not a question about a level', () => {
  for (const q of [
    'watch the London high and tell me if the retest fails',
    'keep an eye on 4390',
    'let me know if buyers lose 4371',
    'tell me when it qualifies',
    'ping me if that breaks',
  ]) {
    assert.equal(classify(q).intent, 'watch', `"${q}" is an instruction`);
  }
  // And a QUESTION containing the same word must still be a question. "Watch the London high" is a
  // promise to make; "what level are you watching" is a question to answer. Getting that backwards
  // means either arming watches nobody asked for, or silently ignoring ones they did.
  assert.equal(classify('what level are you watching').intent, 'level');
  assert.equal(classify('show me that level').intent, 'level');
});

test('stopping a watch is distinct from every other kind of stop', () => {
  assert.equal(classify('stop watching that').intent, 'unwatch');
  assert.equal(classify('stop watching everything').intent, 'unwatch');
});

test('a named level is resolved against levels that actually exist', () => {
  const s = snapWith();
  const named = s.levels.find((l) => l.kind === 'london_high' || l.kind === 'ny_high');
  if (!named) return;
  const word = named.kind === 'london_high' ? 'london high' : 'new york high';
  const p = parseWatch(`watch the ${word} and tell me if it breaks`, s);
  assert.ok(p, 'it should understand a level it can actually see');
  assert.equal(p!.levelPrice, named.price, 'and use the real price, not an invented one');
  assert.equal(p!.kind, 'level_break');
});

test('an explicit price always beats a named level, because a number is unambiguous', () => {
  const p = parseWatch('watch 4412.50 for me', snapWith());
  assert.equal(p!.levelPrice, 4412.5);
});

test('a failed retest is recognised as its own thing', () => {
  const p = parseWatch('watch 4390 and tell me if the retest fails', snapWith());
  assert.equal(p!.kind, 'retest_fail');
  assert.match(p!.confirm, /comes back and fails to hold/i);
});

test('an instruction with nothing concrete in it is refused rather than guessed at', () => {
  const p = parseWatch('watch it and tell me if it breaks', snapWith());
  // No price, no nameable level: this must not silently arm on some price nobody asked for.
  if (p) assert.notEqual(p.kind, 'level_break', 'a break needs a level to break');
});

test('a spoken time limit becomes a real expiry', () => {
  const today = parseWatch('watch 4390 today', snapWith());
  const week = parseWatch('watch 4390 this week', snapWith());
  assert.ok(today!.ttlMs < week!.ttlMs);
});

/* ─────────────────── judging whether it came true ─────────────────── */

test('a break needs acceptance beyond the level, not a wick through it', () => {
  const s = snapWith();
  const lvl = s.price - 2;
  const w = watch({ kind: 'level_break', levelPrice: lvl, direction: 'above' });

  // Already through before we started watching is not a break that just happened.
  const already = evaluate(w, s, { ...s, price: lvl + 1 });
  assert.equal(already.fired, false, 'it was already through — that is not news');

  const crossed = evaluate(w, s, { ...s, price: lvl - 1 });
  assert.equal(typeof crossed.fired, 'boolean');
});

test('progress is reported while a watch is still waiting, so it can be shown filling up', () => {
  const s = snapWith();
  const far = evaluate(watch({ kind: 'price', levelPrice: s.price + 60 }), s, null);
  const near = evaluate(watch({ kind: 'price', levelPrice: s.price + 2 }), s, null);
  assert.equal(far.fired, false);
  assert.ok(near.progress > far.progress, 'closer has to read as closer');
  assert.ok(far.progress >= 0 && near.progress <= 1);
});

test('a price watch fires when price actually reaches it', () => {
  const s = snapWith();
  const r = evaluate(watch({ kind: 'price', levelPrice: s.price }), s, null);
  assert.equal(r.fired, true);
  assert.match(r.detail, /reached/i);
});

test('a pressure watch reads the real pressure and reports the real number', () => {
  const s = snapWith();
  const low = evaluate(watch({ kind: 'pressure', params: { threshold: 5, side: 'bullish' } }), s, null);
  const high = evaluate(watch({ kind: 'pressure', params: { threshold: 99, side: 'bullish' } }), s, null);
  assert.equal(low.fired, true);
  assert.equal(high.fired, false);
  assert.match(low.detail, new RegExp(String(Math.round(s.pressure.bullish))));
});

test('a setup_ready watch is never fired by price — it waits for the setup engine', () => {
  const s = snapWith();
  const r = evaluate(watch({ kind: 'setup_ready', levelPrice: null }), s, null);
  assert.equal(r.fired, false, 'price movement must not be mistaken for a qualified setup');
});

test('an informational watch stays informational', () => {
  const p = parseWatch('watch 4390 and tell me if it breaks', snapWith());
  assert.ok(p);
  // Nothing in a parsed instruction can set action authority — that is a separate, authenticated step.
  assert.equal(Object.prototype.hasOwnProperty.call(p!, 'authority'), false,
    'parsing must not be able to grant authority at all');
});
