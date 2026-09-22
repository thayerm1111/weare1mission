import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../command-center/engines/snapshot';
import {
  findSetup, stillValid, candidatesOn, styleFits, article,
  DEFAULT_SETUP_PROFILE, type SetupProfile,
} from '../command-center/engines/setup';
import { experienceOf, completionRead, COMPLETE_WINDOW_MS } from '../command-center/engines/experience';
import { managementPermissions, DEFAULT_PROFILE, asSetupProfile, limitsForMode } from '../command-center/engines/profile';
import { replay } from '../command-center/engines/replay';
import { STYLE } from '../command-center/core/style';
import type { Bar, MarketSnapshot } from '../command-center/core/types';

const M = 60_000;

/**
 * Anchored to the most recent WEEKDAY London afternoon, not to `Date.now()`.
 *
 * Bars are built relative to this, so the freshness gates still behave exactly as they do in production —
 * but the session clock does not fire `market_closed` when these tests happen to run at a weekend. The
 * first version of this file used Date.now() and every assertion about a no-trade turned into an
 * assertion about it being Saturday.
 */
const NOW = (() => {
  const d = new Date();
  d.setUTCHours(14, 0, 0, 0);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || d.getTime() > Date.now()) d.setUTCDate(d.getUTCDate() - 1);
  return d.getTime();
})();
const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c });

/** A rising series with real pullbacks, so structure and pivots actually exist. */
function trend(n: number, start: number, drift: number, noise = 1.4): Bar[] {
  const out: Bar[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const w = Math.sin(i / 6) * noise * 2;
    const o = p;
    const c = p + drift + w * 0.4;
    out.push(bar(NOW - (n - i) * 5 * M, o, Math.max(o, c) + noise, Math.min(o, c) - noise, c));
    p = c;
  }
  return out;
}

/** A flat, noisy series: the middle of a range, where ATLAS is supposed to say no. */
function chop(n: number, mid: number, noise = 1.1): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = mid + Math.sin(i / 3) * noise;
    const c = mid + Math.sin((i + 1) / 3) * noise;
    out.push(bar(NOW - (n - i) * 5 * M, o, Math.max(o, c) + noise, Math.min(o, c) - noise, c));
  }
  return out;
}

const snap = (bars: Bar[], price?: number): MarketSnapshot => buildSnapshot({
  now: NOW + 5 * M,
  bars: { '5m': bars, '15m': bars, '1h': bars, '4h': bars },
  price: price ?? bars[bars.length - 1].c,
  feeds: [{ feed: 'twelvedata', state: 'live', lastTickMs: bars[bars.length - 1].t, ageMs: 4_000 }],
});

/* ═══════════════ ATLAS decides, the member approves ═══════════════ */

test('a setup is never produced from a snapshot ATLAS cannot see', () => {
  const none = findSetup({ snapshot: null });
  assert.equal(none.state, 'blocked');
  assert.equal(none.side, null);
  assert.equal(none.stop, null, 'a blocked read must not carry numbers anybody could act on');
});

test('a closed market is a stand-down, not a no-trade', () => {
  const s = findSetup({ snapshot: snap(trend(120, 4300, 0.9)), marketOpen: false });
  assert.equal(s.state, 'blocked');
  assert.match(s.say, /closed/i);
});

test('a blocker on the snapshot stops the search and quotes its reason', () => {
  const s = snap(chop(120, 4350));
  s.blockers = [{ code: 'chaotic', detail: 'Market is chaotic — no strategy is eligible' }];
  const out = findSetup({ snapshot: s });
  assert.equal(out.state, 'blocked');
  assert.match(out.say, /chaotic/i);
});

test('the middle of a range produces NO TRADE, with what would change it', () => {
  const out = findSetup({ snapshot: snap(chop(140, 4350)) });
  assert.ok(['no_setup', 'watching'].includes(out.state), `expected a refusal, got ${out.state}`);
  assert.ok(out.say.length > 30, 'a refusal has to explain itself');
});

