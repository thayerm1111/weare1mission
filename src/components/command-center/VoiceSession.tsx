"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VOICE_TOPUPS } from "@/lib/voicePlan";
import { Mic, MicOff, PhoneOff, Radio } from "lucide-react";
import { VoicePresence, type PresenceMode } from "./VoicePresence";

/**
 * TALK WITH ATLAS — one continuous session, not a button you hold.
 *
 * The old console was press-to-talk: a microphone button before every sentence, and a speech synthesiser
 * that could not be stopped once it started. That is a demo. This is a line you open once and then
 * simply talk on, and three things make the difference:
 *
 *   INTERRUPTION IS REAL. When the member starts speaking, playback stops on the same tick and every
 *   queued sentence that has not begun is thrown away. A system you have to wait for is one you stop
 *   using by the second day.
 *
 *   WE TRACK WHAT WAS HEARD, NOT WHAT WAS GENERATED. Those are different things the moment anybody
 *   interrupts, and conflating them is how an agent ends up referring back to a sentence nobody ever
 *   heard it say.
 *
 *   STOPPING THE VOICE IS NOT STOPPING THE SYSTEM. Muting a microphone, closing this panel, or losing
 *   the socket has no effect on market monitoring, on an open position, or on an order already in
 *   flight. Those live on the server precisely so that a browser tab is never load-bearing.
 *
 * The provider is transport only. Reasoning happens on our side, through the same BRAIN the screen uses.
 */

const C = {
  panel: "#0A0E15", raised: "#0E131C", line: "rgba(255,255,255,0.07)",
  text: "#E8EFF7", mut: "rgba(232,239,247,0.56)", mut2: "rgba(232,239,247,0.34)",
  gold: "#F0C475", up: "#3FD9A0", down: "#F4737B", cold: "#6FA8DC", amber: "#E9B949",
};

export type VoiceStatus =
  | "idle" | "connecting" | "awaiting_mic" | "listening" | "speaking" | "muted" | "disconnected" | "error";

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

export type VoiceTurn = { id: string; who: "you" | "brain"; text: string; heard: boolean; at: number };

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

