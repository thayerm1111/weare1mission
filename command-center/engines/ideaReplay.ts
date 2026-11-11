/**
 * ATLAS TRADE IDEA — ON THE REPLAY.
 *
 * The replay screen stands at one moment of a recorded gold session (engines/replay.ts). This generates the
 * idea ATLAS would have given at that moment, with exactly the engine the live route uses, and — because the
 * recording carries on after that moment — follows it on the recorded candles that came next.
 *
 * It is a fixture, and everything it returns says so: nothing here reads the live tables, nothing is kept,
 * and a replayed result is a demonstration of the grading, never a track record.
 */
import fixture from "../fixtures/replay-bars.json";
import type { Bar } from "../core/types";
import { PIP } from "../core/types";
import { replay } from "./replay";
import { findSetup } from "./setup";
import { DEFAULT_PROFILE, asSetupProfile } from "./profile";
import { buildIdea, followIdea, ideaOptionsOf, type AtlasIdea, type IdeaFollow } from "./idea";

type Row = [number, number, number, number, number];
const m5All = (): Bar[] => (fixture.m5 as Row[]).map(([t, o, h, l, c]) => ({ t: t * 1000, o, h, l, c }));

/** How far back from the end of the recording the replay may stand, in 5-minute candles. */
export const REPLAY_MAX_END = 100;
export const replayEndOf = (raw: unknown): number => {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(REPLAY_MAX_END, n) : 0;
};

export function replayIdea(rawOptions: unknown, end = 0): AtlasIdea {
  const options = ideaOptionsOf(rawOptions);
  const r = replay(46, false, end);
  const thesis = r.state.thesis;
  const own = asSetupProfile(DEFAULT_PROFILE);
  const pick = r.state.setup;
  const setup = options.style === "auto" ? pick : findSetup({
    snapshot: r.snapshot, diffs: r.diffs, marketOpen: true, now: r.snapshot.at,
    thesisBias: thesis?.bias ?? null, thesisConfidence: thesis?.confidence ?? null,
    profile: { ...own, allowQuick: options.style === "quick", allowHold: options.style === "hold", allowSwing: options.style === "swing" },
  });
  const takeable = options.style === "auto"
    || (setup.state === pick.state && setup.side === pick.side && setup.style === pick.style && setup.stop === pick.stop);
  const idea = buildIdea({
    snapshot: r.snapshot, snapshotId: null, setup, takeable, read: r.state.read, scenarios: r.state.scenarios, options,
    marketOpen: true, stale: false, tradeActive: false, minConfidence: DEFAULT_PROFILE.minConfidence,
    enginePick: takeable ? null : pick, pipSize: PIP, now: r.endedAt,
  });
  // A replayed idea is addressed by where it stands and how it was asked for; nothing is stored.
  return { ...idea, id: `replay:${end}:${options.style}` };
}

/** The recorded candles after that moment, and ATLAS's lean as it changed through them. */
export function replayFollow(id: string): { idea: AtlasIdea; follow: IdeaFollow } | null {
  const m = /^replay:(\d+):(auto|quick|hold|swing)$/.exec(id);
  if (!m) return null;
  const end = replayEndOf(m[1]);
  const idea = replayIdea({ style: m[2] }, end);
  const bars = m5All();
  const last = bars[bars.length - 1];
  const full = replay(bars.length - 70, false, 0);
  const leans: { at: number; lean: string }[] = [];
  for (const st of full.atlas) if (!leans.length || leans[leans.length - 1].lean !== st.read.lean) leans.push({ at: st.at, lean: st.read.lean });
  const follow = followIdea(idea, { price: last.c, bars, tf: "5m", now: last.t + 5 * 60_000, leans, pipSize: PIP });
  return { idea, follow };
}
