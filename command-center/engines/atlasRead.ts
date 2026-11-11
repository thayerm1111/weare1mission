/**
 * ATLAS READ — one step of the directional read and its scenarios, composed once for every caller.
 *
 * The worker runs this on every pass, replay runs it on every recorded candle, and the live route runs it
 * when the worker has not persisted a read it can use. Because all three call this same pure function, the
 * read on the screen, the read in the database and the read in replay can only differ in their inputs.
 *
 * DISPLAY AND CONVERSATION ONLY. Nothing here is read by the setup engine, the executor, the autopilot, the
 * position manager or the risk engine, and nothing here can place, size, move or close anything
 * (tests/cc-atlas-read.test.ts enforces both directions of that boundary).
 */
import type { Bar, MarketSnapshot, Timeframe } from "../core/types";
import { LEAN_LABEL, type AtlasRead, type Lean, type Scenario } from "../core/atlasContract";
import { computeReadDetailed, signed } from "../core/read";
import { updateScenarios, scenarioChanges } from "../core/scenarios";
import type { SetupState } from "./setup";

/** What one reading needs to remember for the next: the read (hysteresis) and the scenarios (lifecycle). */
export type AtlasMemory = { read: AtlasRead | null; scenarios: Scenario[] };

export type AtlasStepInput = {
  snapshot: MarketSnapshot | null;
  snapshotId?: number | null;
  bars: Partial<Record<Timeframe, Bar[]>>;
  barsAsOf?: Partial<Record<Timeframe, number>>;
  setup?: { state: SetupState } | null;
  tradeActive?: boolean;
  previous: AtlasMemory | null;
  /** The clock (staleness only). Defaults to the snapshot's time. */
  now?: number;
};

export type AtlasStep = {
  read: AtlasRead;
  scenarios: Scenario[];
  leanChanged: boolean;
  /** Plain lines: scenarios opened and statuses changed this step. */
  scenarioChanges: string[];
  /** One line saying why this step is worth recording (a lean change, a scenario change, or neither). */
  reason: string;
};

export function atlasStep(i: AtlasStepInput): AtlasStep {
  const prev = i.previous ?? { read: null, scenarios: [] };
  const d = computeReadDetailed({
    snapshot: i.snapshot, snapshotId: i.snapshotId ?? null, bars: i.bars, barsAsOf: i.barsAsOf,
    previous: prev.read, setup: i.setup ?? null, tradeActive: i.tradeActive, now: i.now,
  });
  const read = d.read;
  const scenarios = updateScenarios(read, i.snapshot, prev.scenarios, read.at, { bars: d.closed, edges: d.edges });
  const leanChanged = !prev.read || prev.read.lean !== read.lean;
  const changes = scenarioChanges(prev.scenarios, scenarios);
  const parts: string[] = [];
  if (leanChanged) {
    parts.push(prev.read
      ? `Lean: ${LEAN_LABEL[prev.read.lean]} → ${LEAN_LABEL[read.lean]}. ${read.previous?.reason ?? ""}`.trim()
      : `Lean: ${LEAN_LABEL[read.lean]} (first read).`);
  }
  if (changes.length) parts.push(`Scenarios: ${changes.join("; ")}.`);
  return {
    read, scenarios, leanChanged, scenarioChanges: changes,
    reason: parts.length ? parts.join(" ") : `Held: ${LEAN_LABEL[read.lean]} (${signed(read.score)}).`,
  };
}

/* ── persistence policy ──────────────────────────────────────────────────────────────────────────── */

/** Without a change, a read is written at most this often. */
export const READ_PERSIST_MS = 5 * 60_000;
/** A stored read this much older than the snapshot it would be shown with is not used for that snapshot. */
export const READ_FRESH_MS = READ_PERSIST_MS + 90_000;

/**
 * Write when the lean or a scenario changed (or a change is still unwritten), and otherwise at most every
 * READ_PERSIST_MS — enough for the screen and the record without a row per twenty-second pass.
 */
export function shouldPersistRead(step: AtlasStep, o: { lastPersistAt: number; now: number; unwrittenChange: boolean }): boolean {
  return o.unwrittenChange || step.leanChanged || step.scenarioChanges.length > 0 || o.now - o.lastPersistAt >= READ_PERSIST_MS;
}

/* ── the read history ────────────────────────────────────────────────────────────────────────────── */

export type ReadHistoryItem = { at: number; lean: Lean; reason: string; summary: string };

/** One persisted (or replayed) reading, reduced to what the history needs. */
export type ReadRowLite = {
  at: number;
  lean: Lean;
  /** When that reading's lean began (read.since). */
  since: number | null;
  summary: string | null;
  /** Why that lean began (read.previous.reason). */
  why: string | null;
  /** The row's own persistence reason, used when `why` is missing. */
  reason: string | null;
};

/**
 * The lean's history: one entry per run of the same lean, newest first, stamped when the run began and
 * carrying the reason it began. Rows may arrive in any order and any density — a run is identified by its
 * lean and its start, so periodic rows and late writes collapse into the run they belong to.
 */
export function readHistoryOf(rows: ReadRowLite[], limit = 20): ReadHistoryItem[] {
  const sorted = [...rows].filter((r) => Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
  const out: ReadHistoryItem[] = [];
  let lastKey = "";
  for (const r of sorted) {
    const key = `${r.lean}|${r.since ?? ""}`;
    if (key === lastKey) continue;
    lastKey = key;
    out.push({ at: r.since ?? r.at, lean: r.lean, reason: r.why ?? r.reason ?? "", summary: r.summary ?? "" });
  }
  return out.reverse().slice(0, limit);
}

/** The same reduction for reads held in memory (replay). */
export const rowOfRead = (r: AtlasRead, reason: string | null = null): ReadRowLite => ({
  at: r.at, lean: r.lean, since: r.since, summary: r.summary, why: r.previous?.reason ?? null, reason,
});