test('every trade style switched off means ATLAS has nothing it is allowed to take', () => {
  const off: SetupProfile = { allowQuick: false, allowHold: false, allowSwing: false, minConfidence: 55 };
  const out = findSetup({ snapshot: snap(trend(140, 4300, 1.1)), profile: off });
  assert.equal(out.state, 'blocked');
  assert.match(out.say, /switched off/i);
});

/* ═══════════════ the style is an output, not an input ═══════════════ */

test('a style may only be chosen when it listens to the timeframe the candidate was found on', () => {
  const s = snap(trend(140, 4300, 1.1));
  // A candidate found on the DAILY must never come back as a QUICK trade: quick decides on 1m and 5m.
  const fits = styleFits(s, 'buy', DEFAULT_SETUP_PROFILE, '1d');
  for (const f of fits) {
    const pol = STYLE[f.style];
    assert.ok(
      pol.decisive.includes('1d') || pol.context.includes('1d'),
      `${f.style} does not listen to the daily and must not have been offered for a daily candidate`,
    );
  }
});

test('a missing timeframe is a penalty that is said out loud, never a silent veto', () => {
  // Only 5m present. Before this was fixed, every style was excluded at once and ATLAS blamed the
  // market for its own blind spot.
  const bars = trend(140, 4300, 1.1);
  const s = buildSnapshot({
    now: NOW + 5 * M, bars: { '5m': bars }, price: bars[bars.length - 1].c,
    feeds: [{ feed: 'twelvedata', state: 'live', lastTickMs: bars[bars.length - 1].t, ageMs: 4_000 }],
  });
  const fits = styleFits(s, 'buy', DEFAULT_SETUP_PROFILE, '5m');
  if (fits.length) {
    assert.ok(
      fits.some((f) => /can't read|cannot read/i.test(f.why)),
      'a half-blind judgement has to admit which chart it could not read',
    );
  }
});

test('article() reads like a person wrote it', () => {
  assert.equal(article('INTRADAY'), 'an');
  assert.equal(article('QUICK'), 'a');
  assert.equal(article('SWING'), 'a');
});

/* ═══════════════ the arithmetic has to be worth doing ═══════════════ */

test('ATLAS refuses to risk more than the first objective is worth', () => {
  // Real recorded gold produced exactly this: a 107-pip stop aiming at a level 28 pips away, offered as
  // TRADE READY with ninety confidence. Being right about direction does not rescue that arithmetic.
  const bars = trend(160, 4300, 1.4);
  const s = snap(bars);
  const price = s.price;
  // Put a major level immediately in front of price, far closer than any sensible stop.
  s.levels = [
    { price: +(price + 0.6).toFixed(2), kind: 'ny_high', label: 'New York high' },
    { price: +(price - 30).toFixed(2), kind: 'pdl', label: 'Previous day low' },
  ];
  const out = findSetup({ snapshot: s });
  assert.notEqual(out.state, 'trade_ready', 'a trade into an immediate level is not a trade');
  if (out.side) assert.match(out.say, /risking|only .* pips away|wait/i);
});

test('an objective is never closer than one R', () => {
  const { snapshot, diffs } = replay(40, false, 57);
  const out = findSetup({ snapshot, diffs, marketOpen: true, now: snapshot.at });
  if (out.state === 'trade_ready' || out.state === 'waiting_for_trigger') {
    assert.ok(out.stopPips && out.expectedMovePips, 'a live setup carries its own numbers');
    const r = out.expectedMovePips![0] / out.stopPips!;
    assert.ok(r >= 0.98, `first objective was only ${r.toFixed(2)}R away`);
  }
});

test('a stop is never inside the style noise floor, nor past its ceiling', () => {
  for (let off = 0; off <= 130; off += 7) {
    let r;
    try { r = replay(40, false, off); } catch { continue; }
    const out = findSetup({ snapshot: r.snapshot, diffs: r.diffs, marketOpen: true, now: r.snapshot.at });
    if (!out.style || out.stopPips == null) continue;
    const pol = STYLE[out.style];
    assert.ok(out.stopPips >= pol.noiseFloorPips * 0.5, `${out.style} stop ${out.stopPips}p is inside its own noise`);
    assert.ok(out.stopPips <= pol.maxStopPips, `${out.style} stop ${out.stopPips}p is past its ceiling of ${pol.maxStopPips}`);
  }
});

/* ═══════════════ conditions, and the ladder to READY ═══════════════ */

test('TRADE READY requires every condition, and the trigger is always last', () => {
  for (let off = 0; off <= 130; off += 3) {
    let r;
    try { r = replay(40, false, off); } catch { continue; }
    const out = findSetup({ snapshot: r.snapshot, diffs: r.diffs, marketOpen: true, now: r.snapshot.at });
    if (out.state === 'trade_ready') {
      assert.equal(out.metCount, out.totalCount, 'READY with an unmet condition is a lie');
      assert.ok(out.conditions.some((c) => c.trigger), 'a ready setup must have had a trigger to clear');
    }
    if (out.state === 'waiting_for_trigger') {
      const nonTrigger = out.conditions.filter((c) => !c.trigger);
      assert.ok(nonTrigger.every((c) => c.met), 'waiting for the TRIGGER means everything else is already true');
    }
  }
});

test('every condition carries the measurement behind it', () => {
  const { snapshot, diffs } = replay(40, false, 20);
  const out = findSetup({ snapshot, diffs, marketOpen: true, now: snapshot.at });
  for (const c of out.conditions) {
    assert.ok(c.text.length > 4, 'a condition has to be readable');
    assert.ok(c.detail.length > 4, 'a member must be able to check it on their own chart');
  }
});

/* ═══════════════ it does not argue with itself ═══════════════ */

test('a setup against the standing thesis has to clear a higher bar and say so', () => {
  for (let off = 0; off <= 130; off += 5) {
    let r;
    try { r = replay(40, false, off); } catch { continue; }
    const plain = findSetup({ snapshot: r.snapshot, diffs: r.diffs, marketOpen: true, now: r.snapshot.at });
    if (!plain.side) continue;
    const opposed = plain.side === 'buy' ? 'bearish_continuation' : 'bullish_continuation';
    const against = findSetup({
      snapshot: r.snapshot, diffs: r.diffs, marketOpen: true, now: r.snapshot.at,
      thesisBias: opposed, thesisConfidence: 80,
    });
    if (against.side !== plain.side) continue;
    assert.match(against.say, /argues against|against my current/i, 'it has to admit it is arguing with the house view');
    if (plain.state === 'trade_ready') {
      assert.ok(
        against.state === 'trade_ready' ? against.confidence >= 70 : true,
        'a counter-thesis trade only stays READY when it is convincing',
      );
    }
    return;
  }
});

/* ═══════════════ approval is for a SPECIFIC trade ═══════════════ */

test('a setup that is not ready can never be taken', () => {
  const s = findSetup({ snapshot: snap(chop(140, 4350)) });
  const v = stillValid(s, snap(chop(140, 4350)));
  assert.equal(v.ok, false);
});

test('a setup is dead once price has gone back through its invalidation', () => {
  const { snapshot, diffs } = replay(40, false, 57);
  const out = findSetup({ snapshot, diffs, marketOpen: true, now: snapshot.at });
  if (!out.side || out.invalidationPrice == null) return;
  const moved: MarketSnapshot = {
    ...snapshot,
    price: out.side === 'buy' ? out.invalidationPrice - 1 : out.invalidationPrice + 1,
  };
  const ready = { ...out, state: 'trade_ready' as const };
  const v = stillValid(ready, moved, out.at);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.state, 'setup_invalidated');
});

