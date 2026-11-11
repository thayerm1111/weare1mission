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

/* ══════════════════════════════════════════════════════════════════════════════
   ONE QUESTION, ONE TURN (owner 11-11: "The screenshot repeats my question twice … Ensure one spoken
   question produces one user turn and one response. Prevent Atlas's speaker audio from being transcribed
   as another user request.")

   The provider sends a final transcript for everything it decided was a turn. Four of those are not a new
   thing the member said, and each is recognised here, purely, so the rule is tested rather than hoped for:

     • typed_echo  the provider echoing back a turn the member TYPED (it was already shown when it was sent);
     • duplicate   the same final transcript delivered twice;
     • extends     the same utterance re-finalised with a few more words — the turn on screen is updated;
     • atlas_echo  ATLAS's own voice coming back through the microphone: the words are what it just said.
   ══════════════════════════════════════════════════════════════════════════════ */

/** A turn reduced to its words: case, punctuation and spacing do not make a new question. */
export const turnKey = (text: string): string =>
  String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

export const TYPED_ECHO_MS = 15_000;
export const DUPLICATE_MS = 8_000;
export const EXTENDS_MS = 5_000;
/**
 * ATLAS's words can only come back through the microphone while they are being played, so a transcript is
 * compared with them only if it arrives while ATLAS is audible or just after. A member repeating a level back
 * as a question ("forty-three ninety-two?") does so after ATLAS has finished, and is a question.
 */
export const ECHO_WINDOW_MS = 2_500;

/**
 * Is this transcript ATLAS hearing itself? True when at least four words of it run, in order and unbroken,
 * through what ATLAS has just been saying, and those words are most of the transcript. A member repeating
 * one phrase back ("the London low?") is too short to match; a member reading a whole sentence back would
 * be dropped — which is the right way to be wrong for audio that arrived while ATLAS was speaking.
 */
export function looksLikeEcho(heard: string, atlasRecent: string): boolean {
  const h = turnKey(heard).split(" ").filter(Boolean);
  const a = turnKey(atlasRecent);
  if (h.length < 4 || a.length < 12) return false;
  let best = 0;
  for (let i = 0; i < h.length; i++) {
    let j = i;
    while (j < h.length && ` ${a} `.includes(` ${h.slice(i, j + 1).join(" ")} `)) j++;
    best = Math.max(best, j - i);
    if (best >= h.length - i) break;
  }
  return best >= 4 && best / h.length >= 0.7;
}

export type TurnMemory = {
  /** The last turn the member typed on the line. */
  typed: { key: string; at: number } | null;
  /** The last voice turn that was shown. */
  heard: { key: string; at: number } | null;
};
export const NO_TURN_MEMORY: TurnMemory = { typed: null, heard: null };

export type TurnVerdict = "new" | "typed_echo" | "duplicate" | "extends" | "atlas_echo";

/** What a final transcript is, given what was just typed, just heard, and just said by ATLAS. */
export function judgeUserTurn(text: string, mem: TurnMemory, now: number, atlas: { text: string; at: number } | null): TurnVerdict {
  const key = turnKey(text);
  if (!key) return "duplicate";
  if (mem.typed && now - mem.typed.at <= TYPED_ECHO_MS && (mem.typed.key === key || mem.typed.key.includes(key) || key.includes(mem.typed.key))) return "typed_echo";
  if (mem.heard && now - mem.heard.at <= DUPLICATE_MS && mem.heard.key === key) return "duplicate";
  if (atlas && now - atlas.at <= ECHO_WINDOW_MS && looksLikeEcho(text, atlas.text)) return "atlas_echo";
  if (mem.heard && now - mem.heard.at <= EXTENDS_MS && key.length > mem.heard.key.length && key.startsWith(mem.heard.key)) return "extends";
  return "new";
}

/**
 * The browser's speech recognition, read safely. Some browsers (Chrome on Android) deliver the SAME words
 * again as a later "final" result — each one the whole utterance so far — so adding finals together says the
 * question twice. This rebuilds the transcript from every result each time and drops a final that only
 * repeats, or restarts, what is already there.
 */
