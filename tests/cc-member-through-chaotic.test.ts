import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replay } from '../command-center/engines/replay';
import { validate, type ValidateInput } from '../command-center/engines/validator';
import { tradeable, tradeableFor, MEMBER_PASSABLE } from '../command-center/engines/snapshot';
import { findSetup, stillValid } from '../command-center/engines/setup';
import { DEFAULT_PROFILE, asSetupProfile } from '../command-center/engines/profile';
import { buildIdea } from '../command-center/engines/idea';
import { inWeekendCloseWindow } from '../command-center/core/sessions';
import type { BlockerCode, MarketSnapshot } from '../command-center/core/types';

/*
 * A MEMBER'S OWN ORDER GOES THROUGH A CHAOTIC MARKET (owner 11-12: "I want member placed orders to be pushed
 * through").
 *
 * What changed is one gate and one gate only: the order checks no longer refuse a member-placed order
 * because ATLAS has the market flagged chaotic. ATLAS's own trades and automation are refused exactly as
 * before, a closed market or doubtful data still stops everyone, and every other check — the stop, the
 * risk, the limits, the cooldown — still applies to the member's order.
 *
 * Runs the REAL validator over the recorded gold session (a labelled replay fixture). Nothing reaches a
 * network or a broker.
 */

const CHAOS = 'Market is chaotic — no strategy is eligible';
const clean = replay(40, false, 0);
const flagged = replay(40, false, 3);        // a moment the recording itself flags chaotic
const CLEAN = clean.snapshot as MarketSnapshot, FLAGGED = flagged.snapshot as MarketSnapshot;

const withBlockers = (s: MarketSnapshot, codes: [BlockerCode, string][]): MarketSnapshot => ({ ...s, blockers: codes.map(([code, detail]) => ({ code, detail })) });

/** An order every other check accepts: a 60-pip stop on an intraday trade, a quiet account, a readable history. */
const order = (snapshot: MarketSnapshot | null, over: Partial<ValidateInput> = {}): ValidateInput => {
  const price = snapshot?.price ?? 4000;
  return {
    account: { id: 'a', user_id: 'u', is_live: false, live_authorized_at: null, auto_trading: true, permissions: {}, risk_limits: {} } as never,
    snapshot, side: 'buy', style: 'hold', entry: null, stop: +(price - 6).toFixed(2), takeProfit: +(price + 9).toFixed(2),
    riskPct: 0.5, equity: 100_000,
    instrument: { pipSize: 0.1, pipValuePerLot: 10, lotStep: 0.01, minLot: 0.01, maxLot: 100, contractSize: 100 } as never,
    pipSize: 0.1, spread: 0.2, openPositions: 0, openRiskPct: 0,
    history: { readable: true, dayPnl: 0, weekPnl: 0, dayPeakEquity: 100_000, consecutiveLosses: 0, tradesToday: 0, lastTradeAtMs: null, entriesLastHour: 0, lastLossAtMs: null },
    origin: 'member',
    ...over,
  };
};

test('the fixture is what it says: one clean market and one the recording flags chaotic', () => {
  assert.deepEqual(CLEAN.blockers, []);
  assert.deepEqual(FLAGGED.blockers.map((b) => b.code), ['chaotic']);
  assert.equal(FLAGGED.blockers[0].detail, CHAOS);
  assert.deepEqual([...MEMBER_PASSABLE], ['chaotic'], 'chaotic is the only blocker a member\'s order passes');
});

