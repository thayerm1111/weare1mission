/**
 * THE VOICE LINE, AS FACTS — the pure rules VoiceSession runs on.
 *
 * Everything the screen says about a call — listening, hearing you, thinking, speaking, muted — is derived
 * here from things that are actually true on the line, never from a timer or a label:
 *
 *   SPEAKING   provider audio is scheduled on our output and has not finished playing.
 *   THINKING   the provider owes us a reply: a turn was finalised (a spoken transcript, a typed message, a
 *              volunteered line) and no reply audio has started — or a reply started, ran dry, and more is
 *              still due. It is the server's real work and it takes real time; it is never shown otherwise.
 *   HEARING    the open microphone is carrying speech, or the provider is sending live partial transcripts.
 *   LISTENING  the line is open and the microphone is live; nobody is talking.
 *   MIC MUTED / PUSH TO TALK   the microphone is not being sent (silence frames go instead, as the official
 *              SDK does when muted, so the provider's turn-taking still sees the speaker stop).
 *
 * Pure: no React, no DOM, no clock. Tested in tests/cc-atlas-voice-line.test.ts.
 */

export type InputMode = "hands_free" | "push_to_talk";
export type PttStyle = "hold" | "toggle";
export type Connection = "idle" | "connecting" | "open" | "disconnected" | "error" | "locked";

export type LineActivity =
  | "off" | "connecting" | "awaiting_mic" | "listening" | "user_speaking" | "thinking" | "speaking"
  | "mic_muted" | "ptt_idle" | "disconnected" | "error" | "locked";

export type LineFacts = {
  connection: Connection;
  /** A microphone track is attached to the line. */
  micReady: boolean;
  /** The member muted the microphone. */
  micMuted: boolean;
  inputMode: InputMode;
  /** Push-to-talk is held (or toggled on). */
  pttOpen: boolean;
  /** Provider audio is scheduled ahead of the playhead. */
  playing: boolean;
  /** The provider owes a reply (see THINKING above). */
  awaitingReply: boolean;
  /** Speech on the open microphone, or a live partial transcript just arrived. */
  userSpeaking: boolean;
};

/** Is what the microphone hears actually being sent? */
export function micLive(f: Pick<LineFacts, "micMuted" | "inputMode" | "pttOpen">): boolean {
  return !f.micMuted && (f.inputMode === "hands_free" || f.pttOpen);
}

/** What the line is doing right now, in order of what matters most to the person looking at it. */
export function lineActivity(f: LineFacts): LineActivity {
  switch (f.connection) {
    case "idle": return "off";
    case "connecting": return "connecting";
    case "disconnected": return "disconnected";
    case "error": return "error";
    case "locked": return "locked";
    default: break;
  }
  if (f.playing) return "speaking";
  if (f.awaitingReply) return "thinking";
  if (!f.micReady) return "awaiting_mic";
  if (f.micMuted) return "mic_muted";
  if (f.inputMode === "push_to_talk" && !f.pttOpen) return "ptt_idle";
  return f.userSpeaking ? "user_speaking" : "listening";
}

export const ACTIVITY_LABEL: Record<LineActivity, string> = {
  off: "off", connecting: "connecting", awaiting_mic: "waiting for the microphone", listening: "listening",
  user_speaking: "hearing you", thinking: "thinking", speaking: "speaking", mic_muted: "mic muted",
  ptt_idle: "push to talk", disconnected: "disconnected", error: "error", locked: "locked",
};

/* ── the shared bus, kept compatible with the HUD that reads it ─────────────────────────────────────── */

/** The values the HUD (hud/CommandCenterHud.tsx) and `lineOpen` already understand. */
export type LegacyStatus = "idle" | "connecting" | "awaiting_mic" | "listening" | "speaking" | "muted" | "disconnected" | "error" | "locked";

/**
 * The bus `status` the HUD reads. The HUD shows THINKING for `status === "speaking"` with `outLevel ≤ 0.02`,
 * and SPEAKING above it — so thinking is published as "speaking" at level 0 (busOutLevel), and real speech
 * never drops to that level while audio is still playing. A closed microphone is "muted".
 */
export function legacyStatus(a: LineActivity): LegacyStatus {
  switch (a) {
    case "off": return "idle";
    case "connecting": return "connecting";
    case "awaiting_mic": return "awaiting_mic";
    case "listening": case "user_speaking": return "listening";
    case "thinking": case "speaking": return "speaking";
    case "mic_muted": case "ptt_idle": return "muted";
    case "disconnected": return "disconnected";
    case "error": return "error";
    case "locked": return "locked";
  }
}

