import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../command-center/fixtures/replay-bars.json';
import { buildSnapshot } from '../command-center/engines/snapshot';
import { findSetup } from '../command-center/engines/setup';
import { asSetupProfile, DEFAULT_PROFILE } from '../command-center/engines/profile';
import type { Bar, MarketSnapshot } from '../command-center/core/types';

/*
 * THE STOP CARRIES THE COST OF BEING IN THE TRADE.
 *
 * Owner's call on 09-21, after a right-direction sell was stopped by a 1.5-pip spike: the stop is padded
 * by the live spread plus a quarter of the execution ATR, so the two costs that actually decide whether a
 * stop survives — paying the spread and filling where the book is — are inside the number.
 *
 * What must stay true: the pad only ever moves the stop AWAY from price, and the risk percentage is
 * unaffected (sizing simply produces fewer lots).
 */
type Row = [number, number, number, number, number] | { t: number; o: number; h: number; l: number; c: number };
const toBars = (rows: Row[]): Bar[] => rows.map((r) => Array.isArray(r)
  ? { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] }
  : { t: r.t, o: r.o, h: r.h, l: r.l, c: r.c });
const m5 = toBars(fixture.m5 as Row[]);
const h1 = toBars(fixture.h1 as Row[]);

function snap(cut: number, spread: number | null): MarketSnapshot {
  const bars5 = m5.slice(0, m5.length - cut);
  const last = bars5[bars5.length - 1];
  const now = last.t + 5 * 60_000;
  const s = buildSnapshot({
    now, price: last.c,
    bid: spread == null ? null : last.c - spread / 2,
    ask: spread == null ? null : last.c + spread / 2,
    bars: { "5m": bars5, "15m": bars5, "1h": h1, "4h": h1, "1d": h1 },
    feeds: [{ feed: "twelvedata", state: "live", ageMs: 1000, lastTickMs: now - 1000 }],
  });
  return s;
}
const setupOf = (s: MarketSnapshot) => findSetup({
  snapshot: s, diffs: [], profile: asSetupProfile(DEFAULT_PROFILE), marketOpen: true, now: s.at,
  thesisBias: null, thesisConfidence: null,
});

test('a wider spread never pulls the stop closer to price', () => {
  for (const cut of [10, 30, 46, 70]) {
    const tight = setupOf(snap(cut, 0.1));
    const wide = setupOf(snap(cut, 1.2));
    if (tight.stop == null || wide.stop == null || !tight.side || tight.side !== wide.side) continue;
    const px = snap(cut, 0.1).price;
    const distTight = Math.abs(px - tight.stop), distWide = Math.abs(px - wide.stop);
    assert.ok(distWide >= distTight - 1e-9, `cut ${cut}: wider spread produced a tighter stop (${distWide} < ${distTight})`);
  }
});

test('the stop still sits on the protective side of the entry', () => {
  for (const cut of [10, 30, 46, 70]) {
    const s = snap(cut, 0.4);
    const setup = setupOf(s);
    if (!setup.side || setup.stop == null || setup.entryHigh == null) continue;
    if (setup.side === "sell") assert.ok(setup.stop > setup.entryHigh, `cut ${cut}: sell stop below entry`);
    else assert.ok(setup.stop < (setup.entryLow ?? setup.entryHigh), `cut ${cut}: buy stop above entry`);
  }
});
