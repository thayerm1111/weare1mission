"use client";
import { useEffect, useState } from "react";

/**
 * THE VOICE LINE, SHARED.
 *
 * The line lives in VoiceSession (one socket, one microphone, one meter). Other parts of the screen —
 * the ATLAS core you tap to talk — need to start it, end it, and react to it: glow while you speak,
 * pulse with ATLAS's voice, show the words. This is the smallest thing that lets them, without a
 * second copy of the line or a context provider around the whole desk.
 *
 * start() must be callable synchronously inside the tap: Safari only lets audio begin inside the user
 * gesture that asked for it, so the orb calls straight through to VoiceSession's own start.
 */
export type VoiceBusState = {
  status: "idle" | "connecting" | "awaiting_mic" | "listening" | "speaking" | "muted" | "disconnected" | "error" | "locked";
  /** 0–1: how loud you are right now. */
  inLevel: number;
  /** 0–1: how loud ATLAS is right now. */
  outLevel: number;
  /** The last thing you said, and the last thing ATLAS said. */
  you: string | null;
  atlas: string | null;
  error: string | null;
  /** Voice needs the subscription before it can open. */
  needsSubscription: boolean;
};

let state: VoiceBusState = { status: "idle", inLevel: 0, outLevel: 0, you: null, atlas: null, error: null, needsSubscription: false };
const subs = new Set<(s: VoiceBusState) => void>();
const commands: { start?: () => void; end?: () => void } = {};

export const voiceBus = {
  get: () => state,
  set(patch: Partial<VoiceBusState>) {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof VoiceBusState)[]) if (state[k] !== patch[k]) { changed = true; break; }
    if (!changed) return;
    state = { ...state, ...patch };
    subs.forEach((f) => f(state));
  },
  subscribe(f: (s: VoiceBusState) => void) { subs.add(f); return () => { subs.delete(f); }; },
  register(c: { start: () => void; end: () => void }) { commands.start = c.start; commands.end = c.end; return () => { if (commands.start === c.start) { commands.start = undefined; commands.end = undefined; } }; },
  start: () => commands.start?.(),
  end: () => commands.end?.(),
  ready: () => !!commands.start,
};

export function useVoiceBus(): VoiceBusState {
  const [s, setS] = useState(state);
  useEffect(() => voiceBus.subscribe(setS), []);
  return s;
}

export const lineOpen = (st: VoiceBusState["status"]) =>
  st === "connecting" || st === "awaiting_mic" || st === "listening" || st === "speaking" || st === "muted";
