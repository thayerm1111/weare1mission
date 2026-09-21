/**
 * ATLAS — the perception pass.
 *
 * One function, run on every worker tick, that turns "a new snapshot arrived" into everything the product
 * needs: what changed, what was worth noticing, how loud it is allowed to be, what Atlas now believes,
 * and whether it should say something out loud.
 *
 * It is pure. Persistence and the language model live outside it, so this whole pipeline can be replayed
 * against a recorded day and produce identical output.
 */
import type { MarketSnapshot } from "../core/types";
import type { BrainMemory, BrainState, BrainStatement, BrainThesis, PerceptionEvent, SnapshotDiff } from "./types";
import { diffSet } from "./diff";
import { detect } from "./perception";
import { significant, toSpeak } from "./significance";
import { brainState } from "./presence";
import { update as updateThesis } from "./thesis";
import { memoryOf, pushEvents, pushSnapshot, pushStatement, pushThesis, type Rolling } from "./memory";

export type PerceiveInput = {
  rolling: Rolling;
  snapshot: MarketSnapshot;
  tradeActive?: boolean;
  tradeProtecting?: boolean;
  /** Minimum gap between spoken comments. Comes from the user's voice mode. */
  quietMs?: number;
};

export type PerceiveResult = {
  rolling: Rolling;
  diffs: SnapshotDiff[];
  events: PerceptionEvent[];
  state: BrainState;
  thesis: BrainThesis;
  /** Set when the thesis closed this pass — this is the "I changed my mind" record. */
  closedThesis: BrainThesis | null;
  thesisChange: "none" | "strengthened" | "weakened" | "changed_mind" | "opened";
  /** The one thing it decided to say, if anything. Null is the common and correct case. */
  statement: BrainStatement | null;
  memory: BrainMemory;
};

export function perceive(i: PerceiveInput): PerceiveResult {
  const s = i.snapshot;
  const prev = i.rolling.snapshots.length ? i.rolling.snapshots[i.rolling.snapshots.length - 1] : null;

  // 1. what changed
  const diffs = diffSet(s, i.rolling.snapshots);

  // 2. what a trader would have noticed
  const raw = detect({ now: s, prev, diffs });

  // 3. what is loud enough to matter
  const events = significant(raw, {
    snapshot: s,
    recent: i.rolling.events,
    lastSpokeAt: i.rolling.lastSpokeAt,
    quietMs: i.quietMs,
    tradeActive: i.tradeActive,
  });

  // 4. what it now believes
  const existing = [...i.rolling.theses].reverse().find((t) => !t.endedAt) ?? null;
  const tu = updateThesis(existing, s, diffs, events);

  // 5. how it presents itself
  const state = brainState({
    snapshot: s, thesis: tu.thesis, events,
    tradeActive: i.tradeActive, tradeProtecting: i.tradeProtecting,
  });

  // 6. commit to memory
  let rolling = pushSnapshot(i.rolling, s);
  rolling = pushEvents(rolling, events, s.at);
  if (tu.previous) rolling = pushThesis(rolling, tu.previous);
  rolling = pushThesis(rolling, tu.thesis);

  // 7. decide whether to speak. A thesis change always earns a sentence; otherwise only an event that
  //    made it through the significance gate does. Silence is the default and it is deliberate.
  let statement: BrainStatement | null = null;
  const spoken = toSpeak(events);

  // Restraint applies to its opinions too. A change of mind always earns a sentence; "this is getting
  // stronger" does not need saying every five minutes, so it waits its turn.
  const lastShade = [...i.rolling.statements].reverse().find((x) => x.kind === "thesis_change");
  const shadeAllowed = !lastShade || s.at - lastShade.at >= 6 * 60_000;
  const shadeChange = tu.change === "weakened" || tu.change === "strengthened";

  if (tu.change === "changed_mind" || (shadeChange && shadeAllowed)) {
    statement = {
      at: s.at,
      kind: "thesis_change",
      text: tu.statement,
      channel: tu.change === "changed_mind" ? "voice" : "text",
      priceAt: s.price,
      thesisId: tu.thesis.id,
    };
  } else if (spoken) {
    statement = {
      at: s.at,
      kind: spoken.channel === "urgent" ? "alert" : "observation",
      text: spoken.detail,
      channel: spoken.channel,
      priceAt: s.price,
      thesisId: tu.thesis.id,
    };
  }
  if (statement) rolling = pushStatement(rolling, statement);

  return {
    rolling,
    diffs,
    events,
    state,
    thesis: tu.thesis,
    closedThesis: tu.previous,
    thesisChange: tu.change,
    statement,
    memory: memoryOf(rolling, s, diffs, state),
  };
}

export * from "./types";
export { diffSet, diffFor } from "./diff";
export { detect, nearestLevel } from "./perception";
export { significant, score, route, toSpeak } from "./significance";
export { brainState, presenceOf, weather, velocityBand, intensity } from "./presence";
export { propose, open as openThesis, update as updateThesis, biasLabel, biasDirection, strengthOf } from "./thesis";
export * as memory from "./memory";
export { briefing, whatChanged, why, whatWouldChangeMyMind, answer, marketRead, scenarioOf, classify, mathLines } from "./language";
export { contextPacket, BRAIN_SYSTEM } from "./context";
