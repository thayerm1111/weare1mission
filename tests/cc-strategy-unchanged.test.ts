import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../command-center/fixtures/replay-bars.json';
import { buildSnapshot } from '../command-center/engines/snapshot';
import { findSetup } from '../command-center/engines/setup';
import { validate } from '../command-center/engines/validator';
import { asSetupProfile, DEFAULT_PROFILE } from '../command-center/engines/profile';
import { buildIntel } from '../command-center/present/intel';
import type { Bar, MarketSnapshot } from '../command-center/core/types';

/*
 * THE GAUGES DO NOT MOVE THE WHEEL.
 *
 * The Command Center's display layer (command-center/present) adds a level map to the snapshot and a
 * block of analytics to the live read. This test runs the REAL engine over recorded gold twice — once
 * with the display layer's additions present, once with them stripped out — and asserts the trading
 * outputs are byte-identical: the same market read, the same setup, the same entry, stop, target, style
 * and refusal reason, and the same validator verdict.
 *
 * If a display field ever starts changing a decision, this fails.
 */
type Row = [number, number, number, number, number] | { t: number; o: number; h: number; l: number; c: number };
const toBars = (rows: Row[]): Bar[] => rows.map((r) => Array.isArray(r)
  ? { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] }
  : { t: r.t, o: r.o, h: r.h, l: r.l, c: r.c });

const m5 = toBars(fixture.m5 as Row[]);
const h1 = toBars(fixture.h1 as Row[]);

function snapAt(cut: number): MarketSnapshot {
  const bars5 = m5.slice(0, m5.length - cut);
  const now = bars5[bars5.length - 1].t + 5 * 60_000;
  return buildSnapshot({
    now, price: bars5[bars5.length - 1].c, bid: null, ask: null,
    bars: { "5m": bars5, "15m": bars5, "1h": h1, "4h": h1, "1d": h1 },
    feeds: [{ feed: "twelvedata", state: "live", ageMs: 1000, lastTickMs: now - 1000 }],
  });
}

/** The same snapshot with everything the display layer added removed. */
const stripped = (s: MarketSnapshot): MarketSnapshot => {
  const copy = JSON.parse(JSON.stringify(s)) as MarketSnapshot & { map?: unknown };
  delete copy.map;
  return copy;
};

const decisionOf = (s: MarketSnapshot) => {
  const setup = findSetup({ snapshot: s, diffs: [], profile: asSetupProfile(DEFAULT_PROFILE), marketOpen: true, now: s.at, thesisBias: null, thesisConfidence: null });
  return {
    state: setup.state, side: setup.side, style: setup.style, entryLow: setup.entryLow, entryHigh: setup.entryHigh,
    stop: setup.stop, objective: setup.initialObjective, extended: setup.extendedObjective, confidence: setup.confidence,
    blockedBy: setup.blockedBy, waitingFor: setup.waitingFor, conditions: setup.conditions.map((c) => [c.id, c.met]),
    say: setup.say, headline: setup.headline,
  };
};

test('the same recorded gold produces the same decision with and without the display layer', () => {
  for (const cut of [10, 30, 46, 70]) {
    const withDisplay = snapAt(cut);
    const without = stripped(withDisplay);

    // The snapshot the engine reads is identical apart from the display-only map.
    const a = JSON.parse(JSON.stringify(withDisplay)) as Record<string, unknown>;
    delete a.map;
    assert.deepEqual(a, JSON.parse(JSON.stringify(without)), `snapshot differs at cut ${cut}`);

    assert.deepEqual(decisionOf(withDisplay), decisionOf(without), `setup differs at cut ${cut}`);
  }
});

test('building the display analytics does not mutate the snapshot the engine reads', () => {
  const s = snapAt(46);
  const before = JSON.stringify(s);
  const intel = buildIntel({
    s, thesis: null, events: [], changes: [{ horizon: '5m', pressureFrom: -30, pressureTo: -18 }],
    velocityBand: 'calm', weather: 'normal', bars: m5,
  });
  assert.equal(JSON.stringify(s), before, 'buildIntel mutated the snapshot');
  assert.ok(intel.radar.length >= 0);
  // The pressure the gauges show is the engine's own number, not a second calculation.
  assert.equal(intel.pressure.buyers, Math.round(s.pressure.bullish));
  assert.equal(intel.pressure.sellers, Math.round(s.pressure.bearish));
  assert.equal((intel.pressure.buyers ?? 0) + (intel.pressure.sellers ?? 0), 100);
});

test('the validator reaches the same verdict either way', () => {
  const s = snapAt(46);
  const common = {
    account: { id: 'a', user_id: 'u', is_live: false, live_authorized_at: null, auto_trading: true, permissions: {}, risk_limits: {} } as never,
    side: 'sell' as const, style: 'quick' as const, entry: null, stop: s.price + 3, takeProfit: s.price - 6,
    riskPct: 0.5, equity: 100_000, instrument: { pipSize: 0.1, pipValuePerLot: 10, lotStep: 0.01, minLot: 0.01, maxLot: 100, contractSize: 100 } as never,
    pipSize: 0.1, spread: 0.2, openPositions: 0, openRiskPct: 0,
    history: { readable: true, dayPnl: 0, weekPnl: 0, dayPeakEquity: 100_000, consecutiveLosses: 0, tradesToday: 0, lastTradeAtMs: null, entriesLastHour: 0 },
    origin: 'auto' as const,
  };
  const a = validate({ ...common, snapshot: s });
  const b = validate({ ...common, snapshot: stripped(s) });
  assert.deepEqual(a, b);
});
