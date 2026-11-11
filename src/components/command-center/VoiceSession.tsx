"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VOICE_TOPUPS } from "@/lib/voicePlan";
import { voiceBus, type CommentaryNote } from "./voiceBus";
import { Hand, Mic, MicOff, PhoneOff, Radio, Send, Square, Volume2, VolumeX } from "lucide-react";
import { VoicePresence, type PresenceMode } from "./VoicePresence";
import {
  ACTIVITY_LABEL, NO_WATERMARKS, audioPlayable, busInLevel, busOutLevel, cleanTypedText, commentaryRoute,
  legacyStatus, lineActivity, spaceBelongsToLine, voiceStatus,
  type AudioWatermarks, type Connection, type InputMode, type LineActivity, type PttStyle, type VoiceStatus,
} from "./voiceLine";
import {
  COMMENTARY_MODES, COPILOT_COOLDOWNS_MS, DEFAULT_COMMENTARY_SETTINGS, clampCooldown, initialCommentaryState,
  isVolunteeredTurn, observeCommentary, retuneCommentary, takeNextCommentary, volunteeredTurn,
  type CommentaryInput, type CommentaryMode, type CommentarySettings,
} from "../../../command-center/core/commentary";

export type { VoiceStatus } from "./voiceLine";

/**
 * TALK WITH ATLAS — one continuous session, not a button you hold (unless you want one).
 *
 * The old console was press-to-talk: a microphone button before every sentence, and a speech synthesiser
 * that could not be stopped once it started. That is a demo. This is a line you open once and then
 * simply talk on, and three things make the difference:
 *
 *   INTERRUPTION IS REAL. When the member starts speaking, playback stops on the same tick and every
 *   queued sentence that has not begun is thrown away — and audio from the reply that was talked over is
 *   refused even if it arrives late (the provider's event ids, the same rule the official SDK uses). STOP
 *   does the same without saying a word.
 *
 *   WE TRACK WHAT WAS HEARD, NOT WHAT WAS GENERATED. Those are different things the moment anybody
 *   interrupts. Where the provider sends character timing, the transcript writes ATLAS's words as they are
 *   actually spoken, and a reply cut short shows only what was said.
 *
 *   STOPPING THE VOICE IS NOT STOPPING THE SYSTEM. Muting a microphone, closing this panel, or losing
 *   the socket has no effect on market monitoring, on an open position, or on an order already in
 *   flight. Those live on the server precisely so that a browser tab is never load-bearing.
 *
 * HANDS-FREE OR PUSH-TO-TALK. Hands-free sends the microphone continuously and the provider decides when you
 * have finished. Push-to-talk (hold or toggle; Space on the keyboard) sends it only while the key is down and
 * silence otherwise — the same silence frames the SDK sends when muted, so the provider's turn-taking still
 * hears you stop. Microphone mute and speaker mute are separate: one stops ATLAS hearing you, the other stops
 * you hearing ATLAS (the words still appear here).
 *
 * VOLUNTEERED COMMENTARY (command-center/core/commentary.ts). Quiet, Watch or Session copilot. On a call a
 * volunteered line is spoken into a real pause; off a call it is written here instead — there is no separate
 * paid voice for it, and a volunteered line never keeps an idle line open.
 *
 * The provider is transport only. Reasoning happens on our side, through the same BRAIN the screen uses.
 */

const C = {
  panel: "#0A0E15", raised: "#0E131C", line: "rgba(255,255,255,0.07)",
  text: "#E8EFF7", mut: "rgba(232,239,247,0.56)", mut2: "rgba(232,239,247,0.34)",
  gold: "#F0C475", up: "#3FD9A0", down: "#F4737B", cold: "#6FA8DC", amber: "#E9B949",
};

/** How long to wait for a microphone before saying so. It can hang forever — see `start`. */
const MIC_TIMEOUT_MS = 20_000;

/**
 * DEVICES THAT CANNOT HEAR ANYTHING.
 *
 * Loopback and virtual drivers — BlackHole, Soundflower, VB-Audio, the input a conferencing app
 * installs — exist to carry audio BETWEEN applications. Nothing is connected to the other end of one
 * unless somebody deliberately routed it there, so as a microphone they produce a perfect, unbroken
 * stream of digital silence: a live track, unmuted, sending real frames, every sample zero.
 *
 * A browser will hand one over as the default without comment if it sorts first, and then every
 * symptom points at the voice system. This is how 444 frames of nothing got sent and diagnosed as a
 * provider fault. Matched by name because it is the only signal available before opening the device.
 */
const IDLE_HANGUP_MS = 40_000;

const VIRTUAL_INPUT = /blackhole|soundflower|loopback|vb-?audio|voicemeeter|virtual|aggregate|zoomaudio|krisp|obs|ndi|teams audio/i;

/** The provider's own per-call cap (engines/voice.ts MAX_CALL_SECONDS); the session route sends the real one. */
const DEFAULT_MAX_CALL_SECONDS = 900;
/** A peak above this on a live microphone is somebody talking. */
const SPEECH_LEVEL = 0.03;
/** A live partial transcript means "hearing you" for this long. */
const PARTIAL_HOLD_MS = 1_500;
/** A reply that never comes stops being "thinking" after this. */
const REPLY_WAIT_MS = 25_000;
/** A reply that ran dry with more still due is "thinking" for at most this long. */
const REPLY_DRY_MS = 2_500;
/** The end of the last word: playback this recently counts as still speaking (bridges chunk gaps). */
const PLAY_TAIL_MS = 250;
/** Without a live payload handed in, the commentary engine reads /live itself at this pace. */
const SELF_POLL_MS = 15_000;
/** A payload handed in by the host within this long means the host is feeding us. */
const EXTERNAL_FRESH_MS = 30_000;
const PREFS_KEY = "cc.voice.prefs.v1";

export type VoiceTurn = {
  id: string;
  who: "you" | "brain";
  /** What you said or typed; for ATLAS, the full reply once the provider sends it. */
  text: string;
  heard: boolean;
  at: number;
  /** ATLAS: the words already spoken, from the provider's character timing (absent without it). */
  spoken?: string | null;
  /** ATLAS: stopped or talked over before the end. */
  cut?: boolean;
  source?: "voice" | "typed" | "volunteered";
  /** ATLAS: the provider's response id. */
  eventId?: number | null;
};

type Alignment = { chars?: string[]; char_start_times_ms?: number[]; char_durations_ms?: number[] };

type SessionInfo = {
  ok: boolean; enabled?: boolean; configured?: boolean; reason?: string | null; missing?: string[];
  needsSubscription?: boolean;
  offer?: { priceUsd: number; includedMinutes: number; blurb: string; plans?: { id: string; priceUsd: number; minutes: number }[] } | null;
  budget?: { usedMinutes: number; budgetMinutes: number; remainingMinutes: number; exhausted: boolean };
};

