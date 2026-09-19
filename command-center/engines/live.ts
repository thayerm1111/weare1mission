/**
 * THE LIVE READ — one assembled view of everything COMMAND CENTER XAUUSD shows.
 *
 * The screen must never compute its own market opinion. If it did, the panel and the engine could disagree
 * and the user would have no way to know which one was lying. So every field below is either read straight
 * from what the worker persisted, or derived from it by the same pure functions the worker used.
 */
import type { Bar, MarketSnapshot } from "../core/types";
import type { BrainMemory, BrainState, BrainThesis, PerceptionEvent } from "../brain/types";
import { diffSet } from "../brain/diff";
import { brainState, intensity, velocityBand, weather } from "../brain/presence";
import { memoryOf } from "../brain/memory";
import { marketRead, scenarioOf } from "../brain/language";
import { latestWithBars, loadRolling, recentStatements, thesisJournal } from "../adapters/db";
import { tradeState, emptyTrade, lastCompleted, pendingExecution, type TradeState } from "./tradeLive";
import { findSetup, noSetup, type BrainSetup } from "./setup";
import { getProfile, asSetupProfile, DEFAULT_PROFILE, type TradingProfile } from "./profile";
import { experienceOf, type Experience } from "./experience";
import { armedFor, type Watch } from "./watch";

/** Beyond this, the read is history rather than the market, and the UI must say so. */
export const STALE_MS = 5 * 60_000;

export type LiveState = {
  ok: boolean;
  /** True only when a real, recent read exists. There is no simulated mode — see the README. */
  live: boolean;
  connected: boolean;
  reason: string | null;
  at: number | null;
  ageSeconds: number | null;
  marketOpen: boolean;

  price: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;

  session: string | null;
  regime: string | null;
  pressure: { bullish: number; bearish: number; net: number } | null;
  weather: string | null;
  velocity: string | null;
  intensity: number;

  timeframes: Record<string, { state: string; efficiency: number | null; rsi: number | null; sequence: string | null; positionInRange: number | null }>;
  levels: { price: number; kind: string; label: string; distanceAtr?: number }[];
  bars: Bar[];

  brain: BrainState | null;
  thesis: BrainThesis | null;
  previousThesis: BrainThesis | null;
  journal: { id: string; at: number; label: string; strength: string; confidence: number; endedAt: number | null; reasonEnded: string | null }[];
  events: PerceptionEvent[];
  /** What THE BRAIN has actually said, newest first. The screen speaks these; it never writes its own. */
  statements: { at: number; kind: string; text: string; channel: string }[];
  changes: { horizon: string; priceMove: number; pipsMove: number; pressureFrom: number; pressureTo: number; regimeChanged: boolean }[];
  scenario: { bull: string; bear: string; neutral: string } | null;
  summary: string;
  warnings: string[];
  blockers: { code: string; detail: string }[];
  /** Present and active only when this member has an open position. */
  trade: TradeState;
  /** What THE BRAIN currently wants to do about gold. Null until a member context exists. */
  setup: BrainSetup;
  /** Where the Command Center is in its own lifecycle. The screen changes emphasis from this. */
  experience: Experience;
  /** The boundaries THE BRAIN is working inside. */
  profile: TradingProfile;
  /**
   * What the member has asked THE BRAIN to watch, still armed.
   *
   * Shown so a promise is visible rather than remembered. A member who said "watch the London high" an
   * hour ago should be able to SEE that it is still armed, and how close it is, without asking.
   */
  watches: { id: string; said: string; kind: string; label: string | null; price: number | null; progress: number | null; expiresAt: number | null }[];
};

