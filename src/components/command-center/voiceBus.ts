"use client";
import { useEffect, useState } from "react";
import type { CommentaryKind, CommentaryMode, CommentarySettings } from "../../../command-center/core/commentary";
import type { InputMode, LineActivity, PttStyle } from "./voiceLine";

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
 *
 * TWO WAYS TO READ THE STATE. `status` is the field the HUD has always read, and keeps exactly the values and
 * meaning it maps (thinking is published as "speaking" at outLevel 0, which the HUD shows as THINKING).
 * `activity` is the precise state — listening, hearing you, thinking, speaking, mic muted, push-to-talk —
 * for any surface that wants to say it directly.
 */
export type CommentaryNote = { id: string; at: number; kind: CommentaryKind; text: string; spoken: boolean };

export type VoiceBusState = {
  status: "idle" | "connecting" | "awaiting_mic" | "listening" | "speaking" | "muted" | "disconnected" | "error" | "locked";
  /** 0–1: how loud you are right now — only what is actually being sent (0 while muted). */
  inLevel: number;
  /** 0–1: how loud ATLAS is right now, measured from the audio playing. */
  outLevel: number;
  /** The last thing you said, and the last thing ATLAS said. */
  you: string | null;
  atlas: string | null;
  error: string | null;
  /** Voice needs the subscription before it can open. */
  needsSubscription: boolean;

  /** The precise state of the line (voiceLine.ts). */
  activity: LineActivity;
  micMuted: boolean;
  speakerMuted: boolean;
  inputMode: InputMode;
  pttStyle: PttStyle;
  /** Push-to-talk is held (or toggled on). */
  pttOpen: boolean;
  /** Your words as you say them (the provider's live partial transcript), until the turn is final. */
  partial: string | null;
  /** Proactive commentary: the mode, the copilot cooldown, and the latest volunteered lines (newest last). */
  commentaryMode: CommentaryMode;
  copilotCooldownMs: number;
  commentary: CommentaryNote[];
  /** Measured on the last reply: milliseconds from the end of the question to the first audio. Null until one. */
  firstAudioMs: number | null;
  /** Times ATLAS's own voice came back through the microphone and was not treated as a question. */
  echoesDropped: number;
};

let state: VoiceBusState = {
  status: "idle", inLevel: 0, outLevel: 0, you: null, atlas: null, error: null, needsSubscription: false,
  activity: "off", micMuted: false, speakerMuted: false, inputMode: "hands_free", pttStyle: "hold", pttOpen: false,
  partial: null, commentaryMode: "watch", copilotCooldownMs: 90_000, commentary: [],
  firstAudioMs: null, echoesDropped: 0,
};
const subs = new Set<(s: VoiceBusState) => void>();

export type VoiceCommands = {
  start: () => void;
  end: () => void;
  /** Stop ATLAS mid-word. The line stays open. */
  stopSpeaking?: () => void;
  setMicMuted?: (muted: boolean) => void;
  setSpeakerMuted?: (muted: boolean) => void;
  setInputMode?: (mode: InputMode) => void;
  setPttStyle?: (style: PttStyle) => void;
  /** Push-to-talk from another surface: true while held. */
  pushToTalk?: (down: boolean) => void;
  /** The text fallback: send a typed turn on the open line. True when it was sent. */
  sendText?: (text: string) => boolean;
  /** The market overtook what ATLAS was saying: stop that reply and say this one line instead. */
  correct?: (text: string) => void;
  setCommentary?: (s: Partial<CommentarySettings>) => void;
};
let commands: VoiceCommands | null = null;

/*
 * THE LIVE PAYLOAD, FOR THE COMMENTARY ENGINE.
 *
 * Whoever already polls /api/command-center/live hands each payload to `feedLive`, and VoiceSession's
 * commentary engine reads it from here — one poll, not two. Kept off the state above so a payload arriving
 * every few seconds does not re-render every subscriber of the line.
 */
const liveSubs = new Set<(p: unknown) => void>();
let lastLive: { payload: unknown; at: number } | null = null;

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
  register(c: VoiceCommands) {
    commands = c;
    return () => { if (commands === c) commands = null; };
  },
  start: () => commands?.start(),
  end: () => commands?.end(),
  stopSpeaking: () => commands?.stopSpeaking?.(),
  setMicMuted: (m: boolean) => commands?.setMicMuted?.(m),
  setSpeakerMuted: (m: boolean) => commands?.setSpeakerMuted?.(m),
  setInputMode: (m: InputMode) => commands?.setInputMode?.(m),
  setPttStyle: (s: PttStyle) => commands?.setPttStyle?.(s),
  pushToTalk: (down: boolean) => commands?.pushToTalk?.(down),
  sendText: (t: string): boolean => commands?.sendText?.(t) ?? false,
  correct: (t: string) => commands?.correct?.(t),
  setCommentary: (s: Partial<CommentarySettings>) => commands?.setCommentary?.(s),
  ready: () => !!commands?.start,

  /** Hand the commentary engine the live payload you already have (e.g. in the HUD's /live poll). */
  feedLive(payload: unknown) {
    if (!payload || typeof payload !== "object") return;
    lastLive = { payload, at: Date.now() };
    liveSubs.forEach((f) => f(payload));
  },
  onLive(f: (p: unknown) => void) { liveSubs.add(f); return () => { liveSubs.delete(f); }; },
  lastLive: () => lastLive,
};

export function useVoiceBus(): VoiceBusState {
  const [s, setS] = useState(state);
  useEffect(() => voiceBus.subscribe(setS), []);
  return s;
}

export const lineOpen = (st: VoiceBusState["status"]) =>
  st === "connecting" || st === "awaiting_mic" || st === "listening" || st === "speaking" || st === "muted";