export function VoiceSession({ onUiAction, onStatus }: {
  onUiAction?: (name: string, arg: string | number | null) => void;
  /** Reported outward so a host surface can show the line's state without owning it. */
  onStatus?: (s: VoiceStatus) => void;
}) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [muted, setMuted] = useState(false);
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
  const [micMuted, setMicMuted] = useState(false);
  const [micId, setMicId] = useState("");

  const ws = useRef<WebSocket | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const micNode = useRef<ScriptProcessorNode | null>(null);
  const playHead = useRef(0);
  const scheduled = useRef<AudioBufferSourceNode[]>([]);
  const outputRate = useRef(16000);
  const inputRate = useRef(16000);
  const mutedRef = useRef(false);
  const pendingBrainId = useRef<string | null>(null);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const frames = useRef(0);
  const gotMessage = useRef(false);
  /** Every audio callback, sent or not — zero means the browser never started the audio engine. */
  const processed = useRef(0);
  const [audioPaused, setAudioPaused] = useState(false);
  /** The loudest sample this device has ever produced. A flat bar is ambiguous; this is not. */
  const loudest = useRef(0);
  /*
   * THE AMPLITUDE OF WHAT IS BEING SPOKEN, measured rather than simulated.
   *
   * The presence moves on the actual words because the alternative — a timer that animates whenever
   * the status says "speaking" — is a cartoon of a conversation. Every buffer scheduled for playback
   * is measured, and the reading decays on its own so the mouth closes when the sentence ends.
   */
  const outLevel = useRef(0);
  const [presenceOut, setPresenceOut] = useState(0);
  const micTrack = useRef<MediaStreamTrack | null>(null);
  const chosenMic = useRef<string | null>(null);
  const autoPicked = useRef(false);
  const rawRetry = useRef(false);

  useEffect(() => { mutedRef.current = muted; }, [muted]);

  /*
   * The presence reads at about thirty frames a second and decays between chunks, which is what makes
   * it look like a mouth closing rather than a meter dropping to zero.
   */
  useEffect(() => {
    const id = setInterval(() => {
      outLevel.current *= 0.72;
      setPresenceOut(outLevel.current);
    }, 33);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { onStatus?.(status); }, [status, onStatus]);

  /* ── availability ─────────────────────────────────────────────────────── */
  useEffect(() => {
    let alive = true;
    fetch("/api/command-center/voice/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (alive) setInfo(j); })
      .catch(() => { if (alive) setInfo({ ok: false, enabled: false }); });
    return () => { alive = false; };
  }, []);

  /* ── playback, and the ability to stop it instantly ───────────────────── */

  const stopPlayback = useCallback(() => {
    for (const s of scheduled.current) { try { s.stop(); } catch { /* already finished */ } }
    scheduled.current = [];
    outLevel.current = 0;      // interrupted mid-word: the mouth closes immediately
    playHead.current = audioCtx.current?.currentTime ?? 0;
    // Anything queued and never started was never heard. Saying otherwise would let ATLAS refer back
    // to a sentence the member has no memory of, which is worse than silence.
    setTurns((t) => t.map((x) => (x.who === "brain" && !x.heard && x.id === pendingBrainId.current ? { ...x, text: x.text, heard: false } : x)));
  }, []);

  const enqueueAudio = useCallback((b64: string) => {
    const ctx = audioCtx.current;
    /*
     * MUTED MEANS THE MICROPHONE IS OFF, NOT THAT THE MEMBER HAS GONE DEAF.
     *
     * This used to drop every incoming frame while muted, so muting yourself to stop talking also
     * destroyed everything ATLAS said back — each answer arriving, being discarded, and appearing
     * on screen marked "cut off". Muting your own microphone is not a request to be ignored.
     */
    if (!ctx) return;
    const pcm = base64ToPcm16(b64);
    if (!pcm.length) return;
    const buf = ctx.createBuffer(1, pcm.length, outputRate.current);
    buf.getChannelData(0).set(pcm);

    // The loudest sample in this chunk, held until the chunk has actually played.
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 8) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, playHead.current);
    src.start(startAt);
    playHead.current = startAt + buf.duration;
    scheduled.current.push(src);
    // The moment the first chunk of a sentence actually begins, that sentence counts as heard.
    window.setTimeout(() => { outLevel.current = peak; }, Math.max(0, (startAt - ctx.currentTime) * 1000));
    src.onended = () => { scheduled.current = scheduled.current.filter((s) => s !== src); };
    if (pendingBrainId.current) {
      const id = pendingBrainId.current;
      window.setTimeout(() => {
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, heard: true } : x)));
      }, Math.max(0, (startAt - ctx.currentTime) * 1000));
    }
    setStatus((s) => (s === "muted" ? s : "speaking"));
  }, []);

  /* ── teardown ─────────────────────────────────────────────────────────── */

  const teardown = useCallback((next: VoiceStatus, reason?: string) => {
    stopPlayback();
    if (heartbeat.current) { clearInterval(heartbeat.current); heartbeat.current = null; }
    try { micNode.current?.disconnect(); } catch { /* noop */ }
    micNode.current = null;
    try { micStream.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    micStream.current = null;
    try { ws.current?.close(); } catch { /* noop */ }
    ws.current = null;
    try { void audioCtx.current?.close(); } catch { /* noop */ }
    audioCtx.current = null;
    setStatus(next);
    if (reason) setError(reason);
  }, [stopPlayback]);

  const end = useCallback(() => {
    void fetch("/api/command-center/voice/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "end" }),
    }).catch(() => {});
    teardown("idle");
  }, [teardown]);

  useEffect(() => () => teardown("idle"), [teardown]);

  /*
   * AN OPEN LINE COSTS MONEY WHETHER ANYONE TALKS OR NOT (owner 09-21).
   *
   * The speech provider bills every minute the line is open. So when nobody has said anything and ATLAS
   * has said nothing back for 40 seconds, the line closes itself, and says so. Pressing Talk reopens it
   * in a fraction of a second. The provider enforces the same limit on its side as a backstop.
   */
  const lastActive = useRef(0);
  useEffect(() => {
    const open = status === "listening" || status === "speaking" || status === "muted" || status === "awaiting_mic";
    if (!open) return;
    if (!lastActive.current) lastActive.current = Date.now();
    const id = window.setInterval(() => {
      if (Date.now() - lastActive.current > IDLE_HANGUP_MS) {
        lastActive.current = 0;
        end();
        setError("Line closed after 40 seconds of quiet so it isn't billing minutes. Press Talk with ATLAS to start again.");
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, [status, end]);

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
        setError("This browser has the microphone blocked for this site. Allow it in the address bar (or in Settings on a phone), then start the session again.");
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
      const stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: wanted ? { ...base, deviceId: { exact: wanted } } : base }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("MIC_TIMEOUT")), MIC_TIMEOUT_MS)),
      ]);
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
      chosenMic.current = track?.getSettings().deviceId ?? wanted ?? null;
      setMicId(chosenMic.current ?? "");
      setMicLabel(track?.label || "the default microphone");
      setMicMuted(Boolean(track?.muted));
      if (track) {
        track.onmute = () => setMicMuted(true);
        track.onunmute = () => setMicMuted(false);
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
        if (peak > loudest.current) loudest.current = peak;
        if (socket.readyState !== WebSocket.OPEN || mutedRef.current) {
          if (processed.current % 6 === 0) setDiag((d) => ({ ...d, level: Math.max(peak, d.level * 0.6), peak: loudest.current }));
          return;
        }
        const pcm = downsample(input, inputRate.current, 16000);
        socket.send(JSON.stringify({ user_audio_chunk: pcm16ToBase64(pcm) }));
        frames.current += 1;
        if (frames.current % 6 === 0) {
          setDiag((d) => ({ ...d, sent: frames.current, level: Math.max(peak, d.level * 0.6), peak: loudest.current }));
        }

        /*
         * A TRACK THAT HAS NEVER PRODUCED A SAMPLE IS NOT A TRACK THAT IS LISTENING.
         *
         * About eight seconds of audio with an all-time peak of zero is not a quiet room — a quiet room
         * still has a noise floor. It is a dead pipeline, and the most common cause is the processing
         * above. Retried once, with everything off, and the member is told why rather than being left
         * to read a flat bar.
         */
        if (frames.current === 90 && loudest.current < 0.002 && !rawRetry.current) {
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
      setStatus((st) => (st === "muted" ? st : "listening"));
      return;
    } catch (e) {
      const name = e instanceof Error ? e.message || e.name : "";
      setError(
        name === "MIC_TIMEOUT"
          ? "I'm still waiting for microphone permission. Look for the prompt — on a phone it can appear at the top of the screen — and tap Allow. The line is open; I just can't hear you yet."
          : "The microphone was refused. The line is open, but I can't hear you until this site is allowed to use it.",
      );
      return;
    }
    }
  }, []);

  /* ── starting the line ────────────────────────────────────────────────── */

  const start = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    lastActive.current = Date.now();
    setDiag({ sent: 0, received: 0, level: 0, peak: 0 });
    loudest.current = 0;
    gotMessage.current = false;
    setAudioPaused(false);

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
    } catch {
      setStatus("error");
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
       * separate step that is allowed to fail loudly on its own.
       */
      const socket = new WebSocket(j.url);
      ws.current = socket;

      socket.onopen = () => {
        /*
         * No config override is sent. The provider rejects overrides for any field an agent has not been
         * set up to allow, and a rejected initiation fails quietly — the socket stays open and the
         * conversation never begins. There is nothing to override: the agent was provisioned with an
         * empty first message by us, moments earlier.
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
        setStatus("awaiting_mic");

        heartbeat.current = setInterval(() => {
          void fetch("/api/command-center/voice/session", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "heartbeat" }),
          }).catch(() => {});
        }, 45_000);

        void attachMicrophone(ctx, socket);

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
          teardown("error", "The voice service opened the line but never answered. Press Talk again to reconnect.");
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
          /*
           * SILENCE IS TRANSCRIBED, NOT SKIPPED.
           *
           * A dead microphone does not produce an empty transcript — it produces "..." or "uh", which
           * is a turn, which gets a full answer. The screen then fills with the member apparently
           * saying nothing and ATLAS briefing them on it, twice. A turn with no letters or digits
           * in it is not something anybody said.
           */
          if (!/[\p{L}\p{N}]/u.test(text)) return;
          lastActive.current = Date.now();
          // The member spoke, so whatever ATLAS was saying is no longer what matters.
          stopPlayback();
          setStatus("listening");
          setTurns((t) => [...t.slice(-40), { id: `u${Date.now()}`, who: "you", text, heard: true, at: Date.now() }]);
          return;
        }

        if (type === "agent_response") {
          const e = (m.agent_response_event ?? {}) as { agent_response?: string };
          const text = (e.agent_response ?? "").trim();
          if (!text) return;
          const id = `b${Date.now()}`;
          pendingBrainId.current = id;
          setTurns((t) => [...t.slice(-40), { id, who: "brain", text, heard: false, at: Date.now() }]);
          return;
        }

        if (type === "audio") {
          const e = (m.audio_event ?? {}) as { audio_base_64?: string };
          if (e.audio_base_64) { lastActive.current = Date.now(); enqueueAudio(e.audio_base_64); }
          return;
        }

        if (type === "interruption" || type === "agent_response_correction") {
          stopPlayback();
          if (type === "interruption") setStatus("listening");
          return;
        }
      };

      socket.onerror = () => { teardown("error", "The voice connection dropped."); };
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
        const reason = String(ev.reason ?? "");
        if (/quota|credit/i.test(reason)) {
          teardown("error", "Voice is paused: the speech service account is out of credits. The owner needs to top it up at elevenlabs.io (Subscription / Usage). Typed chat still works.");
          return;
        }
        if (ev.code !== 1000 && ev.code !== 1005) {
          teardown("error", `The voice service closed the line${reason ? `: ${reason.replace(/^\[[^\]]+\]\s*/, "").slice(0, 160)}` : ` (code ${ev.code})`}. Press Talk to try again.`);
          return;
        }
        setStatus((st) => (st === "idle" ? st : "disconnected"));
      };
    } catch {
      teardown("error", "Could not start the voice session.");
    }
  }, [enqueueAudio, stopPlayback, teardown, attachMicrophone]);

  /** Change microphone without dropping the line. The socket and the session are untouched. */
  const switchMic = useCallback((id: string) => {
    const ctx = audioCtx.current, socket = ws.current;
    if (!ctx || !socket) return;
    setError(null);
    void attachMicrophone(ctx, socket, id);
  }, [attachMicrophone]);

  void onUiAction;

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

  const live = status === "listening" || status === "speaking" || status === "muted" || status === "awaiting_mic";

  /*
   * WHAT THE PRESENCE IS DOING, derived from what is really happening rather than from a label.
   *
   * "Thinking" is the honest name for the gap between the member finishing a sentence and the first
   * audio arriving — it is real work, it takes real time, and showing it is what stops that pause
   * feeling like a fault.
   */
  const presenceMode: PresenceMode =
    status === "error" || status === "disconnected" ? "dead"
    : status === "connecting" || status === "awaiting_mic" ? "connecting"
    : status === "muted" ? "muted"
    : status === "speaking" ? (presenceOut > 0.004 ? "speaking" : "thinking")
    : status === "listening" ? (turns.length && turns[turns.length - 1].who === "you" ? "thinking" : "listening")
    : "idle";
  const label = status === "awaiting_mic" ? "waiting for the microphone" : status;
  const tone =
    status === "awaiting_mic" ? C.amber
    : status === "speaking" ? C.gold
    : status === "listening" ? C.up
    : status === "muted" ? C.amber
    : status === "error" || status === "disconnected" ? C.down
    : C.mut2;

  return (
    <section className="overflow-hidden rounded-2xl border" style={{ borderColor: live ? "rgba(240,196,117,0.26)" : C.line, background: C.panel }}>
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

        {!live ? (
          <>
            <p className="text-[12.5px] leading-relaxed" style={{ color: C.mut }}>
              Open one line and talk normally — no button before each sentence. You can cut ATLAS off
              mid-word and it will stop.
            </p>
            <button onClick={() => void start()} disabled={status === "connecting" || info?.configured === false}
              className="mt-2.5 w-full rounded-xl px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] disabled:opacity-40"
              style={{ background: "rgba(240,196,117,0.14)", color: C.gold, border: "1px solid rgba(240,196,117,0.32)" }}>
              {status === "connecting" ? "Connecting…" : "Talk with ATLAS"}
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
                micLevel={diag.level}
                outLevel={presenceOut}
                size={118}
              />
            </div>

            <div className="max-h-[200px] space-y-2 overflow-y-auto">
              {turns.slice(-12).map((t) => (
                <div key={t.id}>
                  <p className="text-[9.5px] font-bold uppercase tracking-[0.16em]" style={{ color: t.who === "you" ? C.cold : C.gold }}>
                    {t.who === "you" ? "You" : "ATLAS"}
                    {t.who === "brain" && !t.heard && <span style={{ color: C.mut2 }}> · cut off</span>}
                  </p>
                  <p className="text-[12.5px] leading-relaxed" style={{ color: t.heard ? C.text : C.mut2 }}>{t.text}</p>
                </div>
              ))}
              {!turns.length && (
                <p className="text-[12px]" style={{ color: C.mut2 }}>
                  {status === "awaiting_mic"
                    ? "The line is open. Allow the microphone and I'll hear you."
                    : "Listening. Say \u201cbrief me\u201d."}
                </p>
              )}
            </div>

            {/* The three numbers that make a silent failure diagnosable. */}
            <div className="mt-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[9.5px] font-bold uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>Mic</span>
                <span className="h-[4px] flex-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
                  <span className="block h-full rounded-full"
                    style={{ width: `${Math.min(100, Math.round(diag.level * 180))}%`, background: diag.level > 0.02 ? C.up : C.mut2, transition: "width .12s linear" }} />
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
              {micMuted && (
                <p className="mt-1 text-[11px]" style={{ color: C.amber }}>
                  {micLabel ?? "That microphone"} is muted by your system, not by this page — check the
                  hardware switch or your sound settings.
                </p>
              )}
              {!micMuted && diag.sent > 120 && diag.peak < 0.002 && (
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

            <div className="mt-3 flex gap-2">
              <button onClick={() => { setMuted((m) => !m); setStatus(muted ? "listening" : "muted"); }}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.12em]"
                style={{
                  background: muted ? "rgba(233,185,73,0.14)" : "rgba(255,255,255,0.04)",
                  color: muted ? C.amber : C.mut, border: `1px solid ${muted ? "rgba(233,185,73,0.30)" : C.line}`,
                }}>
                {muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                {muted ? "Unmute" : "Mute"}
              </button>
              <button onClick={end}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2.5 text-[11px] font-bold uppercase tracking-[0.12em]"
                style={{ background: "rgba(244,115,123,0.10)", color: C.down, border: "1px solid rgba(244,115,123,0.28)" }}>
                <PhoneOff className="h-3.5 w-3.5" /> End
              </button>
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: C.mut2 }}>
              Muting stops me hearing you; ATLAS still speaks. Cut it off mid-word by talking over it.
              None of this stops the market engine, the position manager, or an order already on its way
              to the broker.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

export default VoiceSession;