const empty = (reason: string, marketIsOpen: boolean): LiveState => ({
  ok: true, live: false, connected: false, reason, at: null, ageSeconds: null, marketOpen: marketIsOpen,
  price: null, bid: null, ask: null, spread: null,
  session: null, regime: null, pressure: null, weather: null, velocity: null, intensity: 0,
  timeframes: {}, levels: [], bars: [],
  brain: null, thesis: null, previousThesis: null, journal: [], events: [], statements: [], changes: [],
  scenario: null, summary: reason, warnings: [], blockers: [], trade: emptyTrade(),
  setup: noSetup(
    marketIsOpen
      ? "I can't see gold well enough to look for a trade."
      : "Gold is closed. I'll start looking again when it reopens.",
    [], "blocked",
  ),
  experience: experienceOf({
    setup: null, tradeActive: false, characterState: null, protectionAction: null,
    beyondBreakEven: false, exiting: false, pending: null, completed: null,
  }),
  profile: { ...DEFAULT_PROFILE },
  watches: [],
});

export async function liveState(marketIsOpen: boolean, journalSince: Date, userId?: string | null): Promise<LiveState> {
  const latest = await latestWithBars();
  if (!latest) {
    return empty(
      marketIsOpen
        ? "THE BRAIN has not written a market read yet."
        : "Gold is closed. THE BRAIN resumes when the market reopens.",
      marketIsOpen,
    );
  }

  const s: MarketSnapshot = latest.snapshot;
  const rolling = await loadRolling();
  const diffs = diffSet(s, rolling.snapshots.filter((x) => x.at < s.at));

  const openThesis = [...rolling.theses].reverse().find((t) => !t.endedAt) ?? null;
  const closed = rolling.theses.filter((t) => t.endedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

  // The BRAIN state the worker last wrote is authoritative; if none exists yet (first minutes after a
  // deploy) it is recomputed here with the same pure function rather than left blank.
  // Presence and the state computation need the trade, so the trade is read first and the BRAIN state
  // is built with it. Once a position exists, THE BRAIN's attention is supposed to visibly narrow.
  const profile = userId ? await getProfile(userId) : { ...DEFAULT_PROFILE };
  const preTrade = userId ? await tradeState(userId, s, diffs) : emptyTrade();
  const protecting = preTrade.active && (preTrade.protection?.action === "protect_stop" || preTrade.protection?.action === "close" || preTrade.character?.state === "character_change");
  const state: BrainState = brainState({
    snapshot: s, thesis: openThesis, events: rolling.events.slice(-8),
    tradeActive: preTrade.active, tradeProtecting: protecting,
  });
  // WHAT I'M WATCHING and THE QUESTION become about the trade the moment there is one.
  if (preTrade.active) {
    if (preTrade.focus.length) state.focus = preTrade.focus;
    if (preTrade.question) state.question = preTrade.question;
    if (preTrade.character) state.headline = preTrade.character.headline;
  }

  const memory: BrainMemory = memoryOf(rolling, s, diffs, state);
  const ageMs = Date.now() - latest.at;
  const stale = ageMs > STALE_MS;

  /*
   * THE BRAIN's own trade decision.
   *
   * Computed from the SAME snapshot the screen is about to render and the member's own profile, so what
   * the member is shown and what the server would execute can never be two different reads of gold. A
   * stale snapshot is not allowed to produce a setup at all: `findSetup` is handed marketOpen=false, and
   * it stands down rather than offering a trade built on a picture five minutes out of date.
   */
  const setup = findSetup({
    snapshot: s,
    diffs,
    profile: asSetupProfile(profile),
    marketOpen: marketIsOpen && !stale,
    // The standing market thesis is fed back in so the trade card and BRAIN THESIS cannot contradict
    // each other on the same screen.
    thesisBias: openThesis?.bias ?? null,
    thesisConfidence: openThesis?.confidence ?? null,
  });

  const [pending, completed, watches] = userId
    ? await Promise.all([pendingExecution(userId), lastCompleted(userId), armedFor(userId)])
    : [null, null, [] as Watch[]];

  const experience = experienceOf({
    setup,
    tradeActive: preTrade.active,
    characterState: preTrade.character?.state ?? null,
    protectionAction: preTrade.protection?.action ?? null,
    beyondBreakEven: preTrade.metrics?.beyondBreakEven ?? false,
    exiting: preTrade.exiting,
    pending,
    completed,
  });

  const [journalRows, statementRows, trade] = await Promise.all([
    thesisJournal(journalSince.toISOString()),
    recentStatements(12),
    // The trade is loaded with the SAME snapshot the screen is about to render, so the market read and
    // the position read can never disagree about the price of gold.
    Promise.resolve(preTrade),
  ]);

  return {
    ok: true,
    live: !stale && marketIsOpen,
    connected: !stale,
    reason: stale
      ? (marketIsOpen ? `The last market read was ${Math.round(ageMs / 60_000)} minutes ago.` : "Gold is closed. This is the last read before the close.")
      : null,
    at: latest.at,
    ageSeconds: Math.round(ageMs / 1000),
    marketOpen: marketIsOpen,

    price: s.price, bid: s.bid, ask: s.ask, spread: s.spread,
    session: s.session, regime: s.regime,
    pressure: { bullish: Math.round(s.pressure.bullish), bearish: Math.round(s.pressure.bearish), net: Math.round(s.pressure.net) },
    weather: weather(s), velocity: velocityBand(s),
    intensity: marketIsOpen && !stale ? intensity(s) : 2,

    timeframes: Object.fromEntries(Object.entries(s.timeframes).map(([tf, v]) => [tf, {
      state: v!.state,
      efficiency: v!.features.efficiency ?? null,
      rsi: v!.features.rsi ?? null,
      sequence: v!.structure.sequence ?? null,
      positionInRange: v!.structure.positionInRange ?? null,
    }])),
    levels: s.levels.slice(0, 10),
    bars: latest.bars.slice(-140),

    brain: state,
    thesis: openThesis,
    previousThesis: closed[0] ?? null,
    journal: journalRows.map((t) => ({
      id: String(t.id), at: Date.parse(String(t.started_at)), label: String(t.label),
      strength: String(t.strength), confidence: Number(t.confidence) || 0,
      endedAt: t.ended_at ? Date.parse(String(t.ended_at)) : null,
      reasonEnded: (t.reason_ended as string | null) ?? null,
    })),
    events: rolling.events.slice(-40).reverse(),
    statements: statementRows.map((r) => ({
      at: Date.parse(String(r.at)), kind: String(r.kind), text: String(r.body), channel: String(r.channel),
    })),
    changes: diffs.map((d) => ({
      horizon: d.horizon, priceMove: d.priceMove, pipsMove: d.pipsMove,
      pressureFrom: Math.round(d.pressureFrom), pressureTo: Math.round(d.pressureTo), regimeChanged: d.regimeChanged,
    })),
    scenario: scenarioOf(memory),
    summary: state.headline || marketRead(memory),
    warnings: s.warnings.slice(0, 5),
    blockers: s.blockers,
    trade,
    setup,
    experience,
    profile,
    watches: watches.map((w) => ({
      id: w.id, said: w.said, kind: w.kind, label: w.levelLabel,
      price: w.levelPrice, progress: w.progress, expiresAt: w.expiresAt,
    })),
  };
}

/** The memory packet, for the conversation route. Same assembly, so chat and screen never disagree. */
export async function liveMemory(): Promise<BrainMemory> {
  const latest = await latestWithBars();
  const rolling = await loadRolling();
  if (!latest) return memoryOf(rolling, null, [], null);
  const s = latest.snapshot;
  const diffs = diffSet(s, rolling.snapshots.filter((x) => x.at < s.at));
  const openThesis = [...rolling.theses].reverse().find((t) => !t.endedAt) ?? null;
  const state = brainState({ snapshot: s, thesis: openThesis, events: rolling.events.slice(-8) });
  return memoryOf(rolling, s, diffs, state);
}