/** For `onStatus` consumers that can show the pause honestly (the companion). */
export type VoiceStatus = "idle" | "connecting" | "awaiting_mic" | "listening" | "thinking" | "speaking" | "muted" | "disconnected" | "error";

export function voiceStatus(a: LineActivity): VoiceStatus {
  if (a === "thinking") return "thinking";
  const l = legacyStatus(a);
  return l === "locked" ? "idle" : l;
}

/** The HUD's "speaking" threshold: at or below it, "speaking" reads as THINKING. */
export const HUD_THINKING_LEVEL = 0.02;

/** ATLAS's level on the bus: the measured output while it really speaks (never below the HUD's threshold), else 0. */
export function busOutLevel(a: LineActivity, measured: number): number {
  if (a !== "speaking") return 0;
  return Math.min(1, Math.max(HUD_THINKING_LEVEL + 0.01, Number.isFinite(measured) ? measured : 0));
}

/** Your level on the bus: only what is actually being sent. A muted microphone moves nothing. */
export function busInLevel(f: Pick<LineFacts, "connection" | "micMuted" | "inputMode" | "pttOpen" | "micReady">, measured: number): number {
  if (f.connection !== "open" || !f.micReady || !micLive(f)) return 0;
  return Math.min(1, Math.max(0, Number.isFinite(measured) ? measured : 0));
}

/* ── interruption: which provider audio may still play ─────────────────────────────────────────────── */

/**
 * Audio is tagged with the provider's event_id, one per agent response. The official SDK plays a chunk only
 * when `lastInterruptTimestamp <= event_id` — chunks of a response the member talked over are dropped even if
 * they arrive late. A local STOP adds a second watermark: everything up to and including the response that
 * was playing is dropped; the next response (a higher id) plays normally.
 */
export type AudioWatermarks = { interruptedFrom: number; stoppedThrough: number };
export const NO_WATERMARKS: AudioWatermarks = { interruptedFrom: 0, stoppedThrough: -1 };

export function audioPlayable(eventId: number | null | undefined, w: AudioWatermarks): boolean {
  if (eventId == null || !Number.isFinite(eventId)) return true;   // nothing to judge it by
  if (eventId < w.interruptedFrom) return false;
  if (eventId <= w.stoppedThrough) return false;
  return true;
}

/* ── volunteered lines: speak, show, or wait ───────────────────────────────────────────────────────── */

/** Let a pause settle before volunteering anything — never jump in on the end of somebody's sentence. */
export const SPEAK_GAP_MS = 3_500;
/** Never start a spoken line inside the last 15 s before the idle hang-up: it would only be cut off. */
export const HANGUP_MARGIN_MS = 15_000;

export type DeliveryFacts = {
  onCall: boolean;
  activity: LineActivity;
  speakerMuted: boolean;
  pttOpen: boolean;
  typing: boolean;
  /** Since the member last spoke, typed or pressed to talk (the idle hang-up clock). */
  msSinceMemberActive: number;
  /** Since anybody's voice was last on the line (the member speaking, or ATLAS's audio ending). */
  msSinceVoice: number;
  idleHangupMs: number;
};

/**
 * Where a volunteered line goes now. Off a call it is text. On a call it is spoken only into a real pause,
 * only while the member can hear it, and only while the line has enough life left that saying it does not
 * keep an idle line open — the idle hang-up protects the member's minutes and volunteered speech never
 * resets it. Anything else waits for a better moment, or goes to text.
 */
export function commentaryRoute(f: DeliveryFacts): "speak" | "text" | "wait" {
  if (!f.onCall) return "text";
  if (f.speakerMuted) return "text";
  if (f.activity === "connecting" || f.activity === "awaiting_mic") return "wait";
  if (f.activity === "speaking" || f.activity === "thinking" || f.activity === "user_speaking" || f.pttOpen || f.typing) return "wait";
  if (f.msSinceVoice < SPEAK_GAP_MS) return "wait";
  if (f.msSinceMemberActive > f.idleHangupMs - HANGUP_MARGIN_MS) return "text";
  return "speak";
}

/* ── what the member types ─────────────────────────────────────────────────────────────────────────── */

/** A typed message: one line, bounded, and never able to pass itself off as a volunteered line or a UI marker. */
export function cleanTypedText(v: unknown): string {
  return String(v ?? "")
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 1000);
}

/* ── keyboard ──────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Should Space belong to the voice line? Only while a call is open, and never while the member is typing.
 * BrainConsole binds Space to the browser's own dictation; on a call that would open a second microphone on
 * top of the line, so the line takes the key (in the capture phase) and the console never sees it.
 */
export function spaceBelongsToLine(onCall: boolean, target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!onCall) return false;
  const tag = (target?.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return false;
  return true;
}