test('a setup expires rather than being executed on a stale screen', () => {
  const { snapshot, diffs } = replay(40, false, 57);
  const out = findSetup({ snapshot, diffs, marketOpen: true, now: snapshot.at });
  if (!out.side) return;
  const ready = { ...out, state: 'trade_ready' as const };
  const v = stillValid(ready, snapshot, (out.expiresAt ?? out.at) + 1);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.state, 'setup_expired');
});

test('gold moving away from the entry makes it a different trade', () => {
  const { snapshot, diffs } = replay(40, false, 57);
  const out = findSetup({ snapshot, diffs, marketOpen: true, now: snapshot.at });
  if (!out.side || out.stop == null || out.entryHigh == null) return;
  const mid = (out.entryHigh + (out.entryLow ?? out.entryHigh)) / 2;
  const risk = Math.abs(mid - out.stop);
  const ran: MarketSnapshot = { ...snapshot, price: mid + (out.side === 'buy' ? risk : -risk) };
  const v = stillValid({ ...out, state: 'trade_ready' }, ran, out.at);
  assert.equal(v.ok, false, 'an entry that has run away is not the trade the member approved');
});

/* ═══════════════ the experience state machine ═══════════════ */

const base = {
  setup: null, tradeActive: false, characterState: null, protectionAction: null,
  beyondBreakEven: false, exiting: false, pending: null, completed: null,
};

