/**
 * BRAIN MEMORY — structured, not a transcript.
 *
 * The lazy way to give a model memory is to paste the whole conversation into the prompt. That produces
 * something that can quote itself but cannot reason about its own past. So memory here is STRUCTURED:
 * bounded rings of snapshots, events, statements and closed theses, each trimmed by age and count.
 *
 * Everything in here is small enough to travel in one context packet without truncation.
 */
import type { MarketSnapshot } from "../core/types";
import type { BrainMemory, BrainStatement, BrainState, BrainThesis, PerceptionEvent, SnapshotDiff } from "./types";

export type Rolling = {
  snapshots: MarketSnapshot[];
  events: PerceptionEvent[];
  statements: BrainStatement[];
  theses: BrainThesis[];
  lessons: { at: number; text: string }[];
  lastSpokeAt: number | null;
};

export const LIMITS = {
  snapshotsMs: 75 * 60_000,      // just over an hour, so the 1h horizon always has a partner
  snapshotsMax: 260,
  eventsMs: 90 * 60_000,
  eventsMax: 220,
  statementsMax: 40,
  thesesMax: 24,
  lessonsMax: 40,
};

export const emptyRolling = (): Rolling => ({ snapshots: [], events: [], statements: [], theses: [], lessons: [], lastSpokeAt: null });

const trimByAge = <T extends { at: number }>(xs: T[], now: number, ms: number, max: number): T[] =>
  xs.filter((x) => now - x.at <= ms).slice(-max);

export function pushSnapshot(r: Rolling, s: MarketSnapshot): Rolling {
  const snapshots = trimByAge([...r.snapshots, s], s.at, LIMITS.snapshotsMs, LIMITS.snapshotsMax);
  return { ...r, snapshots };
}

export function pushEvents(r: Rolling, es: PerceptionEvent[], now: number): Rolling {
  if (!es.length) return r;
  const seen = new Set(r.events.map((e) => e.key));
  const fresh = es.filter((e) => !seen.has(e.key));
  return { ...r, events: trimByAge([...r.events, ...fresh], now, LIMITS.eventsMs, LIMITS.eventsMax) };
}

export function pushStatement(r: Rolling, s: BrainStatement): Rolling {
  const spoke = s.channel === "voice" || s.channel === "urgent";
  return {
    ...r,
    statements: [...r.statements, s].slice(-LIMITS.statementsMax),
    lastSpokeAt: spoke ? s.at : r.lastSpokeAt,
  };
}

export function pushThesis(r: Rolling, t: BrainThesis): Rolling {
  const without = r.theses.filter((x) => x.id !== t.id);
  return { ...r, theses: [...without, t].slice(-LIMITS.thesesMax) };
}

export function pushLesson(r: Rolling, at: number, text: string): Rolling {
  return { ...r, lessons: [...r.lessons, { at, text }].slice(-LIMITS.lessonsMax) };
}

/** The open thesis, if there is one. */
export const currentThesis = (r: Rolling): BrainThesis | null =>
  [...r.theses].reverse().find((t) => !t.endedAt) ?? null;

/** The one before it — what it used to think, which is half of "why did you change your mind". */
export const priorThesis = (r: Rolling): BrainThesis | null => {
  const closed = r.theses.filter((t) => t.endedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return closed[0] ?? null;
};

/** Assemble the bounded view of itself that The BRAIN reasons over. */
export function memoryOf(r: Rolling, now: MarketSnapshot | null, diffs: SnapshotDiff[], state: BrainState | null): BrainMemory {
  return {
    now,
    diffs,
    recentEvents: r.events.slice(-40),
    thesis: currentThesis(r),
    previousThesis: priorThesis(r),
    statements: r.statements.slice(-12),
    watchedLevels: now ? now.levels.slice(0, 6) : [],
    state,
    lessons: r.lessons.slice(-8),
  };
}

/** What it said, N minutes ago — the literal answer to "what were you thinking ten minutes ago?". */
export function statementAround(r: Rolling, at: number, toleranceMs = 4 * 60_000): BrainStatement | null {
  let best: BrainStatement | null = null;
  let gap = Infinity;
  for (const s of r.statements) {
    const g = Math.abs(s.at - at);
    if (g < gap) { gap = g; best = s; }
  }
  return gap <= toleranceMs ? best : null;
}

/** The day's theses in order — the BRAIN JOURNAL. */
export function journal(r: Rolling, sinceMs: number): BrainThesis[] {
  return r.theses.filter((t) => t.startedAt >= sinceMs).sort((a, b) => a.startedAt - b.startedAt);
}