test('the market gate: chaotic stops ATLAS and automation, not a member; everything else stops everyone', () => {
  // A clean market: everyone may trade, nothing is "passed".
  for (const who of ['member', 'brain', 'auto'] as const) assert.deepEqual(tradeableFor(CLEAN, who), { ok: true, reason: '', code: null, passed: null });

  // Flagged chaotic.
  assert.deepEqual(tradeable(FLAGGED), { ok: false, reason: CHAOS, code: 'chaotic' }, 'the plain gate — what the worker and the setup engine ask — is unchanged');
  assert.deepEqual(tradeableFor(FLAGGED, 'brain'), { ok: false, reason: CHAOS, code: 'chaotic', passed: null });
  assert.deepEqual(tradeableFor(FLAGGED, 'auto'), { ok: false, reason: CHAOS, code: 'chaotic', passed: null });
  assert.deepEqual(tradeableFor(FLAGGED, 'member'), { ok: true, reason: '', code: null, passed: { code: 'chaotic', detail: CHAOS } });

  // Whether the market can be SEEN is not a judgement call: a member is refused like everyone else.
  const blocking: [BlockerCode, string][] = [
    ['market_closed', 'Market is closed'], ['feed_stale', 'The price feed is stale'], ['feed_divergence', 'Feeds disagree on price'],
    ['no_exec_read', 'No 5m read'], ['exec_data_behind', '5m data is behind'], ['exec_data_gaps', '5m data has gaps'],
  ];
  for (const b of blocking) {
    for (const who of ['member', 'brain', 'auto'] as const) {
      const alone = tradeableFor(withBlockers(CLEAN, [b]), who);
      assert.deepEqual([alone.ok, alone.code, alone.reason, alone.passed], [false, b[0], b[1], null], `${who} through ${b[0]}`);
      // …and chaos alongside it changes nothing: the cause comes first and it refuses.
      const both = tradeableFor(withBlockers(CLEAN, [b, ['chaotic', CHAOS]]), who);
      assert.deepEqual([both.ok, both.code, both.passed], [false, b[0], null], `${who} through ${b[0]} + chaotic`);
    }
  }
});

test('the order checks: a member\'s own order is taken through a chaotic market, with a warning to read before confirming', () => {
  const quiet = validate(order(CLEAN));
  assert.ok(quiet.ok, quiet.ok ? '' : quiet.reason);
  const v = validate(order(FLAGGED));
  assert.ok(v.ok, v.ok ? '' : `still refused: ${v.reason}`);
  if (!v.ok || !quiet.ok) return;
  assert.deepEqual(v.warnings, ['ATLAS has the market flagged as chaotic and is not trading it. It would not take this trade itself — this order is your call.']);
  assert.deepEqual(quiet.warnings, [], 'no warning is added on a market that is not flagged');
  // It is sized like any other order: risk from equity and the stop, nothing loosened.
  assert.equal(v.sizing.stopPips, 60);
  assert.equal(v.sizing.riskPctUsed, quiet.sizing.riskPctUsed);
  assert.equal(v.sizing.qty, quiet.sizing.qty);
  assert.equal(v.referencePrice, FLAGGED.price);
});

