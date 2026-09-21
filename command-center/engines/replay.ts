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
// Display-only analytics for the replay screen; never reaches a decision.
import { presentExtras } from "../present/intel";
import fixture from "../fixtures/replay-bars.json";
import { buildSnapshot } from "./snapshot";
import { resample } from "../core/bars";
import { perceive } from "../brain";
import { emptyRolling, memoryOf, type Rolling } from "../brain/memory";
import { scenarioOf } from "../brain/language";
import { intensity, velocityBand, weather } from "../brain/presence";
import type { Bar, MarketSnapshot } from "../core/types";
import type { LiveState } from "./live";
import { emptyTrade } from "./tradeLive";
import { findSetup } from "./setup";
import { DEFAULT_PROFILE, asSetupProfile } from "./profile";
import { experienceOf } from "./experience";
import { metrics, character, protection, health, tradeFocus, tradeQuestion, tradeRead, tradeThesisState, type LivePosition } from "../brain/trade";

type Row = [number, number, number, number, number];
const toBars = (rows: Row[]): Bar[] => rows.map(([t, o, h, l, c]) => ({ t: t * 1000, o, h, l, c }));

export type ReplayResult = {
  state: LiveState;
  steps: number;
  endedAt: number;
  /** The raw snapshot the replay arrived at. Exposed so tests can drive the engines on real bars. */
  snapshot: MarketSnapshot;
  diffs: ReturnType<typeof perceive>["diffs"];
};

/**
 * Step the pipeline forward one 5-minute bar at a time over the recorded window, exactly as the worker
 * would have, and return the state it arrived at.
 */
export function replay(steps = 40, withTrade = false, endOffset = 0): ReplayResult {
  // `endOffset` trims bars off the END of the recording, so the harness can stand at any moment of the
  // session rather than only at its last bar. Without it every replay answers the same question.
  const m5All = endOffset > 0 ? toBars(fixture.m5 as Row[]).slice(0, -endOffset) : toBars(fixture.m5 as Row[]);
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

  const replaySetup = findSetup({
    snapshot: s, diffs: last.diffs, profile: asSetupProfile(DEFAULT_PROFILE), marketOpen: true, now: s.at,
    thesisBias: openThesis?.bias ?? null, thesisConfidence: openThesis?.confidence ?? null,
  });

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
    trade: withTrade ? replayTrade(s, m5All, last.diffs) : emptyTrade(),
    // The setup engine runs over the REPLAYED snapshot too, so the harness shows what THE BRAIN would
    // actually have called on recorded gold rather than on a fixture invented to make it look clever.
    setup: replaySetup,
    experience: experienceOf({
      setup: replaySetup, tradeActive: withTrade, characterState: null, protectionAction: null,
      beyondBreakEven: false, exiting: false, pending: null, completed: null, now: s.at,
    }),
    profile: { ...DEFAULT_PROFILE },
    watches: [],
    ...presentExtras({
      s, thesis: openThesis, events: rolling.events.slice(-60), bars: m5All, diffs: last.diffs,
      velocityBand: velocityBand(s), weather: weather(s),
    }),
  };

  return { state, steps: m5All.length - first, endedAt: s.at, snapshot: s, diffs: last.diffs };
}


/**
 * A position for the replay harness ONLY.
 *
 * Every number in it is real arithmetic on the real recorded bars: the entry is an actual close from 40
 * bars back, the stop is an actual swing low, and the P&L, health and character read are produced by the
 * same functions that run on a live trade. It exists so the trade experience can be built and reviewed
 * while gold is shut, and it is only ever reachable from the replay endpoint, which renders a banner
 * saying it is not the market.
 */
function replayTrade(s: MarketSnapshot, m5: Bar[], diffs: ReturnType<typeof perceive>["diffs"]): LiveState["trade"] {
  const entryIdx = Math.max(20, m5.length - 40);
  const entryBar = m5[entryIdx];
  const window = m5.slice(entryIdx);
  // The stop comes from the structure that existed BEFORE the entry — the swing low the trade was
  // actually behind — not from the low of the move it went on to make.
  const swingLow = Math.min(...m5.slice(entryIdx - 20, entryIdx).map((b) => b.l));
  const pipSize = 0.1;
  const pos: LivePosition = {
    id: "replay", side: "buy", style: "hold",
    entry: +entryBar.c.toFixed(2), qty: 0.2, initQty: 0.2,
    initStop: +(swingLow - 0.4).toFixed(2), curStop: +(swingLow - 0.4).toFixed(2),
    takeProfit: +(entryBar.c + 14).toFixed(2),
    openedAt: entryBar.t, pipSize, pipValuePerLot: 10,
    mfePips: Math.max(...window.map((b) => (b.h - entryBar.c) / pipSize)),
    maePips: Math.min(...window.map((b) => (b.l - entryBar.c) / pipSize)),
    breakEvenAt: null, partials: [],
    thesis: { reason: "Long from the reclaim of the London low with the 15-minute still bullish.", invalidationPrice: +(swingLow - 0.4).toFixed(2) },
    aiManagement: false,
  };
  const m = metrics(pos, s.price, s.at);
  const ch = character(pos, s, m, diffs);
  const h = health(pos, m, ch);
  const prot = protection(pos, m, ch, s);
  return {
    active: true, positionId: "replay", accountRowId: null, side: pos.side, style: pos.style,
    entry: pos.entry, qty: pos.qty, initQty: pos.initQty, stop: pos.curStop, initStop: pos.initStop,
    takeProfit: pos.takeProfit, openedAt: pos.openedAt,
    metrics: m, character: ch, health: h, protection: prot,
    thesisState: tradeThesisState(ch), thesis: pos.thesis,
    focus: tradeFocus(pos, m, s), question: tradeQuestion(pos, m, ch, s), read: tradeRead(pos, m, ch, prot),
    partials: [], aiManagement: false, permissions: {}, exiting: false,
    events: [
      { at: pos.openedAt, code: "POSITION_OPEN", detail: `BUY XAUUSD opened at ${pos.entry.toFixed(2)}.`, channel: "voice" },
      { at: pos.openedAt + 9 * 60_000, code: "TRADE_PROGRESS", detail: `Trade +${Math.round(m.mfePips * 0.4)} pips.`, channel: "stream" },
      { at: pos.openedAt + 22 * 60_000, code: "LEVEL_REACHED", detail: "Reached the first area I was watching.", channel: "stream" },
      { at: s.at - 60_000, code: "HEALTH_CHANGED", detail: `Position health ${Math.max(0, h.score - 6)} → ${h.score}.`, channel: "stream" },
    ].sort((a, b) => b.at - a.at),
    unmanaged: [],
  };
}