/** Base64 of raw PCM16 little-endian, which is what the provider wants on the wire. */
function pcm16ToBase64(input: Float32Array): string {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(out.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToPcm16(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** Straight-line decimation to the rate the provider expects. Good enough for speech, and cheap. */
function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, sec % 60)).padStart(2, "0")}`;

export function VoiceSession({ onUiAction, onStatus, live }: {
  onUiAction?: (name: string, arg: string | number | null) => void;
  /** Reported outward so a host surface can show the line's state without owning it. */
  onStatus?: (s: VoiceStatus) => void;
  /**
   * The live payload the host already polls (/api/command-center/live). Optional: without it (or
   * voiceBus.feedLive) the commentary engine reads /live itself, more slowly, while it has a mode to serve.
   */
  live?: CommentaryInput | null;
}) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [conn, setConn] = useState<Connection>("idle");
  const [micReady, setMicReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  /** Your words while you are still saying them (the provider's live partial transcript). */
  const [partial, setPartial] = useState<string | null>(null);
  const [micMuted, setMicMutedState] = useState(false);
  const [speakerMuted, setSpeakerMutedState] = useState(false);
  const [inputMode, setInputModeState] = useState<InputMode>("hands_free");
  const [pttStyle, setPttStyleState] = useState<PttStyle>("hold");
  const [pttOpen, setPttOpenState] = useState(false);
  const [settings, setSettingsState] = useState<CommentarySettings>(DEFAULT_COMMENTARY_SETTINGS);
  const [notes, setNotes] = useState<CommentaryNote[]>([]);
  const [typed, setTyped] = useState("");
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  /*
   * VISIBLE DIAGNOSTICS.
   *
   * "I pressed talk, said something, and nothing registered" is impossible to act on. These three
   * numbers turn that into a reading: is the microphone producing sound, are we sending it, and is the
   * provider answering. Whichever one is zero is the broken link.
   */
  const [diag, setDiag] = useState({ sent: 0, received: 0, level: 0, peak: 0 });
  /*
   * WHICH MICROPHONE, BY NAME.
   *
   * "Check the microphone this browser is using" is advice nobody can act on, because a browser will
   * not tell you which one it picked and its choice is frequently not the one you are talking into —
   * a disconnected headset, a webcam across the room, a virtual device from some other app. Naming it
   * and offering the alternatives turns a dead end into a two-second fix.
   */
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [micLabel, setMicLabel] = useState<string | null>(null);
  /** The operating system says this device is producing no samples — nothing to do with our mute. */
  const [deviceMuted, setDeviceMuted] = useState(false);
  const [micId, setMicId] = useState("");
  const [audioPaused, setAudioPaused] = useState(false);
  /** The 20-per-second reading of the line: what is playing, what is owed, who is talking. */
  const [frame, setFrame] = useState({ out: 0, inl: 0, playing: false, awaiting: false, speech: false, callSec: 0 });

  const ws = useRef<WebSocket | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const micNode = useRef<ScriptProcessorNode | null>(null);
  const outAnalyser = useRef<AnalyserNode | null>(null);
  const speakerGain = useRef<GainNode | null>(null);
  const playHead = useRef(0);
  const scheduled = useRef<AudioBufferSourceNode[]>([]);
  const lastPlayingAt = useRef(0);
  const outputRate = useRef(16000);
  const inputRate = useRef(16000);
  /** The member's microphone mute. Read on every audio frame, so it is a ref. */
  const mutedRef = useRef(false);
  const speakerMutedRef = useRef(false);
  const inputModeRef = useRef<InputMode>("hands_free");
  const pttStyleRef = useRef<PttStyle>("hold");
  const pttOpenRef = useRef(false);
  const connRef = useRef<Connection>("idle");
  const activityRef = useRef<LineActivity>("off");
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const frames = useRef(0);
  /** Frames sent with the microphone live — what the dead-microphone check counts. */
  const liveFrames = useRef(0);
  const gotMessage = useRef(false);
  /** Every audio callback, sent or not — zero means the browser never started the audio engine. */
  const processed = useRef(0);
  /** The loudest sample this device has ever produced. A flat bar is ambiguous; this is not. */
  const loudest = useRef(0);
  /*
   * THE AMPLITUDE OF WHAT IS BEING SPOKEN, measured rather than simulated.
   *
   * The presence moves on the actual words because the alternative — a timer that animates whenever
   * the status says "speaking" — is a cartoon of a conversation. An analyser sits on the output path and
   * is read twenty times a second; where a browser offers none, every buffer scheduled for playback is
   * measured instead and the reading decays on its own so the mouth closes when the sentence ends.
   */
  const outLevel = useRef(0);
  const micTrack = useRef<MediaStreamTrack | null>(null);
  const chosenMic = useRef<string | null>(null);
  /** The microphone the member picked from the list this page visit. null = follow the computer's own input. */
  const manualMic = useRef<string | null>(null);
  const autoPicked = useRef(false);
  const rawRetry = useRef(false);

  /* The turn-taking facts (voiceLine.ts). */
  const marks = useRef<AudioWatermarks>({ ...NO_WATERMARKS });
  /** The provider response currently playing (or last played). */
  const replyEventId = useRef<number | null>(null);
  /** The provider has its final text for that response. */
  const replyComplete = useRef(true);
  /** A turn was finalised and no reply audio has started yet. */
  const pendingTurnAt = useRef<number | null>(null);
  const lastAudioAt = useRef(0);
  /** Who the reply in flight answers: the member, or a volunteered line (which never keeps the line alive). */
  const replyOwner = useRef<"member" | "volunteered">("member");
  /** STOP pressed while ATLAS was still thinking: the reply that was about to start is not played. */
  const skipNext = useRef(false);
  const skippedId = useRef<number | null>(null);
  /** Character timing per response: when each character starts on our audio clock. */
  const turnAudio = useRef(new Map<number, { chars: { c: string; t: number }[]; stoppedAt: number | null }>());
  const lastSpokenLen = useRef(-1);
  /** Local ids (negative) for a reply whose audio carries no provider event id — never expected, handled anyway. */
  const localSeq = useRef(0);
  /** The member's last activity (the idle hang-up clock), and the last time anyone's voice was on the line. */
  const lastActive = useRef(0);
  const lastVoiceAt = useRef(0);
  const lastSpeechAt = useRef(0);
  /** The peak of the last frame actually SENT (0 when muted), and when — what your ring on the orb follows. */
  const sentPeak = useRef(0);
  const sentPeakAt = useRef(0);
  const inSmooth = useRef(0);
  const lastPartialAt = useRef(0);
  const typingAt = useRef(0);
  const lastUserActivitySent = useRef(0);
  const callStartedAt = useRef<number | null>(null);
  const maxCallSec = useRef(DEFAULT_MAX_CALL_SECONDS);

  /* Commentary. */
  const engine = useRef(initialCommentaryState());
  const settingsRef = useRef<CommentarySettings>(DEFAULT_COMMENTARY_SETTINGS);
  const lastExternalLive = useRef(0);
  const transcriptBox = useRef<HTMLDivElement | null>(null);
  const stickToEnd = useRef(true);

  useEffect(() => { connRef.current = conn; }, [conn]);

  /* ── preferences (this browser only) ──────────────────────────────────── */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as { mode?: string; cooldown?: number; input?: string; ptt?: string };
      const mode = COMMENTARY_MODES.some((m) => m.id === p.mode) ? (p.mode as CommentaryMode) : DEFAULT_COMMENTARY_SETTINGS.mode;
      const next = { mode, copilotCooldownMs: clampCooldown(Number(p.cooldown ?? DEFAULT_COMMENTARY_SETTINGS.copilotCooldownMs)) };
      settingsRef.current = next;
      setSettingsState(next);
      if (p.input === "push_to_talk" || p.input === "hands_free") { inputModeRef.current = p.input; setInputModeState(p.input); }
      if (p.ptt === "hold" || p.ptt === "toggle") { pttStyleRef.current = p.ptt; setPttStyleState(p.ptt); }
    } catch { /* storage blocked: the defaults stand */ }
  }, []);
  const savePrefs = useCallback(() => {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({
        mode: settingsRef.current.mode, cooldown: settingsRef.current.copilotCooldownMs,
        input: inputModeRef.current, ptt: pttStyleRef.current,
      }));
    } catch { /* a convenience, not a requirement */ }
  }, []);

  /* ── availability ─────────────────────────────────────────────────────── */
  useEffect(() => {
    let alive = true;
    fetch("/api/command-center/voice/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (alive) setInfo(j); })
      .catch(() => { if (alive) setInfo({ ok: false, enabled: false }); });
    return () => { alive = false; };
  }, []);

  /** What has actually been spoken of a response, from the provider's character timing. */
  const heardText = useCallback((id: number, at: number): string | null => {
    const a = turnAudio.current.get(id);
    if (!a || !a.chars.length) return null;
    const until = a.stoppedAt != null ? Math.min(a.stoppedAt, at) : at;
    let s = "";
    for (const ch of a.chars) { if (ch.t <= until) s += ch.c; else break; }
    return s;
  }, []);

  /* ── playback, and the ability to stop it instantly ───────────────────── */

  const stopPlayback = useCallback(() => {
    const ctx = audioCtx.current;
    const now = ctx?.currentTime ?? 0;
    const wasPlaying = scheduled.current.length > 0 || playHead.current > now + 0.05;
    for (const s of scheduled.current) { try { s.stop(); } catch { /* already finished */ } }
    scheduled.current = [];
    outLevel.current = 0;      // interrupted mid-word: the mouth closes immediately
    lastPlayingAt.current = 0;
    playHead.current = now;
    const id = replyEventId.current;
    if (id == null) return;
    // Whatever is still to come from this response is refused: the next response (a higher id) plays. So it is
    // over as far as this line is concerned — nothing more of it is owed, and nothing is "thinking" about it.
    marks.current = { ...marks.current, stoppedThrough: Math.max(marks.current.stoppedThrough, id) };
    const wasComplete = replyComplete.current;
    replyComplete.current = true;
    if (!wasPlaying && wasComplete) return;
    // Anything queued and never started was never heard. Saying otherwise would let ATLAS refer back
    // to a sentence the member has no memory of, which is worse than silence.
    const a = turnAudio.current.get(id);
    if (a && a.stoppedAt == null) a.stoppedAt = now;
    const said = heardText(id, now);
    setTurns((t) => t.map((x) => (x.who === "brain" && x.eventId === id ? { ...x, cut: true, spoken: said ?? x.spoken ?? null } : x)));
  }, [heardText]);

  const enqueueAudio = useCallback((b64: string, eventId: number | null, alignment: Alignment | null) => {
    const ctx = audioCtx.current;
    /*
     * MUTED MEANS THE MICROPHONE IS OFF, NOT THAT THE MEMBER HAS GONE DEAF.
     *
     * This used to drop every incoming frame while muted, so muting yourself to stop talking also
     * destroyed everything ATLAS said back — each answer arriving, being discarded, and appearing
     * on screen marked "cut off". Muting your own microphone is not a request to be ignored. (Not
     * hearing ATLAS is its own control — the speaker mute — and it lowers the volume, not the line.)
     */
    if (!ctx) return;
    const pcm = base64ToPcm16(b64);
    if (!pcm.length) return;
    const buf = ctx.createBuffer(1, pcm.length, outputRate.current);
    buf.getChannelData(0).set(pcm);

    // The loudest sample in this chunk: the level used where the browser offers no analyser.
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 8) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(outAnalyser.current ?? ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, playHead.current);
    src.start(startAt);
    playHead.current = startAt + buf.duration;
    scheduled.current.push(src);
    src.onended = () => { scheduled.current = scheduled.current.filter((s) => s !== src); };
    if (!outAnalyser.current) {
      window.setTimeout(() => { outLevel.current = peak; }, Math.max(0, (startAt - ctx.currentTime) * 1000));
    }
    // Character timing, when the provider sends it: the transcript writes each word as it is spoken.
    if (eventId != null && alignment?.chars?.length) {
      const rec = turnAudio.current.get(eventId) ?? { chars: [], stoppedAt: null };
      alignment.chars.forEach((c, i) => rec.chars.push({ c, t: startAt + (Number(alignment.char_start_times_ms?.[i]) || 0) / 1000 }));
      turnAudio.current.set(eventId, rec);
      if (turnAudio.current.size > 8) turnAudio.current.delete(turnAudio.current.keys().next().value as number);
    }
  }, []);

  /* ── teardown ─────────────────────────────────────────────────────────── */

  /**
   * Release everything the line holds: playback, the microphone (every track stopped, so the browser's
   * recording indicator goes out), the socket, the audio engine, the heartbeat. Idempotent.
   */
  const teardown = useCallback((next: Connection, reason?: string) => {
    stopPlayback();
    if (heartbeat.current) { clearInterval(heartbeat.current); heartbeat.current = null; }
    try { micNode.current?.disconnect(); } catch { /* noop */ }
    micNode.current = null;
    try { micStream.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    micStream.current = null;
    micTrack.current = null;
    try { ws.current?.close(); } catch { /* noop */ }
    ws.current = null;
    try { void audioCtx.current?.close(); } catch { /* noop */ }
    audioCtx.current = null;
    outAnalyser.current = null;
    speakerGain.current = null;
    pendingTurnAt.current = null;
    replyEventId.current = null;
    replyComplete.current = true;
    skipNext.current = false;
    callStartedAt.current = null;
    pttOpenRef.current = false;
    setPttOpenState(false);
    setMicReady(false);
    setPartial(null);
    setConn(next);
    if (reason) setError(reason);
  }, [stopPlayback]);

  /** Tell the server the line is over, so the meter stops now rather than when the reaper notices. */
  const notifyServerEnd = useCallback(() => {
    if (!ws.current) return;
    void fetch("/api/command-center/voice/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "end" }), keepalive: true,
    }).catch(() => {});
  }, []);

  /** End the call: the server stops the meter, then everything is released. */
  const endSession = useCallback(() => {
    notifyServerEnd();
    teardown("idle");
  }, [notifyServerEnd, teardown]);

  /*
   * LEAVING THE PAGE ENDS THE CALL. Unmounting the panel, or closing / navigating the tab, ends the session
   * on the server (a beacon survives the page going away) as well as releasing the microphone — otherwise the
   * meter ran on until the reaper noticed a missing heartbeat.
   */
  useEffect(() => {
    const onHide = () => {
      if (!ws.current) return;
      try {
        navigator.sendBeacon?.("/api/command-center/voice/session", new Blob([JSON.stringify({ action: "end" })], { type: "application/json" }));
      } catch { /* the reaper is the backstop */ }
      teardown("idle");
    };
    window.addEventListener("pagehide", onHide);
    return () => { window.removeEventListener("pagehide", onHide); };
  }, [teardown]);
  useEffect(() => () => { endSession(); }, [endSession]);

  /*
   * AN OPEN LINE COSTS MONEY WHETHER ANYONE TALKS OR NOT (owner 09-21).
   *
   * The speech provider bills every minute the line is open. So when nobody has said anything and ATLAS
   * has said nothing back for 40 seconds, the line closes itself, and says so. Pressing Talk reopens it
   * in a fraction of a second. The provider enforces the same limit on its side as a backstop.
   */
  useEffect(() => {
    if (conn !== "open") return;
    if (!lastActive.current) lastActive.current = Date.now();
    const id = window.setInterval(() => {
      // ATLAS STILL TALKING IS NOT QUIET (owner 09-21: "it was in the middle of talking and cut off because
      // of the 40 seconds"). A long answer arrives from the provider in a few seconds and then PLAYS for a
      // minute or more, so the clock used to run out mid-sentence. While audio is still queued to play, the
      // line is active; the 40 seconds only start once ATLAS has finished speaking and you haven't spoken.
      // A VOLUNTEERED line may finish, but it never resets the clock: commentary cannot keep an idle line
      // open and billing.
      const ctx = audioCtx.current;
      if (ctx && playHead.current > ctx.currentTime) {
        if (replyOwner.current === "member") lastActive.current = Date.now();
        return;
      }
      if (pttOpenRef.current) { lastActive.current = Date.now(); return; }   // holding the key is not quiet
      if (Date.now() - lastActive.current > IDLE_HANGUP_MS) {
        lastActive.current = 0;
        endSession();
        setError("Line closed after 40 seconds of quiet so it isn't billing minutes. Press Talk with ATLAS to start again.");
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, [conn, endSession]);

  /* ── the line, read twenty times a second ─────────────────────────────── */
  useEffect(() => {
    const buf = new Float32Array(1024);
    const id = window.setInterval(() => {
      const ctx = audioCtx.current;
      const a = outAnalyser.current;
      if (a && ctx) {
        a.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        outLevel.current = Math.min(1, Math.sqrt(sum / buf.length) * 5);
      } else {
        outLevel.current *= 0.72;
      }
      const now = Date.now();
      if (scheduled.current.length) lastPlayingAt.current = now;
      const playing = !!ctx && lastPlayingAt.current > 0 && now - lastPlayingAt.current <= PLAY_TAIL_MS;
      if (pendingTurnAt.current != null && now - pendingTurnAt.current >= REPLY_WAIT_MS) pendingTurnAt.current = null;
      const awaiting = !playing && (pendingTurnAt.current != null
        || (!replyComplete.current && lastAudioAt.current > 0 && now - lastAudioAt.current < REPLY_DRY_MS));
      const speech = now - lastSpeechAt.current < 600 || now - lastPartialAt.current < PARTIAL_HOLD_MS;
      const callSec = callStartedAt.current ? Math.floor((now - callStartedAt.current) / 1000) : 0;
      const out = playing ? Math.round(outLevel.current * 100) / 100 : 0;
      // Your level, every frame the microphone delivers (~12 a second), not every sixth: the orb's listening
      // ring follows your voice as you speak. Only what was SENT counts, and it falls to zero within 250 ms of
      // the microphone closing.
      const target = now - sentPeakAt.current < 250 ? Math.min(1, sentPeak.current * 3) : 0;
      inSmooth.current = inSmooth.current * 0.5 + target * 0.5;
      const inl = inSmooth.current < 0.01 ? 0 : Math.round(inSmooth.current * 100) / 100;

      // ATLAS's words, written as they are spoken.
      const rid = replyEventId.current;
      if (ctx && rid != null && playing) {
        const said = heardText(rid, ctx.currentTime);
        if (said != null && said.length !== lastSpokenLen.current) {
          lastSpokenLen.current = said.length;
          setTurns((t) => t.map((x) => (x.who === "brain" && x.eventId === rid && !x.cut ? { ...x, spoken: said } : x)));
        }
      }
      setFrame((f) => (f.out === out && f.inl === inl && f.playing === playing && f.awaiting === awaiting && f.speech === speech && f.callSec === callSec
        ? f : { out, inl, playing, awaiting, speech, callSec }));
    }, 50);
    return () => window.clearInterval(id);
  }, [heardText]);

  /* ── the microphone, as a separate step ───────────────────────────────── */

  /**
   * Ask for the microphone and wire it into the socket.
   *
   * Raced against a timeout ON PURPOSE. `getUserMedia` never settles when a permission prompt is ignored
   * or suppressed — no resolve, no reject, no error event — so without a race there is no moment at
   * which anything can be said to the member. With one, an unanswered prompt becomes a sentence.
   */
  const attachMicrophone = useCallback(async (ctx: AudioContext, socket: WebSocket, requested?: string) => {
    /*
     * Two passes at most: the browser's choice, and — if that turns out to be a device that cannot
     * hear — one real microphone instead. A loop rather than a recursive call, so "at most once" is a
     * property of the code rather than a promise about it.
     */
    let wanted = requested;
    for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let already: string | null = null;
      try { already = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state; }
      catch { already = null; }
      if (already === "denied") {
        setError("This browser has the microphone blocked for this site. Allow it in the address bar (or in Settings on a phone), then start the session again. You can still type to ATLAS below.");
        return;
      }

      // Switching devices mid-session: let go of the old one first, or two tracks stay open and the
      // browser keeps showing a recording indicator for a microphone nobody is using.
      try { micNode.current?.disconnect(); } catch { /* noop */ }
      micNode.current = null;
      try { micStream.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      micStream.current = null;

      /*
       * THE BROWSER'S OWN AUDIO PROCESSING CAN SILENCE A WORKING MICROPHONE.
       *
       * Echo cancellation subtracts what it believes is coming out of the speakers. When the system's
       * default OUTPUT is a virtual device — which is exactly the machine this happened on — the
       * reference signal it subtracts is wrong, and it can cancel the room, the speaker and everything
       * else down to a flat zero. Noise suppression and auto gain can finish the job in a quiet room.
       *
       * So processing is the default, because it genuinely helps most people, and `rawRetry` below
       * turns all of it off once the evidence says it is the problem.
       */
      const base: MediaTrackConstraints = rawRetry.current
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      /*
       * FOLLOW THE COMPUTER'S MICROPHONE (owner 09-22: "I want it to default the mic I'm using to what my
       * computer is using because I have to switch it every time"). A bare { audio } request gets whatever the
       * BROWSER last remembered for this site, which is not the computer's current input. Chrome and Edge expose a
       * "default" device that tracks the system input exactly, so that is asked for first; browsers without it
       * (Safari, Firefox) already use the system input and fall through to the plain request.
       */
      const ask = (constraints: MediaTrackConstraints) => Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: constraints }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("MIC_TIMEOUT")), MIC_TIMEOUT_MS)),
      ]);
      let stream: MediaStream;
      if (wanted) stream = await ask({ ...base, deviceId: { exact: wanted } });
      else {
        try { stream = await ask({ ...base, deviceId: { exact: "default" } }); }
        catch (e) {
          if (e instanceof Error && e.message === "MIC_TIMEOUT") throw e;
          stream = await ask(base);
        }
      }
      // The line may have closed while the prompt was up: do not keep a microphone for a call that is over.
      if (ws.current !== socket) { stream.getTracks().forEach((t) => t.stop()); return; }
      micStream.current = stream;

      /*
       * WHAT DID WE ACTUALLY GET?
       *
       * A granted permission is not a working microphone. The browser hands back whichever device it
       * considers default, and `track.muted` — which has nothing to do with our own mute button — is
       * the operating system saying that device is producing no samples at all. Both of those are
       * silent failures that look exactly like the provider ignoring us, so both get named out loud.
       */
      const track = stream.getAudioTracks()[0] ?? null;
      micTrack.current = track;
      // The member's own mute holds across a device switch: a disabled track captures nothing at all.
      if (track) track.enabled = !mutedRef.current;
      chosenMic.current = track?.getSettings().deviceId ?? wanted ?? null;
      setMicId(chosenMic.current ?? "");
      setMicLabel(track?.label || "the default microphone");
      setDeviceMuted(Boolean(track?.muted));
      if (track) {
        track.onmute = () => setDeviceMuted(true);
        track.onunmute = () => setDeviceMuted(false);
      }
      // Labels are only populated once permission has been granted, which is why this happens here and
      // not when the panel first renders.
      let inputs: { id: string; label: string }[] = [];
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        inputs = all.filter((d) => d.kind === "audioinput" && d.deviceId)
          .map((d) => ({ id: d.deviceId, label: d.label || "Microphone" }));
        setDevices(inputs);
      } catch { /* the list is a convenience; its absence is not a failure */ }

      /*
       * IF THE BROWSER CHOSE A DEVICE THAT CANNOT HEAR, CHOOSE A BETTER ONE.
       *
       * Once, silently, and only when the member has not picked for themselves — their choice is
       * theirs even if it is a strange one. The real microphone is preferred over the "default" entry
       * when both exist, because "default" is an alias that can point back at the virtual device.
       */
      if (!wanted && !autoPicked.current && VIRTUAL_INPUT.test(track?.label ?? "")) {
        const real = inputs.find((d) => !VIRTUAL_INPUT.test(d.label) && d.id !== "default")
          ?? inputs.find((d) => !VIRTUAL_INPUT.test(d.label));
        if (real) {
          autoPicked.current = true;
          setError(`${track?.label ?? "Your default input"} is a virtual device — it carries audio between apps and hears nothing. Switched to ${real.label}.`);
          wanted = real.id;
          continue;
        }
      }

      frames.current = 0;
      liveFrames.current = 0;
      loudest.current = 0;
      setDiag((d) => ({ ...d, sent: 0, level: 0, peak: 0 }));

      // Safari suspends the context again behind the permission prompt.
      await ctx.resume().catch(() => {});

      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      micNode.current = node;
      node.onaudioprocess = (e) => {
        processed.current += 1;
        if (processed.current === 1) setAudioPaused(false);
        const input = e.inputBuffer.getChannelData(0);
        // Peak of this frame, so the member can SEE the microphone is hearing them. A flat bar while
        // they talk is a dead track, which is a different problem from the provider not answering.
        // Measured BEFORE the socket check, so a closed line can never masquerade as a deaf microphone.
        let peak = 0;
        for (let i = 0; i < input.length; i += 16) { const v = Math.abs(input[i]); if (v > peak) peak = v; }
        // WHAT IS SENT is decided here, frame by frame: the member's mute, and push-to-talk.
        const sending = !mutedRef.current && (inputModeRef.current === "hands_free" || pttOpenRef.current);
        if (sending) {
          if (peak > loudest.current) loudest.current = peak;
          if (peak > SPEECH_LEVEL) lastSpeechAt.current = Date.now();
          sentPeak.current = peak;
          sentPeakAt.current = Date.now();
        }
        if (socket.readyState !== WebSocket.OPEN) {
          if (processed.current % 6 === 0) setDiag((d) => ({ ...d, level: Math.max(peak, d.level * 0.6), peak: loudest.current }));
          return;
        }
        // A closed microphone sends SILENCE rather than nothing — what the official SDK does when muted — so
        // the provider's turn-taking hears the speaker stop instead of a stream that simply ends mid-word.
        const pcm = downsample(sending ? input : new Float32Array(input.length), inputRate.current, 16000);
        socket.send(JSON.stringify({ user_audio_chunk: pcm16ToBase64(pcm) }));
        frames.current += 1;
        if (sending) liveFrames.current += 1;
        if (frames.current % 6 === 0) {
          setDiag((d) => ({ ...d, sent: frames.current, level: Math.max(peak, d.level * 0.6), peak: loudest.current }));
        }

        /*
         * A TRACK THAT HAS NEVER PRODUCED A SAMPLE IS NOT A TRACK THAT IS LISTENING.
         *
         * About eight seconds of live audio with an all-time peak of zero is not a quiet room — a quiet
         * room still has a noise floor. It is a dead pipeline, and the most common cause is the processing
         * above. Retried once, with everything off, and the member is told why rather than being left
         * to read a flat bar. Only frames sent with the microphone live count: muted silence is ours.
         */
        if (sending && liveFrames.current === 90 && loudest.current < 0.002 && !rawRetry.current) {
          rawRetry.current = true;
          const ctxNow = audioCtx.current, sockNow = ws.current;
          setError("That microphone produced no sound at all — the browser's echo cancellation can do that when the system output is a virtual device. Turning the processing off and trying again.");
          if (ctxNow && sockNow) void attachMicrophone(ctxNow, sockNow, chosenMic.current ?? undefined);
        }
      };
      source.connect(node);
      // A ScriptProcessor needs a destination to run at all; routing the microphone to the speakers
      // would make ATLAS talk over itself, so it goes through a silenced gain node.
      const silent = ctx.createGain();
      silent.gain.value = 0;
      node.connect(silent);
      silent.connect(ctx.destination);

      /*
       * THE AUDIO ENGINE MUST ACTUALLY BE RUNNING.
       *
       * 09-20: status LISTENING, "0 sent · 0 back · peak 0.000", twenty seconds, four times. The line was
       * open and the microphone granted, but the browser's audio engine was suspended, so the callback
       * above never ran once and nothing reached the provider. Everything looked connected.
       *
       * Two and a half seconds after attaching, a callback count of zero is that failure. Resume is tried
       * again; if the browser still refuses without a fresh click, a Resume button appears, because a
       * click is the one thing that always lets it start.
       */
      processed.current = 0;
      window.setTimeout(async () => {
        if (processed.current > 0 || audioCtx.current !== ctx) return;
        await ctx.resume().catch(() => {});
        window.setTimeout(() => {
          if (processed.current === 0 && audioCtx.current === ctx) setAudioPaused(true);
        }, 700);
      }, 2500);

      // A device chosen because the last one was deaf keeps its explanation on screen.
      if (!autoPicked.current || attempt === 0) setError(null);
      if (socket.readyState !== WebSocket.OPEN) return; // the provider already hung up; onclose said why
      setMicReady(true);
      return;
    } catch (e) {
      const name = e instanceof Error ? e.message || e.name : "";
      setError(
        name === "MIC_TIMEOUT"
          ? "I'm still waiting for microphone permission. Look for the prompt — on a phone it can appear at the top of the screen — and tap Allow. The line is open, and you can type to me meanwhile."
          : "The microphone was refused. The line is open — type to me below, or allow this site to use the microphone and start again.",
      );
      return;
    }
    }
  }, []);

  /* ── starting the line ────────────────────────────────────────────────── */

  const start = useCallback(async () => {
    if (ws.current) return;            // one line at a time
    setError(null);
    setConn("connecting");
    lastActive.current = Date.now();
    setDiag({ sent: 0, received: 0, level: 0, peak: 0 });
    loudest.current = 0;
    gotMessage.current = false;
    setAudioPaused(false);
    marks.current = { ...NO_WATERMARKS };
    replyEventId.current = null;
    replyComplete.current = true;
    pendingTurnAt.current = null;
    skipNext.current = false;
    skippedId.current = null;
    replyOwner.current = "member";
    turnAudio.current.clear();
    lastSpokenLen.current = -1;

    /*
     * THE AUDIO CONTEXT IS CREATED HERE, SYNCHRONOUSLY, BEFORE ANY AWAIT.
     *
     * Safari only lets an AudioContext start running if it is created inside the user gesture that asked
     * for it. Create it after an await and it comes up suspended, the audio callback never fires, and not
     * one byte is ever sent while everything LOOKS connected.
     */
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
      audioCtx.current = ctx;
      void ctx.resume();
      // The output path: every chunk → analyser (ATLAS's level, measured) → speaker gain (your mute) → out.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const gain = ctx.createGain();
      gain.gain.value = speakerMutedRef.current ? 0 : 1;
      analyser.connect(gain);
      gain.connect(ctx.destination);
      outAnalyser.current = analyser;
      speakerGain.current = gain;
    } catch {
      setConn("error");
      setError("This browser would not open an audio session.");
      return;
    }

    try {
      const r = await fetch("/api/command-center/voice/session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const j = await r.json();
      if (!j.ok || !j.url) { teardown("error", j.reason ?? "Could not open a voice session."); return; }
      const cap = Number(j.maxCallSeconds);
      maxCallSec.current = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_CALL_SECONDS;

      inputRate.current = ctx.sampleRate;
      playHead.current = ctx.currentTime;

      /*
       * THE SOCKET OPENS FIRST, AND THE MICROPHONE IS ATTACHED AFTERWARDS.
       *
       * This ordering is the entire fix for "I pressed talk and nothing happened, forever".
       *
       * `getUserMedia` does NOT reject when the permission prompt goes unanswered — it simply never
       * settles. The first version awaited it before creating the socket, so an unanswered prompt left
       * the whole session parked on "connecting" with no error, no timeout and nothing to act on. That
       * is the worst failure a product can have: silent, permanent, and indistinguishable from broken.
       *
       * So the line is established first and reports itself honestly, and the microphone becomes a
       * separate step that is allowed to fail loudly on its own — and the line stays usable by text.
       */
      const socket = new WebSocket(j.url);
      ws.current = socket;

      socket.onopen = () => {
        /*
         * No config override is sent. The provider rejects overrides for any field an agent has not been
         * set up to allow, and a rejected initiation fails quietly — the socket stays open and the
         * conversation never begins. This agent allows only its first message and the forwarded body, so a
         * per-conversation voice SPEED (a real provider override) is deliberately not offered here.
         */
        socket.send(JSON.stringify({
          type: "conversation_initiation_client_data",
          /*
           * The session token travels in BOTH places on purpose.
           *
           * `custom_llm_extra_body` is the one that matters: it is the only field the provider forwards
           * to our reasoning endpoint, where it arrives as `elevenlabs_extra_body` and becomes the
           * answer to "whose account is this?". `dynamic_variables` never leaves the provider — it
           * substitutes into their prompt — so a token sent only there is a token the brain never sees,
           * and the brain then correctly refuses to discuss a position it cannot attribute.
           */
          custom_llm_extra_body: { voice_token: j.voiceToken },
          dynamic_variables: { voice_token: j.voiceToken },
        }));
        void ctx.resume().catch(() => {});
        setConn("open");
        callStartedAt.current = Date.now();
        lastActive.current = Date.now();

        heartbeat.current = setInterval(() => {
          void fetch("/api/command-center/voice/session", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "heartbeat" }),
          }).catch(() => {});
        }, 45_000);

        void attachMicrophone(ctx, socket, manualMic.current ?? undefined);

        /*
         * THE PROVIDER MUST ANSWER THE HANDSHAKE.
         *
         * It replies to the initiation within a second or two. A line that has heard nothing at all after
         * eight seconds is a conversation that never started — told plainly, and closed so the next press
         * of Talk opens a fresh one instead of leaving a dead line billing minutes.
         */
        window.setTimeout(() => {
          if (ws.current !== socket || socket.readyState !== WebSocket.OPEN) return;
          if (gotMessage.current) return;
          endSession();
          setError("The voice service opened the line but never answered. Press Talk again to reconnect.");
        }, 8000);
      };

      socket.onmessage = (ev) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(String(ev.data)) as Record<string, unknown>; } catch { return; }
        const type = String(m.type ?? "");
        gotMessage.current = true;
        setDiag((d) => ({ ...d, received: d.received + 1 }));

        if (type === "conversation_initiation_metadata") {
          const meta = (m.conversation_initiation_metadata_event ?? {}) as Record<string, string>;
          const fmt = String(meta.agent_output_audio_format ?? "pcm_16000");
          const rate = Number(fmt.split("_")[1]);
          if (Number.isFinite(rate) && rate > 0) outputRate.current = rate;
          return;
        }

        if (type === "ping") {
          const e = (m.ping_event ?? {}) as { event_id?: number };
          socket.send(JSON.stringify({ type: "pong", event_id: e.event_id }));
          return;
        }

        if (type === "user_transcript") {
          const e = (m.user_transcription_event ?? {}) as { user_transcript?: string };
          const text = (e.user_transcript ?? "").trim();
          setPartial(null);
          /*
           * SILENCE IS TRANSCRIBED, NOT SKIPPED.
           *
           * A dead microphone does not produce an empty transcript — it produces "..." or "uh", which
           * is a turn, which gets a full answer. The screen then fills with the member apparently
           * saying nothing and ATLAS briefing them on it, twice. A turn with no letters or digits
           * in it is not something anybody said.
           */
          if (!/[\p{L}\p{N}]/u.test(text)) return;
          // Our own volunteered line, echoed back as a turn, is not something the member said either.
          if (isVolunteeredTurn(text)) return;
          const now = Date.now();
          lastActive.current = now;
          lastVoiceAt.current = now;
          // The member spoke, so whatever ATLAS was saying is no longer what matters.
          stopPlayback();
          replyOwner.current = "member";
          skipNext.current = false;
          pendingTurnAt.current = now;
          setTurns((t) => [...t.slice(-40), { id: `u${now}`, who: "you", text, heard: true, at: now, source: "voice" }]);
          return;
        }

        if (type === "tentative_user_transcript") {
          // The member's words while they are still saying them (needs the agent's client events; v9).
          const e = (m.tentative_user_transcription_event ?? {}) as { user_transcript?: string };
          const text = (e.user_transcript ?? "").trim();
          if (!/[\p{L}\p{N}]/u.test(text) || isVolunteeredTurn(text)) return;
          const now = Date.now();
          lastPartialAt.current = now;
          lastVoiceAt.current = now;
          lastActive.current = now;
          setPartial(text.slice(-240));
          return;
        }

        if (type === "audio") {
          const e = (m.audio_event ?? {}) as { audio_base_64?: string; event_id?: number; alignment?: Alignment };
          if (!e.audio_base_64) return;
          const provided = typeof e.event_id === "number" && Number.isFinite(e.event_id) ? e.event_id : null;
          // Talked over or stopped: audio from that reply is refused, however late it arrives.
          if (!audioPlayable(provided, marks.current)) return;
          const cur = replyEventId.current;
          const id = provided ?? (pendingTurnAt.current == null && cur != null && cur < 0 ? cur : (localSeq.current -= 1));
          if (id === skippedId.current) return;
          const isNew = id !== cur;
          if (isNew && skipNext.current) {
            // STOP was pressed while ATLAS was still thinking: this reply is not played.
            skipNext.current = false;
            skippedId.current = id;
            replyEventId.current = id;
            replyComplete.current = true;
            marks.current = { ...marks.current, stoppedThrough: Math.max(marks.current.stoppedThrough, id) };
            pendingTurnAt.current = null;
            setTurns((t) => [...t.slice(-40), { id: `b${id}-${Date.now()}`, who: "brain", text: "", heard: false, cut: true, at: Date.now(), eventId: id, source: replyOwner.current === "volunteered" ? "volunteered" : "voice" }]);
            return;
          }
          const now = Date.now();
          if (isNew) {
            replyEventId.current = id;
            replyComplete.current = false;
            pendingTurnAt.current = null;
            lastSpokenLen.current = -1;
            const source = replyOwner.current === "volunteered" ? "volunteered" : "voice";
            // `heard`: its audio has started. `spoken` stays null until character timing says what was said.
            setTurns((t) => (t.some((x) => x.who === "brain" && x.eventId === id)
              ? t.map((x) => (x.who === "brain" && x.eventId === id ? { ...x, heard: true } : x))
              : [...t.slice(-40), { id: `b${id}-${now}`, who: "brain", text: "", heard: true, spoken: null, at: now, eventId: id, source }]));
          }
          lastAudioAt.current = now;
          lastVoiceAt.current = now;
          // Only a reply to the member keeps the idle clock running; a volunteered line never does.
          if (replyOwner.current === "member") lastActive.current = now;
          enqueueAudio(e.audio_base_64, id, e.alignment ?? null);
          return;
        }

        if (type === "agent_response") {
          // The complete text of a reply. It usually arrives after that reply's audio has started.
          const e = (m.agent_response_event ?? {}) as { agent_response?: string; event_id?: number };
          const text = (e.agent_response ?? "").trim();
          if (!text) return;
          const id = typeof e.event_id === "number" ? e.event_id : replyEventId.current;
          if (id != null && id === replyEventId.current) replyComplete.current = true;
          const refused = id != null && !audioPlayable(id, marks.current);
          setTurns((t) => {
            const i = t.findIndex((x) => x.who === "brain" && x.eventId === id);
            if (i >= 0) return t.map((x, k) => (k === i ? { ...x, text } : x));
            // Text with no audio played (yet): shown, and honestly marked when it will never be heard.
            return [...t.slice(-40), { id: `b${id ?? "x"}-${Date.now()}`, who: "brain", text, heard: false, cut: refused, at: Date.now(), eventId: id, source: replyOwner.current === "volunteered" ? "volunteered" : "voice" }];
          });
          return;
        }

        if (type === "agent_response_correction") {
          // What was actually said before the member talked over it — the provider's own truncation.
          const e = (m.agent_response_correction_event ?? {}) as { corrected_agent_response?: string; event_id?: number };
          const corrected = (e.corrected_agent_response ?? "").trim();
          stopPlayback();
          const id = typeof e.event_id === "number" ? e.event_id : replyEventId.current;
          setTurns((t) => t.map((x) => (x.who === "brain" && x.eventId === id ? { ...x, cut: true, spoken: corrected || x.spoken || "" } : x)));
          return;
        }

        if (type === "interruption") {
          const e = (m.interruption_event ?? {}) as { event_id?: number };
          if (typeof e.event_id === "number") {
            marks.current = { ...marks.current, interruptedFrom: Math.max(marks.current.interruptedFrom, e.event_id) };
          }
          stopPlayback();
          return;
        }

        if (type === "error") {
          const e = (m.error_event ?? {}) as { error_type?: string; message?: string; reason?: string };
          if (e.error_type === "max_duration_exceeded") {
            endSession();
            setError(`This call reached its ${Math.round(maxCallSec.current / 60)}-minute limit and closed. Press Talk with ATLAS to start another.`);
            return;
          }
          const why = String(e.message || e.reason || e.error_type || "").slice(0, 160);
          if (why) setError(`The voice service reported a problem: ${why}`);
          return;
        }
      };

      socket.onerror = () => { notifyServerEnd(); teardown("error", "The voice connection dropped."); };
      /*
       * THE PROVIDER SAYS WHY IT HUNG UP — SAY IT ON SCREEN.
       *
       * 09-21: the speech account ran out of credits. The provider accepted the line, then closed it
       * 60ms later with code 3000 "[quota_exceeded] You've run out of credits". The close was
       * swallowed, the microphone finished attaching a moment later and set the status back to
       * LISTENING, and the screen showed a green orb over "0 sent · 0 back" for as long as anyone
       * waited. A line the provider closed is closed, and its reason is the most useful sentence
       * this panel can show.
       */
      socket.onclose = (ev) => {
        if (heartbeat.current) { clearInterval(heartbeat.current); heartbeat.current = null; }
        if (ws.current !== socket) return; // an old line closing after a new one opened
        notifyServerEnd();                 // the provider hung up: stop the meter now, not when the reaper notices
        const reason = String(ev.reason ?? "");
        if (/quota|credit/i.test(reason)) {
          teardown("error", "Voice is paused: the speech service account is out of credits. The owner needs to top it up at elevenlabs.io (Subscription / Usage). Typed chat still works.");
          return;
        }
        if (/max.?duration/i.test(reason)) {
          teardown("idle", `This call reached its ${Math.round(maxCallSec.current / 60)}-minute limit and closed. Press Talk with ATLAS to start another.`);
          return;
        }
        if (ev.code !== 1000 && ev.code !== 1005) {
          teardown("error", `The voice service closed the line${reason ? `: ${reason.replace(/^\[[^\]]+\]\s*/, "").slice(0, 160)}` : ` (code ${ev.code})`}. Press Talk to try again.`);
          return;
        }
        teardown("disconnected");
      };
    } catch {
      teardown("error", "Could not start the voice session.");
    }
  }, [enqueueAudio, stopPlayback, teardown, endSession, notifyServerEnd, attachMicrophone]);

  /** Change microphone without dropping the line. The socket and the session are untouched. */
  const switchMic = useCallback((id: string) => {
    const ctx = audioCtx.current, socket = ws.current;
    if (!ctx || !socket) return;
    setError(null);
    manualMic.current = id === "default" ? null : id;
    void attachMicrophone(ctx, socket, id);
  }, [attachMicrophone]);

  /*
   * WHEN THE COMPUTER CHANGES ITS INPUT, FOLLOW IT. Joining a Zoom call, plugging in a headset or switching the
   * input in System Settings fires `devicechange`; unless the member picked a microphone themselves, the live
   * line re-attaches to the computer's current input so ATLAS keeps hearing the same mic Zoom does.
   */
  useEffect(() => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.addEventListener) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (manualMic.current) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        const ctx = audioCtx.current, socket = ws.current;
        if (ctx && socket && socket.readyState === WebSocket.OPEN && micStream.current) void attachMicrophone(ctx, socket);
      }, 800);
    };
    md.addEventListener("devicechange", onChange);
    return () => { md.removeEventListener("devicechange", onChange); if (t) clearTimeout(t); };
  }, [attachMicrophone]);

  /* ── the controls ─────────────────────────────────────────────────────── */

  /** Tell the provider the member is active (typing, holding to talk): it will not start speaking for ~2 s. */
  const sendActivity = useCallback(() => {
    const socket = ws.current;
    const now = Date.now();
    if (!socket || socket.readyState !== WebSocket.OPEN || now - lastUserActivitySent.current < 1000) return;
    lastUserActivitySent.current = now;
    try { socket.send(JSON.stringify({ type: "user_activity" })); } catch { /* the line is going */ }
  }, []);

  /**
   * STOP — ATLAS goes quiet on the same tick, and the line stays open. If it was still thinking, the reply
   * it was about to give is not played either.
   */
  const stopSpeaking = useCallback(() => {
    const ctx = audioCtx.current;
    const playingNow = !!ctx && (scheduled.current.length > 0 || playHead.current > ctx.currentTime);
    if (playingNow || !replyComplete.current) stopPlayback();
    if (!playingNow && pendingTurnAt.current != null) { skipNext.current = true; pendingTurnAt.current = null; }
  }, [stopPlayback]);

  const setMicMuted = useCallback((m: boolean) => {
    mutedRef.current = m;
    setMicMutedState(m);
    // A disabled track captures nothing at all; the line sends silence meanwhile.
    if (micTrack.current) micTrack.current.enabled = !m;
  }, []);

  const setSpeakerMuted = useCallback((m: boolean) => {
    speakerMutedRef.current = m;
    setSpeakerMutedState(m);
    const g = speakerGain.current, ctx = audioCtx.current;
    if (g && ctx) g.gain.setValueAtTime(m ? 0 : 1, ctx.currentTime);
  }, []);

  /** Push-to-talk: open while held (or toggled on). Pressing to talk is a request for the floor. */
  const setPtt = useCallback((open: boolean) => {
    if (pttOpenRef.current === open) return;
    pttOpenRef.current = open;
    setPttOpenState(open);
    if (!open) return;
    lastActive.current = Date.now();
    const ctx = audioCtx.current;
    if (ctx && (scheduled.current.length > 0 || playHead.current > ctx.currentTime)) stopPlayback();
    sendActivity();
  }, [stopPlayback, sendActivity]);

  const setInputMode = useCallback((mode: InputMode) => {
    inputModeRef.current = mode;
    setInputModeState(mode);
    pttOpenRef.current = false;
    setPttOpenState(false);
    savePrefs();
  }, [savePrefs]);

  const setPttStyle = useCallback((style: PttStyle) => {
    pttStyleRef.current = style;
    setPttStyleState(style);
    pttOpenRef.current = false;
    setPttOpenState(false);
    savePrefs();
  }, [savePrefs]);

  /** THE TEXT FALLBACK: a typed turn on the open line, answered out loud like any other. */
  const sendText = useCallback((raw: string): boolean => {
    const text = cleanTypedText(raw);
    const socket = ws.current;
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify({ type: "user_message", text })); } catch { return false; }
    const now = Date.now();
    stopPlayback();   // a new question replaces whatever ATLAS was saying
    replyOwner.current = "member";
    skipNext.current = false;
    pendingTurnAt.current = now;
    lastActive.current = now;
    lastVoiceAt.current = now;
    setTurns((t) => [...t.slice(-40), { id: `t${now}`, who: "you", text, heard: true, at: now, source: "typed" }]);
    return true;
  }, [stopPlayback]);

  const setCommentary = useCallback((patch: Partial<CommentarySettings>) => {
    const next: CommentarySettings = {
      mode: patch.mode ?? settingsRef.current.mode,
      copilotCooldownMs: clampCooldown(patch.copilotCooldownMs ?? settingsRef.current.copilotCooldownMs),
    };
    settingsRef.current = next;
    setSettingsState(next);
    engine.current = retuneCommentary(engine.current, next);
    savePrefs();
  }, [savePrefs]);

  /* ── keyboard: Space to talk (or to stop ATLAS), Escape to stop ───────── */
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const onCall = connRef.current === "open";
      if (e.key === "Escape" && onCall && (activityRef.current === "speaking" || activityRef.current === "thinking")) {
        stopSpeaking();
        return;
      }
      if (e.code !== "Space" || !spaceBelongsToLine(onCall, document.activeElement as HTMLElement | null)) return;
      // Ours, on a call: the chat console's own Space dictation would open a second microphone on top of the line.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (inputModeRef.current === "push_to_talk") setPtt(pttStyleRef.current === "toggle" ? !pttOpenRef.current : true);
      else if (activityRef.current === "speaking" || activityRef.current === "thinking") stopSpeaking();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const ours = spaceBelongsToLine(connRef.current === "open", document.activeElement as HTMLElement | null);
      if (ours) { e.preventDefault(); e.stopImmediatePropagation(); }
      // Released wherever focus went: a held key must never leave the microphone open.
      if (inputModeRef.current === "push_to_talk" && pttStyleRef.current === "hold" && pttOpenRef.current) setPtt(false);
    };
    const release = () => { if (pttStyleRef.current === "hold" && pttOpenRef.current) setPtt(false); };
    const onVisibility = () => { if (document.visibilityState !== "visible") release(); };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [setPtt, stopSpeaking]);

  void onUiAction;

  /* ── what the line is doing, derived from what is really happening ────── */
  const facts = {
    connection: (info && info.enabled === false ? "locked" : conn) as Connection,
    micReady, micMuted, inputMode, pttOpen,
    playing: frame.playing, awaitingReply: frame.awaiting, userSpeaking: frame.speech,
  };
  const activity = lineActivity(facts);
  activityRef.current = activity;
  useEffect(() => { onStatus?.(voiceStatus(activity)); }, [activity, onStatus]);

  /* ── commentary: payloads in, volunteered lines out ───────────────────── */
  const ingest = useCallback((payload: unknown, external: boolean) => {
    if (!payload || typeof payload !== "object") return;
    if (external) lastExternalLive.current = Date.now();
    engine.current = observeCommentary(engine.current, payload as CommentaryInput, Date.now(), settingsRef.current).state;
  }, []);
  useEffect(() => { if (live) ingest(live, true); }, [live, ingest]);
  useEffect(() => {
    const last = voiceBus.lastLive();
    if (last && Date.now() - last.at < EXTERNAL_FRESH_MS) ingest(last.payload, true);
    return voiceBus.onLive((p) => ingest(p, true));
  }, [ingest]);
  /*
   * NOBODY HANDED US A PAYLOAD? Read /live ourselves — slowly, only while a mode needs it, only while the page
   * is visible, and never while the host is feeding us (the moment `live` or voiceBus.feedLive arrives, this
   * stands down). Not for a member without voice, whose panel has nowhere to show the lines.
   */
  useEffect(() => {
    if (settings.mode === "quiet" || !info || info.enabled === false) return;
    let alive = true;
    const tick = async () => {
      if (!alive || document.visibilityState !== "visible") return;
      if (Date.now() - lastExternalLive.current < EXTERNAL_FRESH_MS) return;
      try {
        const r = await fetch("/api/command-center/live", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (alive && Date.now() - lastExternalLive.current >= EXTERNAL_FRESH_MS) ingest(j, false);
      } catch { /* the next tick tries again */ }
    };
    const first = window.setTimeout(() => { void tick(); }, 4000);
    const id = window.setInterval(() => { void tick(); }, SELF_POLL_MS);
    return () => { alive = false; window.clearTimeout(first); window.clearInterval(id); };
  }, [settings.mode, info, ingest]);

  /*
   * DELIVERY. Once a second: is there a gap to say something into, and is anything worth saying? On a call a
   * volunteered line goes to ATLAS as a marked user_message — the provider's documented way to make the agent
   * take a turn — and the reasoning endpoint speaks it verbatim (core/commentary.ts explains the choice). Off a
   * call, or with the speaker muted, or too close to the idle hang-up, it is written here instead.
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      if (pttOpenRef.current) sendActivity();
      const s = settingsRef.current;
      if (s.mode === "quiet") { if (engine.current.queue.length) engine.current = retuneCommentary(engine.current, s); return; }
      const socket = ws.current;
      const onCall = connRef.current === "open" && !!socket && socket.readyState === WebSocket.OPEN;
      const route = commentaryRoute({
        onCall, activity: activityRef.current, speakerMuted: speakerMutedRef.current, pttOpen: pttOpenRef.current,
        typing: now - typingAt.current < 2500,
        msSinceMemberActive: now - (lastActive.current || now),
        msSinceVoice: now - lastVoiceAt.current,
        idleHangupMs: IDLE_HANGUP_MS,
      });
      if (route === "wait") return;
      const r = takeNextCommentary(engine.current, now, s);
      engine.current = r.state;
      const item = r.item;
      if (!item) return;
      let spoken = false;
      if (route === "speak" && socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: "user_message", text: volunteeredTurn(item.text) }));
          spoken = true;
          replyOwner.current = "volunteered";
          skipNext.current = false;
          pendingTurnAt.current = now;
        } catch { spoken = false; }
      }
      setNotes((n) => [...n.slice(-19), { id: item.id, at: now, kind: item.kind, text: item.text, spoken }]);
    }, 1000);
    return () => window.clearInterval(id);
  }, [sendActivity]);

  /* ── the shared line: the ATLAS core can open it, end it, and react to it ── */
  useEffect(() => voiceBus.register({
    start: () => { void start(); }, end: endSession, stopSpeaking, setMicMuted, setSpeakerMuted,
    setInputMode, setPttStyle, pushToTalk: setPtt, sendText: (t) => { sendText(t); }, setCommentary,
  }), [start, endSession, stopSpeaking, setMicMuted, setSpeakerMuted, setInputMode, setPttStyle, setPtt, sendText, setCommentary]);
  useEffect(() => {
    const lastYou = [...turns].reverse().find((t) => t.who === "you")?.text ?? null;
    const lastBrain = [...turns].reverse().find((t) => t.who === "brain");
    const lastAtlas = lastBrain ? (lastBrain.cut || !lastBrain.text ? lastBrain.spoken || lastBrain.text : lastBrain.text) || null : null;
    voiceBus.set({
      status: info && info.enabled === false ? "locked" : legacyStatus(activity),
      inLevel: busInLevel(facts, frame.inl),
      outLevel: busOutLevel(activity, frame.out),
      you: partial ?? lastYou, atlas: lastAtlas, error,
      needsSubscription: !!(info && info.enabled === false && info.needsSubscription),
      activity, micMuted, speakerMuted, inputMode, pttStyle, pttOpen, partial,
      commentaryMode: settings.mode, copilotCooldownMs: settings.copilotCooldownMs, commentary: notes,
    });
    // `facts` is rebuilt every render from the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, frame.inl, frame.out, turns, partial, error, info, micMuted, speakerMuted, inputMode, pttStyle, pttOpen, settings, notes, micReady, conn]);

  // Keep the newest words in view — inside the transcript box only, never by scrolling the page around it, and
  // only while the member is at the bottom (scrolling up to re-read something is not undone under them).
  useEffect(() => { const el = transcriptBox.current; if (el && stickToEnd.current) el.scrollTop = el.scrollHeight; }, [turns, partial]);

  /**
   * Send the member to Stripe. The price is never posted from here — the server reads it from
   * voicePlan.ts — so a tampered request cannot buy the subscription for a different amount.
   */
  const startCheckout = useCallback(async (topupId?: string, planId?: string) => {
    setBuying(true);
    setBuyError(null);
    try {
      const r = await fetch("/api/command-center/voice/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(topupId ? { topupId } : planId ? { planId } : {}),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.url) { window.location.href = j.url as string; return; }
      setBuyError(j?.detail || j?.error === "stripe_not_configured"
        ? "Payments aren't switched on yet."
        : "Could not open checkout. Try again in a moment.");
    } catch {
      setBuyError("Could not reach checkout. Check your connection and try again.");
    } finally {
      setBuying(false);
    }
  }, []);

  /* ── the surface ──────────────────────────────────────────────────────── */

  /*
   * NOT SUBSCRIBED — OFFER IT, DO NOT HIDE IT.
   *
   * This used to `return null`, because voice was admin-only and telling a member about a feature they
   * had no way to obtain is just an advert for a locked door. Now there is a door, so the panel
   * explains what it is, what it costs and what they get, and opens checkout.
   */
  if (info && info.enabled === false) {
    if (!info.needsSubscription || !info.offer) return null;   // switched off for another reason
    return (
      <section className="overflow-hidden rounded-2xl border" style={{ borderColor: C.line, background: C.panel }}>
        <div className="flex items-center justify-between gap-2 border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
          <p className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: C.gold }}>
            <Radio className="h-3.5 w-3.5" /> Command Center Voice
          </p>
          <span className="text-[10px] tabular-nums" style={{ color: C.mut2 }}>
            from ${Math.min(...(info.offer.plans ?? [info.offer]).map((p) => p.priceUsd))}/mo
          </span>
        </div>
        <div className="px-3.5 py-3">
          <p className="text-[12.5px] leading-relaxed" style={{ color: C.mut }}>
            {info.offer.blurb} Ask it what gold is doing, why it is standing aside, where your stop is —
            and it answers from the same read the engine trades on, not a separate one.
          </p>
          <p className="mt-2 text-[11.5px] leading-relaxed" style={{ color: C.mut2 }}>
            Separate from credits. Credits run the auto traders; this is the line to talk to the desk.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(info.offer.plans ?? [{ id: "cc_voice_1000", priceUsd: info.offer.priceUsd, minutes: info.offer.includedMinutes }]).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { void startCheckout(undefined, p.id); }}
                disabled={buying}
                className="rounded-lg px-3.5 py-2.5 text-left transition disabled:opacity-60"
                style={{ background: C.gold, color: "#10131A" }}
              >
                <span className="block text-[13px] font-bold">${p.priceUsd}/month</span>
                <span className="block text-[11.5px] font-medium opacity-80">{p.minutes.toLocaleString()} minutes of talk</span>
              </button>
            ))}
          </div>
          {buying && <p className="mt-2 text-[12px]" style={{ color: C.mut }}>Opening checkout…</p>}
          {buyError && <p className="mt-2 text-[12px]" style={{ color: C.down }}>{buyError}</p>}
        </div>
      </section>
    );
  }

  const onLine = conn === "open";

  /*
   * WHAT THE PRESENCE IS DOING, derived from what is really happening rather than from a label.
   *
   * "Thinking" is the honest name for the gap between the member finishing a sentence and the first
   * audio arriving — it is real work, it takes real time, and showing it is what stops that pause
   * feeling like a fault. It is shown ONLY while the provider owes a reply (voiceLine.ts); once ATLAS has
   * finished speaking the presence goes back to listening, not to a thinking it is not doing.
   */
  const presenceMode: PresenceMode =
    activity === "error" || activity === "disconnected" ? "dead"
    : activity === "connecting" || activity === "awaiting_mic" ? "connecting"
    : activity === "speaking" ? "speaking"
    : activity === "thinking" ? "thinking"
    : activity === "mic_muted" || activity === "ptt_idle" ? "muted"
    : activity === "listening" || activity === "user_speaking" ? "listening"
    : "idle";
  const label = ACTIVITY_LABEL[activity];
  const tone =
    activity === "awaiting_mic" || activity === "mic_muted" || activity === "ptt_idle" ? C.amber
    : activity === "speaking" ? C.gold
    : activity === "thinking" ? C.cold
    : activity === "listening" || activity === "user_speaking" ? C.up
    : activity === "error" || activity === "disconnected" ? C.down
    : C.mut2;
  const left = Math.max(0, maxCallSec.current - frame.callSec);
  const sendingMic = !micMuted && (inputMode === "hands_free" || pttOpen);

  const btn = (on: boolean, color = C.gold) => ({
    background: on ? `${color}24` : "rgba(255,255,255,0.04)",
    color: on ? color : C.mut, border: `1px solid ${on ? `${color}55` : C.line}`,
  });

  return (
    <section className="overflow-hidden rounded-2xl border" style={{ borderColor: onLine ? "rgba(240,196,117,0.26)" : C.line, background: C.panel }}>
      <div className="flex items-center justify-between gap-2 border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: tone }}>
          <Radio className="h-3.5 w-3.5" /> Voice session · {label}
        </p>
        {info?.budget && (
          <span className="text-[10px] tabular-nums" style={{ color: info.budget.exhausted ? C.amber : C.mut2 }}>
            {/* "this period" and not "this month": the allowance windows on the billing date. */}
            {Math.round(info.budget.remainingMinutes)} of {Math.round(info.budget.budgetMinutes)} min left this period
          </span>
        )}
      </div>

      <div className="px-3.5 py-3">
        {info && info.configured === false && (
          <p className="text-[12px] leading-relaxed" style={{ color: C.amber }}>{info.reason}</p>
        )}
        {error && <p className="text-[12px] leading-relaxed" style={{ color: C.down }}>{error}</p>}

        {/*
          * OUT OF MINUTES — the one moment a member is definitely willing to buy more, so the offer
          * belongs here rather than buried in a billing page. The text console keeps working either
          * way, which is said plainly so running out does not read as being locked out.
          */}
        {info?.budget?.exhausted && (
          <div className="mb-3 rounded-lg border px-3 py-2.5" style={{ borderColor: "rgba(233,185,73,0.3)", background: "rgba(233,185,73,0.06)" }}>
            <p className="text-[12px] leading-relaxed" style={{ color: C.amber }}>
              You have used all {Math.round(info.budget.budgetMinutes)} minutes for this billing period.
              The written console still works, and your minutes reset when the period renews.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {VOICE_TOPUPS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { void startCheckout(t.id); }}
                  disabled={buying}
                  className="rounded-md px-2.5 py-1.5 text-[11.5px] font-semibold transition disabled:opacity-60"
                  style={{ background: "rgba(240,196,117,0.14)", color: C.gold, border: "1px solid rgba(240,196,117,0.28)" }}
                >
                  +{t.label} · ${t.priceUsd}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px]" style={{ color: C.mut2 }}>
              Extra minutes are good for this billing period.
            </p>
            {buyError && <p className="mt-1.5 text-[11.5px]" style={{ color: C.down }}>{buyError}</p>}
          </div>
        )}

        {!onLine ? (
          <>
            <p className="text-[12.5px] leading-relaxed" style={{ color: C.mut }}>
              Open one line and talk normally — no button before each sentence (or choose push-to-talk). You can
              cut ATLAS off mid-word by talking over it or pressing Stop.
            </p>
            <InputModePicker inputMode={inputMode} pttStyle={pttStyle} onMode={setInputMode} onStyle={setPttStyle} />
            <button onClick={() => void start()} disabled={conn === "connecting" || info?.configured === false}
              className="mt-2.5 w-full rounded-xl px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] disabled:opacity-40"
              style={{ background: "rgba(240,196,117,0.14)", color: C.gold, border: "1px solid rgba(240,196,117,0.32)" }}>
              {conn === "connecting" ? "Connecting…" : "Talk with ATLAS"}
            </button>
          </>
        ) : (
          <>
            {/*
              * THE PRESENCE SITS ABOVE THE WORDS, because the words are the record and this is the
              * conversation. A member glancing over should be able to tell whether it is listening,
              * thinking or talking without reading anything.
              */}
            <div className="mb-1 flex justify-center">
              <VoicePresence
                mode={presenceMode}
                micLevel={sendingMic ? frame.inl / 3 : 0}
                outLevel={frame.out}
                size={118}
              />
            </div>
            <div className="mb-2 flex flex-wrap items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em]">
              <span style={{ color: tone }}>{label}</span>
              {speakerMuted && <span style={{ color: C.amber }}>· speaker muted — reading only</span>}
              {inputMode === "push_to_talk" && !pttOpen && !micMuted && (
                <span style={{ color: C.mut2 }}>· {pttStyle === "hold" ? "hold" : "tap"} Space or the button to talk</span>
              )}
              <span className="tabular-nums" style={{ color: left <= 60 ? C.amber : C.mut2 }}>
                · {mmss(frame.callSec)} / {mmss(maxCallSec.current)}{left <= 60 ? ` — ${left}s left on this call` : ""}
              </span>
            </div>

            <div ref={transcriptBox} className="max-h-[220px] space-y-2 overflow-y-auto"
              onScroll={(e) => { const el = e.currentTarget; stickToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
              {turns.slice(-14).map((t) => {
                const playingNow = t.who === "brain" && frame.playing && !t.cut && t.eventId === replyEventId.current;
                // What was HEARD is what is shown: a reply cut short shows only the words that were spoken (where
                // the provider's timing says which), and a reply that never played is marked as such rather than
                // presented as said.
                const neverPlayed = t.who === "brain" && t.cut && !t.heard;
                const words = t.who === "you" ? t.text
                  : t.cut ? (t.spoken || t.text || "")
                  : playingNow && t.spoken ? t.spoken
                  : t.text || t.spoken || "";
                return (
                  <div key={t.id}>
                    <p className="text-[9.5px] font-bold uppercase tracking-[0.16em]" style={{ color: t.who === "you" ? C.cold : C.gold }}>
                      {t.who === "you" ? (t.source === "typed" ? "You · typed" : "You") : t.source === "volunteered" ? "ATLAS · volunteered" : "ATLAS"}
                      {t.who === "brain" && t.cut && <span style={{ color: C.mut2 }}>{neverPlayed ? " · not played" : " · cut off"}</span>}
                    </p>
                    <p className="text-[12.5px] leading-relaxed" style={{ color: t.who === "brain" && t.cut ? (neverPlayed ? C.mut2 : C.mut) : C.text }}>
                      {words || (t.who === "brain" ? "…" : "")}
                    </p>
                  </div>
                );
              })}
              {partial && (
                <div>
                  <p className="text-[9.5px] font-bold uppercase tracking-[0.16em]" style={{ color: C.cold }}>You · speaking</p>
                  <p className="text-[12.5px] italic leading-relaxed" style={{ color: C.mut }}>{partial}</p>
                </div>
              )}
              {!turns.length && !partial && (
                <p className="text-[12px]" style={{ color: C.mut2 }}>
                  {activity === "awaiting_mic"
                    ? "The line is open. Allow the microphone and I'll hear you — or type below."
                    : inputMode === "push_to_talk" ? "Hold Space (or the talk button) and say “brief me”."
                    : "Listening. Say “brief me”."}
                </p>
              )}
            </div>

            {/* THE TEXT FALLBACK — a microphone is not required to use the line. */}
            <form className="mt-2.5 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (sendText(typed)) setTyped(""); }}>
              <input
                value={typed}
                onChange={(e) => { setTyped(e.target.value); typingAt.current = Date.now(); sendActivity(); }}
                placeholder="Type to ATLAS — it answers out loud"
                className="min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
                style={{ background: C.raised, color: C.text, border: `1px solid ${C.line}` }}
              />
              <button type="submit" disabled={!typed.trim()} aria-label="Send to ATLAS"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full disabled:opacity-35"
                style={{ border: `1px solid ${C.line}`, color: C.cold }}>
                <Send className="h-3.5 w-3.5" />
              </button>
            </form>

            {inputMode === "push_to_talk" && (
              <button
                type="button"
                onPointerDown={(e) => { if (pttStyle === "hold") { e.currentTarget.setPointerCapture?.(e.pointerId); setPtt(true); } }}
                onPointerUp={() => { if (pttStyle === "hold") setPtt(false); }}
                onPointerCancel={() => { if (pttStyle === "hold") setPtt(false); }}
                onClick={() => { if (pttStyle === "toggle") setPtt(!pttOpen); }}
                disabled={micMuted || !micReady}
                className="mt-2.5 w-full select-none rounded-xl px-3 py-3 text-[11px] font-bold uppercase tracking-[0.14em] disabled:opacity-40"
                style={btn(pttOpen, C.up)}>
                <span className="inline-flex items-center gap-1.5"><Hand className="h-3.5 w-3.5" />
                  {pttOpen ? (pttStyle === "hold" ? "Talking — release to send" : "Talking — tap to finish") : pttStyle === "hold" ? "Hold to talk (Space)" : "Tap to talk (Space)"}
                </span>
              </button>
            )}

            <div className="mt-2.5 grid grid-cols-4 gap-1.5">
              <button type="button" onClick={stopSpeaking} disabled={activity !== "speaking" && activity !== "thinking"}
                title="Stop ATLAS mid-word (Esc). The line stays open."
                className="inline-flex items-center justify-center gap-1 rounded-xl px-2 py-2.5 text-[10.5px] font-bold uppercase tracking-[0.1em] disabled:opacity-35"
                style={btn(activity === "speaking" || activity === "thinking")}>
                <Square className="h-3 w-3" /> Stop
              </button>
              <button type="button" onClick={() => setMicMuted(!micMuted)} title={micMuted ? "Unmute your microphone" : "Mute your microphone — ATLAS stops hearing you"}
                className="inline-flex items-center justify-center gap-1 rounded-xl px-2 py-2.5 text-[10.5px] font-bold uppercase tracking-[0.1em]"
                style={btn(micMuted, C.amber)}>
                {micMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}{micMuted ? "Mic off" : "Mic"}
              </button>
              <button type="button" onClick={() => setSpeakerMuted(!speakerMuted)} title={speakerMuted ? "Unmute ATLAS" : "Mute ATLAS — you read instead of hear"}
                className="inline-flex items-center justify-center gap-1 rounded-xl px-2 py-2.5 text-[10.5px] font-bold uppercase tracking-[0.1em]"
                style={btn(speakerMuted, C.amber)}>
                {speakerMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}{speakerMuted ? "Muted" : "Sound"}
              </button>
              <button type="button" onClick={endSession}
                className="inline-flex items-center justify-center gap-1 rounded-xl px-2 py-2.5 text-[10.5px] font-bold uppercase tracking-[0.1em]"
                style={{ background: "rgba(244,115,123,0.10)", color: C.down, border: "1px solid rgba(244,115,123,0.28)" }}>
                <PhoneOff className="h-3.5 w-3.5" /> End
              </button>
            </div>
            <InputModePicker inputMode={inputMode} pttStyle={pttStyle} onMode={setInputMode} onStyle={setPttStyle} />

            {/* The three numbers that make a silent failure diagnosable. */}
            <div className="mt-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[9.5px] font-bold uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>Mic</span>
                <span className="h-[4px] flex-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
                  <span className="block h-full rounded-full"
                    style={{ width: `${Math.min(100, Math.round(diag.level * 180))}%`, background: !sendingMic ? C.mut2 : diag.level > 0.02 ? C.up : C.mut2, transition: "width .12s linear" }} />
                </span>
                <span className="text-[10px] tabular-nums" style={{ color: C.mut2 }}>
                  {diag.sent} sent · {diag.received} back · peak {diag.peak.toFixed(3)}
                </span>
              </div>
              {audioPaused && (
                <button
                  onClick={() => { void audioCtx.current?.resume().then(() => setAudioPaused(false)).catch(() => {}); }}
                  className="mt-2 w-full rounded-xl px-3 py-2 text-[11px] font-black uppercase tracking-[0.14em]"
                  style={{ background: "rgba(240,196,117,0.14)", color: C.gold, border: "1px solid rgba(240,196,117,0.4)" }}>
                  The browser paused audio — tap to resume
                </button>
              )}
              {diag.sent > 40 && diag.received < 2 && (
                <p className="mt-1 text-[11px]" style={{ color: C.amber }}>
                  Your microphone is reaching me but the speech provider hasn&#39;t answered. That&#39;s their side, not yours.
                </p>
              )}
              {deviceMuted && (
                <p className="mt-1 text-[11px]" style={{ color: C.amber }}>
                  {micLabel ?? "That microphone"} is muted by your system, not by this page — check the
                  hardware switch or your sound settings.
                </p>
              )}
              {!deviceMuted && sendingMic && diag.sent > 120 && diag.peak < 0.002 && (
                <p className="mt-1 text-[11px]" style={{ color: C.amber }}>
                  I&#39;m reaching the provider, but {micLabel ?? "the microphone"} is sending pure silence.
                  {devices.length > 1 ? " It's probably the wrong input — pick another below." : " Nothing is arriving from that device."}
                </p>
              )}

              {/*
                * The device list, once we are allowed to see it.
                *
                * This is the difference between a dead end and a fix. A browser picks an input on the
                * member's behalf and never says which; when the choice is wrong — an unplugged headset,
                * a webcam on the far side of the room — every symptom points at the voice system
                * instead of at a dropdown nobody knew existed.
                */}
              {devices.length > 1 && (
                <select
                  value={micId}
                  onChange={(e) => switchMic(e.target.value)}
                  className="mt-2 w-full rounded-lg px-2 py-1.5 text-[11px]"
                  style={{ background: C.raised, color: C.mut, border: `1px solid ${C.line}` }}
                >
                  {devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              )}
            </div>

            <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: C.mut2 }}>
              Mic stops ATLAS hearing you; Sound stops you hearing ATLAS (the words still appear). Cut it off
              mid-word by talking over it, pressing Stop, or Esc. None of this stops the market engine, the
              position manager, or an order already on its way to the broker.
            </p>
          </>
        )}

        <CommentaryPanel settings={settings} notes={notes} onLine={onLine} onChange={setCommentary} />
      </div>
    </section>
  );
}

/* ── small pieces ─────────────────────────────────────────────────────── */

function InputModePicker({ inputMode, pttStyle, onMode, onStyle }: {
  inputMode: InputMode; pttStyle: PttStyle; onMode: (m: InputMode) => void; onStyle: (s: PttStyle) => void;
}) {
  const chip = (on: boolean) => ({
    background: on ? "rgba(240,196,117,0.14)" : "rgba(255,255,255,0.03)",
    color: on ? C.gold : C.mut2, border: `1px solid ${on ? "rgba(240,196,117,0.32)" : C.line}`,
  });
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      <span className="text-[9.5px] font-bold uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>Talk</span>
      <button type="button" onClick={() => onMode("hands_free")} className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]" style={chip(inputMode === "hands_free")}>Hands-free</button>
      <button type="button" onClick={() => onMode("push_to_talk")} className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]" style={chip(inputMode === "push_to_talk")}>Push-to-talk</button>
      {inputMode === "push_to_talk" && (
        <>
          <button type="button" onClick={() => onStyle("hold")} className="rounded-full px-2 py-1 text-[10px]" style={chip(pttStyle === "hold")}>hold</button>
          <button type="button" onClick={() => onStyle("toggle")} className="rounded-full px-2 py-1 text-[10px]" style={chip(pttStyle === "toggle")}>toggle</button>
        </>
      )}
    </div>
  );
}

const COOLDOWN_WORD = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms % 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${ms / 60_000} min`);

