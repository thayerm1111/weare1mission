"use client";
import { useEffect, useState } from "react";
import {
  NO_EXPLANATION, buildExplanation, correctionLine, crossedWatch, explainStep, nextShownSegment,
  type Annotation, type ExplainContext, type ExplainEvent, type ExplainState, type Explanation,
} from "../../../../command-center/core/explain";
import type { ChartAction } from "../../../../command-center/core/atlasContract";

/**
 * ATLAS'S EXPLANATION, SHARED ACROSS THE DESK.
 *
 * Three parts of the screen have to agree about what ATLAS is pointing at right now: the voice line (which
 * knows which character is being spoken), the chat (which gets a whole answer at once) and the chart (which
 * draws). This is the one small store between them — the same pattern as voiceBus — holding the state that
 * command-center/core/explain.ts steps purely.
 *
 * The screen hands it the CONTEXT (what is real for this snapshot: levels, the read, scenarios, candles, the
 * price). An answer is then explained against that context and nothing else: a number in the answer that
 * resolves to nothing real draws nothing.
 *
 * Every response gets the next sequence number here, in the order it was started, so a slow old answer can
 * never draw over a newer one.
 */

let state: ExplainState = NO_EXPLANATION;
let ctx: ExplainContext | null = null;
let seq = 0;
const subs = new Set<(s: ExplainState) => void>();
/** What the member pointed at with their question (a tapped candle): the next answer starts on it. */
let pending: { anns: Annotation[]; until: number } | null = null;
/** …and the response that took it, so more of that response arriving keeps it. */
let lead: { responseId: string; anns: Annotation[] } | null = null;
const POINT_TTL_MS = 45_000;
/** Told once when the market overtakes the explanation that is playing (the voice line says it). */
const correctionSubs = new Set<(text: string, during: boolean) => void>();

/**
 * FAIL SOFT. The voice line calls this store from inside its audio path, and the console from inside an answer:
 * nothing that goes wrong while explaining may ever cost the member their audio or their answer. A failure
 * here means the chart simply does not annotate that reply.
 */
function dispatch(e: ExplainEvent): void {
  let next: ExplainState;
  try { next = explainStep(state, e, Date.now()); } catch { return; }
  if (next === state) return;
  state = next;
  subs.forEach((f) => { try { f(state); } catch { /* one listener failing does not stop the others */ } });
}
/** The status as it is now (a dispatch has just changed it; the compiler cannot see that). */
const statusNow = (): ExplainState["status"] => state.status;
const build = (input: Parameters<typeof buildExplanation>[0]): Explanation | null => {
  try { return buildExplanation(input); } catch { return null; }
};