test('ATLAS\'s own trades and automation are refused by a chaotic market exactly as before', () => {
  for (const origin of ['brain', 'auto'] as const) {
    const v = validate(order(FLAGGED, { origin }));
    assert.equal(v.ok, false, `${origin} went through a chaotic market`);
    // (In the last half hour of the trading week automation is refused one step earlier, for that.)
    if (!v.ok && !inWeekendCloseWindow()) assert.equal(v.reason, CHAOS);
    if (!inWeekendCloseWindow()) assert.ok(validate(order(CLEAN, { origin })).ok, `${origin} is refused on a clean market`);
  }
  // The executor checks every confirmed order as a member's click, and says who DECIDED it: an intent ATLAS
  // or automation prepared stays refused at that last step too.
  for (const placedBy of ['brain', 'auto'] as const) {
    const v = validate(order(FLAGGED, { origin: 'member', placedBy }));
    assert.equal(v.ok, false, `an intent placed by ${placedBy} was executed through a chaotic market`);
    if (!v.ok) assert.equal(v.reason, CHAOS);
    assert.ok(validate(order(CLEAN, { origin: 'member', placedBy })).ok);
  }
  assert.ok(validate(order(FLAGGED, { origin: 'member', placedBy: 'member' })).ok);
  const exec = readFileSync('command-center/engines/executor.ts', 'utf8');
  assert.match(exec, /placedBy: intent\.origin === "member" \? "member" : intent\.origin === "auto" \? "auto" : "brain",/, 'execute() must pass the stored intent\'s own origin to the market gate');
  assert.match(exec, /origin: i\.origin,/, 'prepare() validates as whoever is placing the order');

  // And upstream of the order checks, ATLAS's own trade never exists in a chaotic market in the first place.
  assert.equal(flagged.state.setup.state, 'blocked');
  const su = findSetup({ snapshot: FLAGGED, diffs: flagged.diffs, marketOpen: true, now: FLAGGED.at, thesisBias: null, thesisConfidence: null, profile: asSetupProfile(DEFAULT_PROFILE) });
  assert.equal(su.state, 'blocked'); assert.equal(su.side, null);
  const ready = { ...su, state: 'trade_ready' as const, side: 'buy' as const, expiresAt: FLAGGED.at + 3_600_000 };
  const still = stillValid(ready, FLAGGED, FLAGGED.at);
  assert.deepEqual(still, { ok: false, state: 'blocked', reason: CHAOS }, 'take-setup must still refuse on a chaotic market');
  // The files that decide ATLAS's own and automated entries still ask the unchanged question.
  assert.match(readFileSync('command-center/engines/setup.ts', 'utf8'), /if \(s\.blockers\.length\) return noSetup\(`I'm standing down: \$\{s\.blockers\[0\]\.detail\}`/);
  assert.match(readFileSync('command-center/engines/setup.ts', 'utf8'), /if \(s\.blockers\.length\) return \{ ok: false, state: "blocked", reason: s\.blockers\[0\]\.detail \};/);
  assert.match(readFileSync('command-center/worker/index.ts', 'utf8'), /const gate = tradeable\(snap\);/);
  assert.match(readFileSync('command-center/engines/callTrade.ts', 'utf8'), /origin: "brain",/);
  for (const f of ['setup', 'autopilot', 'callTrade', 'autoManage']) {
    assert.doesNotMatch(readFileSync(`command-center/engines/${f}.ts`, 'utf8'), /tradeableFor|MEMBER_PASSABLE/, `${f} must not use the member's gate`);
  }
  assert.doesNotMatch(readFileSync('command-center/worker/index.ts', 'utf8'), /tradeableFor|MEMBER_PASSABLE/);
});

test('a closed market or doubtful data still refuses a member\'s order — chaotic or not', () => {
  const cases: [BlockerCode, string][] = [['market_closed', 'Market is closed'], ['feed_stale', 'The price feed is stale'], ['exec_data_gaps', '5m data has gaps']];
  for (const b of cases) {
    for (const s of [withBlockers(CLEAN, [b]), withBlockers(FLAGGED, [b, ['chaotic', CHAOS]])]) {
      const v = validate(order(s));
      assert.equal(v.ok, false);
      if (!v.ok) { assert.equal(v.reason, b[1]); assert.deepEqual(v.warnings, [], 'a refused order carries no "your call" warning'); }
    }
  }
  const none = validate(order(null));
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.reason, /There is no market read/);
});

test('every other check still applies to a member\'s order in a chaotic market', () => {
  const refused = (over: Partial<ValidateInput>, why: RegExp) => {
    const v = validate(order(FLAGGED, over));
    assert.equal(v.ok, false, `accepted: ${JSON.stringify(Object.keys(over))}`);
    if (!v.ok) assert.match(v.reason, why);
  };
  const p = FLAGGED.price;
  refused({ stop: 0 }, /A stop is required/);
  refused({ stop: +(p + 5).toFixed(2) }, /the stop must sit below the entry/);
  refused({ takeProfit: +(p - 5).toFixed(2) }, /the target must sit above the entry/);
  refused({ stop: +(p - 1).toFixed(2) }, /inside the noise of a HOLD trade/);              // 10 pips on an intraday trade
  refused({ stop: +(p - 25).toFixed(2) }, /wider than the 200-pip limit/);                 // 250 pips
  refused({ openPositions: 1 }, /Already holding 1 position/);
  refused({ equity: null }, /has not reported an account balance/);
  refused({ history: undefined }, /recent trading was not supplied/);
  refused({ history: { ...order(FLAGGED).history!, readable: false } }, /Cannot read when this account last entered/);
  refused({ history: { ...order(FLAGGED).history!, lastTradeAtMs: Date.now() - 60_000 } }, /Cooldown/);
  refused({ account: { ...(order(FLAGGED).account as object), is_live: true, live_authorized_at: null } as never }, /LIVE account and live trading has not been authorised/);
  refused({ account: { ...(order(FLAGGED).account as object), permissions: { manual_execute: false } } as never }, /Manual execution is switched off/);
  refused({ riskPct: 0 }, /Risk per trade is zero/);
  // Risk is still capped and the cap is still said, alongside the chaotic warning.
  const capped = validate(order(FLAGGED, { riskPct: 9 }));
  assert.ok(capped.ok);
  if (capped.ok) {
    assert.ok(capped.sizing.riskPctUsed <= 2);
    assert.equal(capped.warnings.length, 2);
    assert.match(capped.warnings[0], /flagged as chaotic/, 'the flag is the first thing the member reads');
    assert.match(capped.warnings[1], /Risk was capped at 2%/);
  }
});