test('an accepted order is NOT a position', () => {
  const e = experienceOf({
    ...base,
    pending: { executionId: 'x', state: 'order_accepted', at: Date.now(), uncertain: false },
  });
  assert.equal(e.state, 'order_pending');
  assert.equal(e.tradeLens, false, 'the trade lens must not open before the broker confirms a fill');
  assert.match(e.note!, /confirming the fill/i);
});

test('an uncertain order goes to checking, never to sending again', () => {
  const e = experienceOf({
    ...base,
    pending: { executionId: 'x', state: 'reconciliation_required', at: Date.now(), uncertain: true },
  });
  assert.equal(e.state, 'order_pending');
  assert.match(e.note!, /rather than sending anything else/i);
});

test('only a confirmed position opens the trade lens', () => {
  const e = experienceOf({ ...base, tradeActive: true });
  assert.equal(e.state, 'position_active');
  assert.equal(e.tradeLens, true);
  assert.equal(e.focus, 'locked');
});

test('a protected position reads as calm, a weakening one as alert', () => {
  const prot = experienceOf({ ...base, tradeActive: true, beyondBreakEven: true });
  assert.equal(prot.state, 'position_protected');
  assert.equal(prot.focus, 'calm');

  const weak = experienceOf({ ...base, tradeActive: true, characterState: 'character_change' });
  assert.equal(weak.state, 'position_weakening');
  assert.equal(weak.focus, 'alert');
});

test('a close request shows as exiting, and outranks everything else about the position', () => {
  const e = experienceOf({ ...base, tradeActive: true, exiting: true, beyondBreakEven: true });
  assert.equal(e.state, 'position_exiting');
});

test('a finished trade is shown, then let go', () => {
  const done = {
    at: Date.now(), side: 'buy' as const, style: 'hold', pips: 94, r: 1.28, money: 470,
    mfePips: 121, maePips: -11, heldMs: 38 * M, entry: 4382.4, exit: 4391.8, exitReason: null, say: 'x',
  };
  const fresh = experienceOf({ ...base, completed: done });
  assert.equal(fresh.state, 'trade_complete');
  assert.ok(fresh.completed);

  const later = experienceOf({ ...base, completed: done, now: done.at + COMPLETE_WINDOW_MS * 0.8 });
  assert.equal(later.state, 'returning_to_market');

  const gone = experienceOf({ ...base, completed: done, now: done.at + COMPLETE_WINDOW_MS + 1 });
  assert.equal(gone.state, 'market_observing');
  assert.equal(gone.completed, null);
});

test('with no position and no order, the setup drives the state', () => {
  const ready = experienceOf({ ...base, setup: { state: 'trade_ready', headline: 'TRADE READY' } as never });
  assert.equal(ready.state, 'trade_preparing');
  const watching = experienceOf({ ...base, setup: { state: 'watching', headline: 'WATCHING LONG' } as never });
  assert.equal(watching.state, 'setup_watching');
  const nothing = experienceOf({ ...base, setup: { state: 'no_setup', headline: 'NO TRADE' } as never });
  assert.equal(nothing.state, 'market_observing');
});

/* ═══════════════ the completion read is honest about a loss ═══════════════ */