export const explainBus = {
  get: () => state,
  subscribe(f: (s: ExplainState) => void) { subs.add(f); return () => { subs.delete(f); }; },

  /** What is real on the screen right now. Called by the desk whenever the read, levels or candles change. */
  setContext(c: ExplainContext | null) { ctx = c; },
  context: () => ctx,

  /**
   * A new answer. Builds its explanation against the screen's context and starts it. A typed answer shows its
   * whole sequence at once (there is no audio to follow); a spoken one is advanced by `progress`.
   */
  begin(responseId: string, text: string, opts: { actions?: ChartAction[]; typed?: boolean; priceAt?: number | null } = {}): Explanation | null {
    if (!ctx || !text.trim()) return null;
    // `priceAt`: the price the answer was BUILT from, when the server says (the typed console's response does).
    // The explanation stands on that price; the live one is then checked against it straight away (below).
    const builtOn = opts.priceAt != null && Number.isFinite(opts.priceAt) && opts.priceAt > 0 ? opts.priceAt : ctx.price;
    const now = Date.now();
    lead = pending && now <= pending.until ? { responseId, anns: pending.anns } : null;
    pending = null;
    const ex = build({ responseId, text, ctx: { ...ctx, price: builtOn, now }, actions: opts.actions, lead: lead?.anns });
    if (!ex) return null;
    dispatch({ type: "begin", seq: ++seq, explanation: ex });
    if (opts.typed) {
      dispatch({ type: "end", responseId });
      // Nothing is spoken, so nothing would ever be emphasised: point at the first thing the answer refers to.
      const first = nextShownSegment(ex, -1);
      if (first >= 0) dispatch({ type: "show", segment: first });
    }
    /* REVALIDATED BEFORE IT IS SHOWN OR SAID: an answer takes a moment to arrive. If gold has already traded
       through a level it stands on since it was built, that is said now rather than discovered later. */
    if (builtOn !== ctx.price) this.onPrice(ctx.price);
    return ex;
  },
  /**
   * More of the same spoken response is known (its words arrive with its audio, ahead of being heard). The
   * explanation is rebuilt against the same real context and replaced in place.
   */
  update(responseId: string, text: string): boolean {
    if (!ctx || !text.trim() || state.explanation?.responseId !== responseId || state.status !== "explaining") return false;
    const ex = build({ responseId, text, ctx: { ...ctx, now: Date.now() }, lead: lead?.responseId === responseId ? lead.anns : undefined });
    if (!ex) return false;
    dispatch({ type: "update", responseId, explanation: ex });
    return true;
  },
  /**
   * The member is asking about something they pointed at themselves — the candle they tapped. The answer to
   * their next question starts with it marked, whatever words the answer uses. Forgotten if no answer comes.
   */
  pointNextAt(anns: Annotation[]) { pending = anns.length ? { anns, until: Date.now() + POINT_TTL_MS } : null; },
  /** `chars` characters of that response have been spoken (from the audio clock, never from a timer). */
  progress(responseId: string, chars: number) { dispatch({ type: "progress", responseId, chars }); },
  end(responseId: string) { dispatch({ type: "end", responseId }); },
  /** Interrupted or stopped: nothing further from that response reaches the chart. */
  cancel(responseId: string) { dispatch({ type: "cancel", responseId }); },
  /** Whatever is being explained right now stops (STOP, a new question, the line closing). */
  cancelCurrent() { const id = state.explanation?.responseId; if (id && state.status === "explaining") dispatch({ type: "cancel", responseId: id }); },
  focus(id: string) { dispatch({ type: "focus", id }); },
  /**
   * "Show me": step to the next part of the last answer that points at something, and emphasise it. Returns
   * false when there is nothing to show (no answer yet, or one that referred to nothing real).
   */
  showNext(): boolean {
    if (state.status === "explaining") return true;            // it is already being shown
    const i = nextShownSegment(state.explanation, state.status === "showing" ? state.segment : -1);
    if (i < 0) return false;
    dispatch({ type: "show", segment: i });
    return true;
  },
  /** Stop emphasising (and dismiss a correction caption); what is on the chart stays, at rest. */
  rest() { dispatch({ type: "rest" }); },
  remove(id: string) { dispatch({ type: "remove", id }); },
  prune() { dispatch({ type: "prune" }); },
  /** "Clear Atlas drawings": every ATLAS annotation, and nothing of the member's. */
  clear() { dispatch({ type: "clear" }); },

  /**
   * A new price. If it has traded through something the current explanation stands on, the explanation is
   * marked corrected — once — and the correction line is returned (and sent to whoever speaks it).
   */
  onPrice(price: number | null): string | null {
    const ex = state.explanation;
    if (!ex || price == null || (state.status !== "explaining" && state.status !== "done" && state.status !== "showing")) return null;
    const w = crossedWatch(ex, price, Date.now());
    if (!w) return null;
    const during = state.status === "explaining";
    const text = correctionLine(w, price);
    dispatch({ type: "correct", responseId: ex.responseId, text });
    if (statusNow() !== "corrected") return null;              // it was not taken: say nothing
    correctionSubs.forEach((f) => { try { f(text, during); } catch { /* the caption still shows it */ } });
    return text;
  },
  onCorrection(f: (text: string, during: boolean) => void) { correctionSubs.add(f); return () => { correctionSubs.delete(f); }; },

  /** Tests and the replay: start from nothing. */
  reset() { state = NO_EXPLANATION; ctx = null; seq = 0; pending = null; lead = null; subs.forEach((f) => f(state)); },
};

export function useExplain(): ExplainState {
  const [s, setS] = useState(state);
  useEffect(() => explainBus.subscribe(setS), []);
  return s;
}

/* ── the member's own drawings: a separate layer ATLAS never touches ───────────────────────────────── */

export type UserLine = { id: string; price: number; at: number };
const USER_KEY = "cc-user-lines-v1";
let userLines: UserLine[] | null = null;
const userSubs = new Set<(l: UserLine[]) => void>();

function loadUserLines(): UserLine[] {
  if (userLines) return userLines;
  try {
    const raw = JSON.parse(localStorage.getItem(USER_KEY) ?? "[]");
    userLines = Array.isArray(raw) ? raw.filter((x) => x && typeof x.id === "string" && Number.isFinite(x.price) && x.price > 0).slice(-12) : [];
  } catch { userLines = []; }
  return userLines;
}
function saveUserLines(next: UserLine[]) {
  userLines = next;
  try { localStorage.setItem(USER_KEY, JSON.stringify(next)); } catch { /* private mode: kept for this visit */ }
  userSubs.forEach((f) => f(next));
}

/** The member's lines. Kept in this browser; "Clear Atlas drawings" never removes one. */
export const userDrawings = {
  get: loadUserLines,
  add(price: number) {
    if (!Number.isFinite(price) || price <= 0) return;
    const p = Math.round(price * 100) / 100;
    saveUserLines([...loadUserLines().filter((l) => Math.abs(l.price - p) > 0.005), { id: `u${Date.now().toString(36)}`, price: p, at: Date.now() }].slice(-12));
  },
  remove(id: string) { saveUserLines(loadUserLines().filter((l) => l.id !== id)); },
  clear() { saveUserLines([]); },
  subscribe(f: (l: UserLine[]) => void) { userSubs.add(f); return () => { userSubs.delete(f); }; },
};

export function useUserDrawings(): UserLine[] {
  const [l, setL] = useState<UserLine[]>([]);
  useEffect(() => { setL(loadUserLines()); return userDrawings.subscribe(setL); }, []);
  return l;
}