test('on a market that is not flagged, nothing about any verdict changed', () => {
  for (const off of [0, 9, 21, 33, 57]) {
    const s = replay(40, false, off).snapshot as MarketSnapshot;
    if (s.blockers.length) continue;
    for (const origin of ['member', 'brain', 'auto'] as const) {
      if (origin !== 'member' && inWeekendCloseWindow()) continue;
      const v = validate(order(s, { origin }));
      assert.ok(v.ok, v.ok ? '' : `${origin} at ${off}: ${v.reason}`);
      if (v.ok) assert.deepEqual(v.warnings, []);
      assert.deepEqual(tradeableFor(s, origin), { ...tradeable(s), passed: null });
    }
  }
});

test('ATLAS\'s call offers the ticket exactly when the order checks would take a member\'s order', () => {
  const idea = (r: ReturnType<typeof replay>, s: MarketSnapshot) => buildIdea({ snapshot: s, setup: r.state.setup, takeable: true, read: r.state.read, scenarios: r.state.scenarios, marketOpen: !s.blockers.some((b) => b.code === 'market_closed'), now: r.endedAt, bars5m: r.state.bars });
  let through = 0;
  for (let off = 0; off <= 99; off += 3) {
    const r = replay(40, false, off), s = r.snapshot as MarketSnapshot;
    const call = idea(r, s);
    if (call.source === 'setup_engine') continue;
    const gate = tradeableFor(s, 'member');
    assert.equal(call.execute.via === 'manual' && call.execute.now, gate.ok, `the call at ${off} and the order checks disagree`);
    if (gate.ok && call.stop) {
      // …and the order the ticket would be prefilled with is one the order checks accept.
      const m = call.execute.manual!;
      const v = validate(order(s, { side: m.side, style: m.style, stop: m.stop, takeProfit: m.takeProfit }));
      assert.ok(v.ok, v.ok ? '' : `the prefilled ticket at ${off} would be refused: ${v.reason}`);
      if (v.ok) assert.equal(v.warnings.some((w) => /flagged as chaotic/.test(w)), !!gate.passed);
    }
    if (gate.passed) {
      through += 1;
      assert.match(call.reasoning, /I have the market flagged as chaotic right now, so I'm standing down myself — no automatic trades, and I wouldn't take this one\. It's my read, and taking it is your call\./);
      assert.match(call.execute.note, /^Taking it is your call — I have the market flagged as chaotic, so I wouldn't open this one myself\. Your order still goes through my order checks/);
      assert.equal(call.execute.approved, null, 'never ATLAS\'s own take-setup trade');
      assert.equal(call.source, 'forced_read');
    }
  }
  assert.ok(through >= 3, `only ${through} flagged moments on the recording`);
  // Closed, or the data in doubt: still no ticket, flagged chaotic or not.
  for (const b of [['market_closed', 'Market is closed'], ['feed_stale', 'The price feed is stale']] as [BlockerCode, string][]) {
    const call = idea(flagged, withBlockers(FLAGGED, [b, ['chaotic', CHAOS]]));
    assert.equal(call.execute.via, null); assert.equal(call.execute.now, false);
    assert.equal(tradeableFor(withBlockers(FLAGGED, [b, ['chaotic', CHAOS]]), 'member').ok, false);
  }
});