test('a losing trade is described as a losing trade', () => {
  const say = completionRead({
    at: Date.now(), side: 'buy', style: 'quick', pips: -41, r: -1, money: -205,
    mfePips: 28, maePips: -44, heldMs: 17 * M, entry: 4380, exit: 4375.9, exitReason: null,
  });
  assert.match(say, /didn't work/i);
  assert.match(say, /never protected/i, 'giving back 28 pips of profit is the lesson, and it has to be stated');
});

test('a winner that kept most of the move says so, and one that gave it back says that instead', () => {
  const kept = completionRead({
    at: Date.now(), side: 'buy', style: 'hold', pips: 94, r: 1.3, money: 470,
    mfePips: 105, maePips: -8, heldMs: 38 * M, entry: 4380, exit: 4389.4, exitReason: null,
  });
  assert.match(kept, /kept most of the move/i);

  const gaveBack = completionRead({
    at: Date.now(), side: 'buy', style: 'hold', pips: 20, r: 0.3, money: 100,
    mfePips: 120, maePips: -8, heldMs: 38 * M, entry: 4380, exit: 4382, exitReason: null,
  });
  assert.match(gaveBack, /gave back 100/);
});

/* ═══════════════ permissions narrow, they never widen ═══════════════ */

test('AI management off means nothing is permitted, whatever the profile says', () => {
  const p = { ...DEFAULT_PROFILE, allowBreakEven: true, allowPartials: true, allowProfitProtection: true, allowFullClose: true };
  const perms = managementPermissions(p, { ai_close: true }, null, false);
  assert.deepEqual(Object.values(perms), [false, false, false, false, false]);
});

test('the narrower consent always wins', () => {
  const p = { ...DEFAULT_PROFILE, allowBreakEven: true, allowFullClose: true };
  const perms = managementPermissions(p, { close: false }, null, true);
  assert.equal(perms.break_even, true);
  assert.equal(perms.close, false, 'the account said no and the profile does not get to overrule it');

  const positionSaysNo = managementPermissions(p, { close: true }, { close: false }, true);
  assert.equal(positionSaysNo.close, false, 'the position is the narrowest consent of all');
});

test('a fresh profile: entry is still a deliberate yes, and AI Pips is the one management switch (09-22)', () => {
  assert.equal(DEFAULT_PROFILE.autoEntry, false, 'ATLAS never starts trading by itself on a profile nobody configured');
  assert.equal(DEFAULT_PROFILE.allowFullClose, false, 'it never closes a whole position on its own');
  assert.equal(DEFAULT_PROFILE.allowPartials, false, 'partials are not part of AI Pips');
  // One switch — break-even, profit guard and the trail travel together.
  assert.equal(DEFAULT_PROFILE.aiPips, true);
  assert.equal(DEFAULT_PROFILE.allowBreakEven, true);
  assert.equal(DEFAULT_PROFILE.allowProfitProtection, true);
  assert.equal(DEFAULT_PROFILE.autoManagement, true);
  // Every horizon is on: the member no longer picks kinds of trade, ATLAS takes what it sees.
  assert.equal(asSetupProfile(DEFAULT_PROFILE).allowSwing, true);
  assert.equal(asSetupProfile(DEFAULT_PROFILE).allowQuick, true);
  assert.equal(asSetupProfile(DEFAULT_PROFILE).allowHold, true);
});
test('safety mode is the only per-member limit: conservative stops 2 hours after 2 losses in a row', () => {
  assert.deepEqual(limitsForMode({ ...DEFAULT_PROFILE, riskMode: 'conservative' }), { maxConsecutiveLosses: 2, streakWindowMs: 2 * 60 * 60 * 1000 });
  assert.deepEqual(limitsForMode({ ...DEFAULT_PROFILE, riskMode: 'aggressive' }), { maxConsecutiveLosses: null, streakWindowMs: null });
});

/* ═══════════════ replaying REAL recorded gold ═══════════════ */

test('over a real recorded session ATLAS behaves like a trader, not a slot machine', () => {
  const counts: Record<string, number> = {};
  for (let off = 0; off <= 140; off++) {
    let r;
    try { r = replay(40, false, off); } catch { continue; }
    const out = findSetup({ snapshot: r.snapshot, diffs: r.diffs, marketOpen: true, now: r.snapshot.at });
    counts[out.state] = (counts[out.state] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const ready = counts.trade_ready ?? 0;
  const quiet = (counts.no_setup ?? 0) + (counts.blocked ?? 0) + (counts.watching ?? 0);

  assert.ok(total > 100, 'the replay has to actually cover the session');
  assert.ok(ready < total * 0.15, `called ${ready} trades in ${total} bars — that is a slot machine, not a trader`);
  assert.ok(quiet > total * 0.4, 'a trader spends most of a session not trading, and this one must too');
});

test('candidates are only produced where the evidence for them exists', () => {
  const { snapshot } = replay(40, false, 70);     // a chaotic, low-efficiency stretch
  const all = (['5m', '15m', '1h', '4h'] as const).flatMap((t) => candidatesOn(snapshot, t));
  for (const c of all) {
    assert.ok(c.atr > 0, 'a candidate without a real ATR has nothing to size a stop from');
    assert.ok(Number.isFinite(c.shelter), 'a candidate must have a real structural shelter');
    assert.ok(c.reason.length > 10, 'a candidate has to be able to explain itself');
  }
});

/* ═══════════════ the three horizons ═══════════════ */

test('a horizon is an opportunity band, and a move is labelled by the band it belongs to', async () => {
  const { horizonForMove, shortfall, STYLE } = await import('../command-center/core/style');
  assert.equal(horizonForMove(60), 'quick', '60 pips is a QUICK move');
  assert.equal(horizonForMove(400), 'hold', '400 pips is a HOLD');
  assert.equal(horizonForMove(700), 'swing', '700 pips is a SWING');
  assert.equal(horizonForMove(12), null, 'a twelve-pip move is not any of them');

  // HOLD is open-ended upward, so a large move still qualifies for it when SWING is not allowed.
  assert.equal(horizonForMove(700, ['quick', 'hold']), 'hold');

  assert.equal(shortfall('quick', 60), 0, 'a move inside the band has no shortfall');
  assert.ok(shortfall('hold', 100) > 0.6, '100 pips is a long way short of what HOLD is for');
  assert.equal(STYLE.hold.opportunityPips[1], null, 'HOLD is deliberately open-ended above 300');
});

test('HOLD decides on the 15-minute and hourly, not the five-minute it used to', async () => {
  const { STYLE } = await import('../command-center/core/style');
  assert.deepEqual(STYLE.hold.decisive, ['15m', '1h']);
  assert.ok(STYLE.hold.context.includes('4h'), 'the four-hour is the frame');
  assert.ok(STYLE.hold.maxStopPips > STYLE.quick.maxStopPips, 'a 300-pip idea cannot use a 100-pip idea stop');
  assert.ok(STYLE.hold.noiseFloorPips > STYLE.quick.noiseFloorPips);
});

test('a style stored under the old name is still read, never silently reinterpreted', async () => {
  const { styleOf } = await import('../command-center/core/style');
  assert.equal(styleOf('intraday'), 'hold', 'old rows must keep resolving');
  assert.equal(styleOf('scalp'), 'quick');
  assert.equal(styleOf('hold'), 'hold');
  assert.equal(styleOf(null), 'hold');
});

test('ATLAS refuses to widen a stop to make a small move fit a bigger label', () => {
  // Walk the recording and assert the invariant everywhere it produced a trade: whatever horizon it
  // chose, the room it actually found is not wildly short of what that horizon exists for.
  for (let off = 0; off <= 130; off += 3) {
    let r;
    try { r = replay(40, false, off); } catch { continue; }
    const out = findSetup({ snapshot: r.snapshot, diffs: r.diffs, marketOpen: true, now: r.snapshot.at });
    if (!out.style || !out.expectedMovePips) continue;
    const band = STYLE[out.style].opportunityPips[0];
    assert.ok(
      out.expectedMovePips[1] >= band * 0.55,
      `labelled ${out.style} (for ${band}+ pips) with only ${out.expectedMovePips[1]} pips of room — that is stretching a label`,
    );
  }
});