export function transcriptOf(results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>): { final: string; interim: string } {
  let final = "", interim = "";
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const t = String(r?.[0]?.transcript ?? "").trim();
    if (!t) continue;
    if (!r.isFinal) { interim = interim ? `${interim} ${t}` : t; continue; }
    const have = turnKey(final), add = turnKey(t);
    if (!add || have === add || have.endsWith(add)) continue;      // the same words again
    if (have && add.startsWith(have)) { final = t; continue; }       // the whole utterance so far, re-sent
    final = final ? `${final} ${t}` : t;
  }
  // An interim that only repeats the final adds nothing.
  if (interim && turnKey(final).endsWith(turnKey(interim))) interim = "";
  return { final: final.trim(), interim: interim.trim() };
}

/**
 * How many characters of a reply have been spoken, when the provider sent no character timing: the share of
 * its audio that has PLAYED, on the audio clock, applied to its text. `scheduledSec` is the audio received so
 * far; until the reply is complete the total is assumed to be at least what speech at a normal pace needs, so
 * an early chunk cannot make the estimate run ahead. An estimate — exact timing is used whenever it exists.
 */
export function spokenCharsEstimate(textLength: number, playedSec: number, scheduledSec: number, complete: boolean): number {
  if (!(textLength > 0) || !(playedSec > 0)) return 0;
  const assumed = textLength / 15.5;                               // seconds, at about 15 characters a second
  const total = complete ? Math.max(scheduledSec, 0.2) : Math.max(scheduledSec, assumed);
  return Math.min(textLength, Math.floor((playedSec / total) * textLength));
}

/**
 * "Show me that." — the member wants the evidence ATLAS just gave pointed at, not a new briefing. Recognised
 * here so the chart can re-emphasise the last answer's evidence at once, before any reply arrives. Only the
 * bare request counts: "show me the scenarios" is a question and is answered as one.
 */
export function asksToShow(text: string): boolean {
  const k = turnKey(text).replace(/^(atlas|hey atlas|ok atlas|okay atlas|please|can you|could you|now)\s+/g, "").replace(/\s+please$/, "");
  return /^(show|point)( me| us)?( that| it| this| them| those| where| again| to (that|it)| at (that|it)| on (the|my) chart)*$/.test(k)
    || /^where( is| s| was)?( that| it| this)( on (the|my) chart)?$/.test(k)
    || /^(show|point)( me| us)? what you mean$/.test(k);
}

/** The same question again inside this window is the same press, tap or utterance arriving twice. */
export const REPEAT_ASK_MS = 2_500;

/**
 * REQUEST DE-DUPLICATION for the typed console. A double press of Enter, a double tap on a suggestion, or a
 * recogniser that ends twice all submit the same words twice within a moment; that is one question. Asking the
 * same thing again later is the member's choice and goes through.
 */
export function isRepeatAsk(question: string, last: { key: string; at: number } | null, now: number): boolean {
  const key = turnKey(question);
  return !!key && !!last && last.key === key && now - last.at >= 0 && now - last.at < REPEAT_ASK_MS;
}

/**
 * "Switch to the fifteen-minute." — the MEMBER's own instruction to change the chart's timeframe, read from
 * their words (never from a model's). Only an explicit instruction counts: "what does the 15-minute say?" is a
 * question about the market and changes nothing on the screen.
 */
export function asksTimeframe(text: string): "5m" | "15m" | "1h" | "4h" | "1d" | null {
  const k = turnKey(text).replace(/^(atlas|hey atlas|ok atlas|okay atlas|please|can you|could you|now)\s+/g, "");
  const m = /^(?:switch|go|change|move|flip|jump|take me|zoom(?: in| out)?|put (?:me|it|the chart)|show(?: me)?|pull up|bring up|open)(?: (?:it|me|the chart|the view))?(?: (?:to|into|onto|on))?(?: the)? (5|five|15|fifteen|1|one|an|4|four|daily|day) ?(minute|minutes|min|m|hour|hours|hr|h)?(?: (?:chart|charts|timeframe|time frame|candles|view))?(?: please)?$/.exec(k);
  if (!m) return null;
  const n = m[1], u = m[2] ?? "";
  if (n === "daily" || n === "day") return u ? null : "1d";
  const minute = /^m/.test(u), hour = /^h/.test(u);
  if (minute && (n === "5" || n === "five")) return "5m";
  if (minute && (n === "15" || n === "fifteen")) return "15m";
  if (hour && (n === "1" || n === "one" || n === "an")) return "1h";
  if (hour && (n === "4" || n === "four")) return "4h";
  return null;
}
