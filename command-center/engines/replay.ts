/**
 * REPLAY — run real recorded gold through the real pipeline.
 *
 * This exists so the experience can be built, reviewed and regression-tested without inventing a market.
 * The bars in command-center/fixtures are genuine XAUUSD history; everything derived from them here is
 * produced by exactly the same engine, perception loop and BRAIN that run live. Nothing is scripted:
 * the thesis, the events and the presence state are whatever the code actually decides.
 *
 * It is never used by the live product. Every surface that renders a replay is labelled as one.
 */
import fixture from "../fixtures/replay-bars.json";
import { buildSnapshot } from "./snapshot";
import { resample } from "../core/bars";
import { perceive } from "../brain";
import { emptyRolling, memoryOf, type Rolling } from "../brain/memory";
import { scenarioOf } from "../brain/language";
import { intensity, velocityBand, weather } from "../brain/presence";
import type { Bar, MarketSnapshot } from "../core/types";
import type { LiveState } from "./live";

type Row = [number, number, number, number, number];
const toBars = (rows: Row[]): Bar[] => rows.map(([t, o, h, l, c]) => ({ t: t * 1000, o, h, l, c }));

export type ReplayResult = { state: LiveState; steps: number; endedAt: number };

/**
 * Step the pipeline forward one 5-minute bar at a time over the recorded window, exactly as the worker
 * would have, and return the state it arrived at.
 */
export function replay(steps = 40): ReplayResult {
  const m5All = toBars(fixture.m5 as Row[]);
  const h1All = toBars(fixture.h1 as Row[]);

  let rolling: Rolling = emptyRolling();
  let last: ReturnType<typeof perceive> | null = null;
  let snap: MarketSnapshot | null = null;

  const first = Math.max(70, m5All.length - steps);
  for (let i = first; i < m5All.length; i++) {
    const m5 = m5All.slice(0, i + 1);
    const at = m5[m5.length - 1].t + 5 * 60_000;      // stand just after that bar closed
    const m15 = resample(m5, "5m", "15m");
    const h1 = h1All.filter((b) => b.t <= at);
    const h4 = h1.length >= 4 ? resample(h1, "1h", "4h") : [];

    snap = buildSnapshot({
      now: at,
      bars: { "5m": m5, "15m": m15, "1h": h1, "4h": h4 },
      price: m5[m5.length - 1].c,
      feeds: [{ feed: "twelvedata", state: "live", lastTickMs: m5[m5.length - 1].t, ageMs: 5_000 }],
      prevPressureNet: last ? last.memory.now?.pressure.net ?? null : null,
    });
    last = perceive({ rolling, snapshot: snap });
    rolling = last.rolling;
  }

  if (!last || !snap) throw new Error("replay produced nothing — the fixture is too short");

  const s = snap;
  const memory = memoryOf(rolling, s, last.diffs, last.state);
  const openThesis = [...rolling.theses].reverse().find((t) => !t.endedAt) ?? null;
  const closed = rolling.theses.filter((t) => t.endedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

  const state: LiveState = {
    ok: true,
    live: false,                 // a replay is NEVER live, and the screen says so
    connected: true,
    reason: "REPLAY — recorded XAUUSD from 18 September, stepped through the real engine. Not a live market.",
    at: s.at,
    ageSeconds: 0,
    marketOpen: true,
    price: s.price, bid: s.bid, ask: s.ask, spread: s.spread,
    session: s.session, regime: s.regime,
    pressure: { bullish: Math.round(s.pressure.bullish), bearish: Math.round(s.pressure.bearish), net: Math.round(s.pressure.net) },
    weather: weather(s), velocity: velocityBand(s), intensity: intensity(s),
    timeframes: Object.fromEntries(Object.entries(s.timeframes).map(([tf, v]) => [tf, {
      state: v!.state, efficiency: v!.features.efficiency ?? null, rsi: v!.features.rsi ?? null,
      sequence: v!.structure.sequence ?? null, positionInRange: v!.structure.positionInRange ?? null,
    }])),
    levels: s.levels.slice(0, 10),
    bars: m5All.slice(-140),
    brain: last.state,
    thesis: openThesis,
    previousThesis: closed[0] ?? null,
    journal: rolling.theses.map((t) => ({
      id: t.id, at: t.startedAt, label: t.label, strength: t.strength, confidence: t.confidence,
      endedAt: t.endedAt, reasonEnded: t.reasonEnded,
    })),
    events: rolling.events.slice(-40).reverse(),
    statements: rolling.statements.slice(-12).reverse().map((x) => ({ at: x.at, kind: x.kind, text: x.text, channel: x.channel })),
    changes: last.diffs.map((d) => ({
      horizon: d.horizon, priceMove: d.priceMove, pipsMove: d.pipsMove,
      pressureFrom: Math.round(d.pressureFrom), pressureTo: Math.round(d.pressureTo), regimeChanged: d.regimeChanged,
    })),
    scenario: scenarioOf(memory),
    summary: last.state.headline,
    warnings: s.warnings.slice(0, 5),
    blockers: s.blockers,
  };

  return { state, steps: m5All.length - first, endedAt: s.at };
}
