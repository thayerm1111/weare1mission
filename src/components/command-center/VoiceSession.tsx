"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Radio } from "lucide-react";

/**
 * TALK WITH THE BRAIN — one continuous session, not a button you hold.
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

export type VoiceTurn = { id: string; who: "you" | "brain"; text: string; heard: boolean; at: number };

type SessionInfo = {
  ok: boolean; enabled?: boolean; configured?: boolean; reason?: string | null; missing?: string[];
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

export function VoiceSession({ onUiAction }: { onUiAction?: (name: string, arg: string | number | null) => void }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [muted, setMuted] = useState(false);
  /*
   * VISIBLE DIAGNOSTICS.
   *
   * "I pressed talk, said something, and nothing registered" is impossible to act on. These three
   * numbers turn that into a reading: is the microphone producing sound, are we sending it, and is the
   * provider answering. Whichever one is zero is the broken link.
   */
  const [diag, setDiag] = useState({ sent: 0, received: 0, level: 0 });
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
  const micTrack = useRef<MediaStreamTrack | null>(null);
  const chosenMic = useRef<string | null>(null);

  useEffect(() => { mutedRef.current = muted; }, [muted]);

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
    playHead.current = audioCtx.current?.currentTime ?? 0;
    // Anything queued and never started was never heard. Saying otherwise would let THE BRAIN refer back
    // to a sentence the member has no memory of, which is worse than silence.
    setTurns((t) => t.map((x) => (x.who === "brain" && !x.heard && x.id === pendingBrainId.current ? { ...x, text: x.text, heard: false } : x)));
  }, []);

  const enqueueAudio = useCallback((b64: string) => {
    const ctx = audioCtx.current;
    /*
     * MUTED MEANS THE MICROPHONE IS OFF, NOT THAT THE MEMBER HAS GONE DEAF.
     *
     * This used to drop every incoming frame while muted, so muting yourself to stop talking also
     * destroyed everything THE BRAIN said back — each answer arriving, being discarded, and appearing
     * on screen marked "cut off". Muting your own microphone is not a request to be ignored.
     */
    if (!ctx) return;
    const pcm = base64ToPcm16(b64);
    if (!pcm.length) return;
    const buf = ctx.createBuffer(1, pcm.length, outputRate.current);
    buf.getChannelData(0).set(pcm);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, playHead.current);
    src.start(startAt);
    playHead.current = startAt + buf.duration;
    scheduled.current.push(src);
    // The moment the first chunk of a sentence actually begins, that sentence counts as heard.
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

  /* ── the microphone, as a separate step ───────────────────────────────── */

  /**
   * Ask for the microphone and wire it into the socket.
   *
   * Raced against a timeout ON PURPOSE. `getUserMedia` never settles when a permission prompt is ignored
   * or suppressed — no resolve, no reject, no error event — so without a race there is no moment at
   * which anything can be said to the member. With one, an unanswered prompt becomes a sentence.
   */
  const attachMicrophone = useCallback(async (ctx: AudioContext, socket: WebSocket, wanted?: string) => {
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

      const base: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
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
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        setDevices(all.filter((d) => d.kind === "audioinput" && d.deviceId)
          .map((d) => ({ id: d.deviceId, label: d.label || "Microphone" })));
      } catch { /* the list is a convenience; its absence is not a failure */ }

      frames.current = 0;
      setDiag((d) => ({ ...d, sent: 0, level: 0 }));

      // Safari suspends the context again behind the permission prompt.
      await ctx.resume().catch(() => {});

      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      micNode.current = node;
      node.onaudioprocess = (e) => {
        if (socket.readyState !== WebSocket.OPEN || mutedRef.current) return;
        const input = e.inputBuffer.getChannelData(0);
        // Peak of this frame, so the member can SEE the microphone is hearing them. A flat bar while
        // they talk is a dead track, which is a different problem from the provider not answering.
        let peak = 0;
        for (let i = 0; i < input.length; i += 16) { const v = Math.abs(input[i]); if (v > peak) peak = v; }
        const pcm = downsample(input, inputRate.current, 16000);
        socket.send(JSON.stringify({ user_audio_chunk: pcm16ToBase64(pcm) }));
        frames.current += 1;
        if (frames.current % 6 === 0) {
          setDiag((d) => ({ ...d, sent: frames.current, level: Math.max(peak, d.level * 0.6) }));
        }
      };
      source.connect(node);
      // A ScriptProcessor needs a destination to run at all; routing the microphone to the speakers
      // would make THE BRAIN talk over itself, so it goes through a silenced gain node.
      const silent = ctx.createGain();
      silent.gain.value = 0;
      node.connect(silent);
      silent.connect(ctx.destination);

      setError(null);
      setStatus((st) => (st === "muted" ? st : "listening"));
    } catch (e) {
      const name = e instanceof Error ? e.message || e.name : "";
      setError(
        name === "MIC_TIMEOUT"
          ? "I'm still waiting for microphone permission. Look for the prompt — on a phone it can appear at the top of the screen — and tap Allow. The line is open; I just can't hear you yet."
          : "The microphone was refused. The line is open, but I can't hear you until this site is allowed to use it.",
      );
    }
  }, []);

  /* ── starting the line ────────────────────────────────────────────────── */

  const start = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    setDiag({ sent: 0, received: 0, level: 0 });

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
      };

      socket.onmessage = (ev) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(String(ev.data)) as Record<string, unknown>; } catch { return; }
        const type = String(m.type ?? "");
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
           * saying nothing and THE BRAIN briefing them on it, twice. A turn with no letters or digits
           * in it is not something anybody said.
           */
          if (!/[\p{L}\p{N}]/u.test(text)) return;
          // The member spoke, so whatever THE BRAIN was saying is no longer what matters.
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
          if (e.audio_base_64) enqueueAudio(e.audio_base_64);
          return;
        }

        if (type === "interruption" || type === "agent_response_correction") {
          stopPlayback();
          if (type === "interruption") setStatus("listening");
          return;
        }
      };

      socket.onerror = () => { teardown("error", "The voice connection dropped."); };
      socket.onclose = () => {
        setStatus((st) => (st === "idle" ? st : "disconnected"));
        if (heartbeat.current) { clearInterval(heartbeat.current); heartbeat.current = null; }
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

  /* ── the surface ──────────────────────────────────────────────────────── */

  if (info && info.enabled === false) return null;          // not this member's feature; say nothing

  const live = status === "listening" || status === "speaking" || status === "muted" || status === "awaiting_mic";
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
          <span className="text-[10px] tabular-nums" style={{ color: C.mut2 }}>
            {Math.round(info.budget.remainingMinutes)} min left this month
          </span>
        )}
      </div>

      <div className="px-3.5 py-3">
        {info && info.configured === false && (
          <p className="text-[12px] leading-relaxed" style={{ color: C.amber }}>{info.reason}</p>
        )}
        {error && <p className="text-[12px] leading-relaxed" style={{ color: C.down }}>{error}</p>}

        {!live ? (
          <>
            <p className="text-[12.5px] leading-relaxed" style={{ color: C.mut }}>
              Open one line and talk normally — no button before each sentence. You can cut THE BRAIN off
              mid-word and it will stop.
            </p>
            <button onClick={() => void start()} disabled={status === "connecting" || info?.configured === false}
              className="mt-2.5 w-full rounded-xl px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] disabled:opacity-40"
              style={{ background: "rgba(240,196,117,0.14)", color: C.gold, border: "1px solid rgba(240,196,117,0.32)" }}>
              {status === "connecting" ? "Connecting…" : "Talk with THE BRAIN"}
            </button>
          </>
        ) : (
          <>
            <div className="max-h-[220px] space-y-2 overflow-y-auto">
              {turns.slice(-12).map((t) => (
                <div key={t.id}>
                  <p className="text-[9.5px] font-bold uppercase tracking-[0.16em]" style={{ color: t.who === "you" ? C.cold : C.gold }}>
                    {t.who === "you" ? "You" : "THE BRAIN"}
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
                  {diag.sent} sent · {diag.received} back
                </span>
              </div>
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
              {!micMuted && diag.sent > 60 && diag.level < 0.01 && (
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
              Muting stops me hearing you; THE BRAIN still speaks. Cut it off mid-word by talking over it.
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