/**
 * WHEN ATLAS SPEAKS UP — the three commentary modes and the copilot's frequency, and the last few lines it
 * volunteered (spoken on a call, written here off one).
 */
function CommentaryPanel({ settings, notes, onLine, onChange }: {
  settings: CommentarySettings; notes: CommentaryNote[]; onLine: boolean; onChange: (s: Partial<CommentarySettings>) => void;
}) {
  const hint = COMMENTARY_MODES.find((m) => m.id === settings.mode)?.hint ?? "";
  const recent = notes.slice(-4).reverse();
  return (
    <div className="mt-3 border-t pt-2.5" style={{ borderColor: C.line }}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[9.5px] font-bold uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>ATLAS speaks up</span>
        {COMMENTARY_MODES.map((m) => (
          <button key={m.id} type="button" title={m.hint} onClick={() => onChange({ mode: m.id })}
            className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]"
            style={{
              background: settings.mode === m.id ? "rgba(240,196,117,0.14)" : "rgba(255,255,255,0.03)",
              color: settings.mode === m.id ? C.gold : C.mut2,
              border: `1px solid ${settings.mode === m.id ? "rgba(240,196,117,0.32)" : C.line}`,
            }}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[10.5px] leading-relaxed" style={{ color: C.mut2 }}>{hint}</p>
      {settings.mode === "copilot" && (
        <label className="mt-1.5 flex items-center gap-2 text-[10.5px]" style={{ color: C.mut }}>
          At most once every
          <select value={settings.copilotCooldownMs} onChange={(e) => onChange({ copilotCooldownMs: Number(e.target.value) })}
            className="rounded-md px-1.5 py-1 text-[10.5px]" style={{ background: C.raised, color: C.mut, border: `1px solid ${C.line}` }}>
            {COPILOT_COOLDOWNS_MS.map((ms) => <option key={ms} value={ms}>{COOLDOWN_WORD(ms)}</option>)}
          </select>
          <span style={{ color: C.mut2 }}>(urgent alerts may come sooner)</span>
        </label>
      )}
      {settings.mode !== "quiet" && (
        <p className="mt-1 text-[10px] leading-relaxed" style={{ color: C.mut2 }}>
          {onLine
            ? "On a call, these are spoken in the next pause. They never keep a quiet line open."
            : "Off a call these are written here, not spoken — there is no separate paid voice for them."}
          {" "}If the feed goes stale, ATLAS says so and holds market commentary.
        </p>
      )}
      {recent.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {recent.map((n) => (
            <li key={n.id} className="text-[11.5px] leading-snug" style={{ color: C.text }}>
              <span className="mr-1.5 text-[9.5px] tabular-nums" style={{ color: C.mut2 }}>
                {new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {n.spoken ? "spoken" : "noted"}
              </span>
              {n.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default VoiceSession;
