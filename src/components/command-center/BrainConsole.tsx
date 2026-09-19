"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Send, Square, Volume2, VolumeX } from "lucide-react";

/**
 * TALKING TO THE BRAIN.
 *
 * Speech in through the browser's recognition API, speech out through its synthesis API, behind one small
 * abstraction so a dedicated speech provider can replace either end without touching this component.
 * Nothing here is simulated: if the browser cannot listen, the microphone says so rather than pretending.
 *
 * Interruption is the part that makes it feel like a conversation rather than an announcement system:
 * the moment you start speaking, THE BRAIN stops.
 */

/* Minimal shapes for the Web Speech API, which TypeScript's DOM lib still does not ship. */
type SpeechResultList = { length: number;[i: number]: { 0: { transcript: string }; isFinal: boolean } };
type SpeechRecognitionLike = {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { results: SpeechResultList; resultIndex: number }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
};
type RecognitionCtor = new () => SpeechRecognitionLike;

export type VoiceMode = "off" | "push_to_talk" | "important_only" | "briefing_1m" | "briefing_5m" | "war_room";

export const VOICE_MODES: { id: VoiceMode; label: string; hint: string }[] = [
  { id: "off", label: "Voice off", hint: "THE BRAIN stays silent. Everything still updates on screen." },
  { id: "push_to_talk", label: "Push to talk", hint: "It only speaks when you ask it something." },
  { id: "important_only", label: "Important only", hint: "It speaks when something genuinely changes." },
  { id: "briefing_1m", label: "Every minute", hint: "A short read every minute, plus anything important." },
  { id: "briefing_5m", label: "Every 5 minutes", hint: "A fuller read every five minutes." },
  { id: "war_room", label: "War room", hint: "It talks through everything it notices. Loud by design." },
];

export type Turn = { role: "user" | "assistant"; content: string; source?: string; at: number };

export type BrainConsoleProps = {
  /** A proactive line THE BRAIN wants to say. A new `key` means a new thing to announce. */
  announce: { key: string; text: string; urgent: boolean } | null;
  onUiAction?: (name: string, arg: string | number | null) => void;
  mode: VoiceMode;
  onModeChange: (m: VoiceMode) => void;
  /** Scheduled briefings only run against a live market — there is nothing to brief on a dead feed. */
  live?: boolean;
  className?: string;
};

const QUICK = [
  { label: "Talk to me", q: "THE BRAIN, talk to me." },
  { label: "What changed?", q: "What changed over the last five minutes?" },
  { label: "Why?", q: "Why are you reading it that way?" },
  { label: "What would change your mind?", q: "What would change your mind?" },
  { label: "Show me the math", q: "Show me the math." },
];

export function BrainConsole({ announce, onUiAction, mode, onModeChange, live = false, className = "" }: BrainConsoleProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const spokenKeys = useRef<Set<string>>(new Set());
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Capability checks must not run during render: the server has no speechSynthesis and the browser does,
  // so branching on it inline makes the first client paint disagree with the server and React bails out
  // of hydration. Resolve it after mount instead.
  const [canSpeak, setCanSpeak] = useState(false);
  useEffect(() => { setCanSpeak(typeof window !== "undefined" && "speechSynthesis" in window); }, []);

  /* ── speech out ─────────────────────────────────────────────────────────── */
  const stopSpeaking = useCallback(() => {
    if (!canSpeak) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [canSpeak]);

  const speak = useCallback((text: string) => {
    if (!canSpeak || modeRef.current === "off" || !text.trim()) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.03;
    u.pitch = 0.95;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
  }, [canSpeak]);

  /* ── ask ────────────────────────────────────────────────────────────────── */
  const ask = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    stopSpeaking();
    setInput("");
    setNotice(null);
    const history = turns.slice(-8).map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [...t, { role: "user", content: q, at: Date.now() }]);
    setBusy(true);
    try {
      const r = await fetch("/api/command-center/brain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: q, history }),
      });
      const j = await r.json();
      const text: string = j?.spokenText ?? "Something went wrong reaching THE BRAIN.";
      setTurns((t) => [...t, { role: "assistant", content: text, source: j?.source, at: Date.now() }]);
      if (j?.notice) setNotice(String(j.notice));
      for (const a of (j?.uiActions ?? []) as { name: string; arg: string | number | null }[]) onUiAction?.(a.name, a.arg);
      if (modeRef.current !== "off") speak(text);
    } catch {
      setTurns((t) => [...t, { role: "assistant", content: "I couldn't reach the command center just then.", at: Date.now() }]);
    } finally {
      setBusy(false);
    }
  }, [busy, turns, speak, stopSpeaking, onUiAction]);

  /* ── speech in ──────────────────────────────────────────────────────────── */
  const startListening = useCallback(() => {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      setMicError("This browser can't listen. Chrome on desktop or Android supports it; you can still type.");
      return;
    }
    // Interruption: the instant you start talking, it stops talking.
    stopSpeaking();
    try {
      const rec = new Ctor();
      rec.lang = "en-US";
      rec.continuous = false;
      rec.interimResults = true;
      let finalText = "";
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) finalText += res[0].transcript;
          else interim += res[0].transcript;
        }
        setInput((finalText + interim).trim());
      };
      rec.onerror = (e) => {
        setMicError(e?.error === "not-allowed" ? "Microphone permission was declined." : "The microphone stopped unexpectedly.");
        setListening(false);
      };
      rec.onend = () => {
        setListening(false);
        const said = finalText.trim();
        if (said) void ask(said);
      };
      recognition.current = rec;
      setMicError(null);
      setListening(true);
      rec.start();
    } catch {
      setMicError("Couldn't start the microphone.");
      setListening(false);
    }
  }, [ask, stopSpeaking]);

  const stopListening = useCallback(() => {
    try { recognition.current?.stop(); } catch { /* already stopped */ }
    setListening(false);
  }, []);

  /* ── proactive speech ───────────────────────────────────────────────────── */
  useEffect(() => {
    if (!announce || spokenKeys.current.has(announce.key)) return;
    spokenKeys.current.add(announce.key);
    // Push-to-talk still lets a genuine alert through; "off" never speaks, but the line is still shown.
    const allowed =
      mode === "war_room" || mode === "important_only" || mode === "briefing_1m" || mode === "briefing_5m"
        ? true
        : mode === "push_to_talk" && announce.urgent;
    setTurns((t) => [...t, { role: "assistant", content: announce.text, source: "brain", at: Date.now() }]);
    if (allowed) speak(announce.text);
  }, [announce, mode, speak]);

  /**
   * THE MINUTE INTELLIGENCE LOOP.
   *
   * On the briefing modes THE BRAIN volunteers a short read on a fixed cadence. It only runs against a
   * live market — briefing someone about a frozen feed is theatre — and it never stacks on top of a
   * request already in flight.
   */
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    const everyMs = mode === "briefing_1m" ? 60_000 : mode === "briefing_5m" ? 300_000 : 0;
    if (!everyMs || !live) return;
    const id = setInterval(() => {
      void askRef.current(
        mode === "briefing_1m"
          ? "Minute update. What has changed in the last minute, and what does it mean? Keep it to two or three sentences."
          : "Five minute update. What has changed, and has your read moved?",
      );
    }, everyMs);
    return () => clearInterval(id);
  }, [mode, live]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  useEffect(() => () => { try { recognition.current?.abort(); } catch { /* noop */ } window.speechSynthesis?.cancel(); }, []);

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      {/* mode strip */}
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
        {VOICE_MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => { onModeChange(m.id); if (m.id === "off") stopSpeaking(); }}
            title={m.hint}
            className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] transition"
            style={{
              background: mode === m.id ? "rgba(240,196,117,0.14)" : "rgba(255,255,255,0.03)",
              color: mode === m.id ? "#F0C475" : "rgba(232,239,247,0.45)",
              border: `1px solid ${mode === m.id ? "rgba(240,196,117,0.32)" : "rgba(255,255,255,0.06)"}`,
            }}
          >
            {m.label}
          </button>
        ))}
        {speaking && (
          <button onClick={stopSpeaking} className="ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em]"
            style={{ background: "rgba(240,196,117,0.14)", color: "#F0C475", border: "1px solid rgba(240,196,117,0.32)" }}>
            <Square className="h-3 w-3" /> Stop
          </button>
        )}
      </div>

      {/* transcript */}
      <div ref={scroller} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {!turns.length && (
          <div className="space-y-2 py-4 text-center">
            <p className="text-[12px]" style={{ color: "rgba(232,239,247,0.45)" }}>
              Press the microphone and say &ldquo;THE BRAIN, talk to me&rdquo;, or ask it anything about gold right now.
            </p>
            {!canSpeak && <p className="text-[11px]" style={{ color: "rgba(232,239,247,0.32)" }}>This browser can&rsquo;t speak aloud — replies will still appear here.</p>}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className="max-w-[88%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed"
              style={
                t.role === "user"
                  ? { background: "rgba(111,168,220,0.13)", color: "#E8EFF7", border: "1px solid rgba(111,168,220,0.22)" }
                  : { background: "rgba(255,255,255,0.035)", color: "#E8EFF7", border: "1px solid rgba(255,255,255,0.07)" }
              }
            >
              {t.content}
              {t.role === "assistant" && t.source === "narrator" && (
                <span className="mt-1 block text-[10px]" style={{ color: "rgba(232,239,247,0.32)" }}>deterministic voice</span>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="text-[12px]" style={{ color: "rgba(232,239,247,0.4)" }}>THE BRAIN is thinking…</div>}
        {notice && <div className="text-[11px]" style={{ color: "#F0C475" }}>{notice}</div>}
        {micError && <div className="text-[11px]" style={{ color: "#F4737B" }}>{micError}</div>}
      </div>

      {/* quick asks */}
      <div className="flex flex-wrap gap-1.5 px-3 pb-2">
        {QUICK.map((q) => (
          <button key={q.label} onClick={() => void ask(q.q)} disabled={busy}
            className="rounded-full px-2.5 py-1 text-[11px] transition disabled:opacity-40"
            style={{ background: "rgba(255,255,255,0.04)", color: "rgba(232,239,247,0.68)", border: "1px solid rgba(255,255,255,0.07)" }}>
            {q.label}
          </button>
        ))}
      </div>

      {/* input */}
      <div className="flex items-center gap-2 border-t px-3 py-2.5" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
        <button
          onClick={listening ? stopListening : startListening}
          aria-label={listening ? "Stop listening" : "Talk to THE BRAIN"}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full transition"
          style={{
            background: listening ? "rgba(244,115,123,0.18)" : "rgba(240,196,117,0.14)",
            border: `1px solid ${listening ? "rgba(244,115,123,0.42)" : "rgba(240,196,117,0.34)"}`,
            color: listening ? "#F4737B" : "#F0C475",
            boxShadow: listening ? "0 0 0 6px rgba(244,115,123,0.08)" : "none",
          }}
        >
          <Mic className="h-4 w-4" />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
          placeholder={listening ? "Listening…" : "Ask THE BRAIN about gold…"}
          className="min-w-0 flex-1 rounded-xl px-3 py-2 text-[13px] outline-none"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#E8EFF7" }}
        />
        <button onClick={() => void ask(input)} disabled={busy || !input.trim()} aria-label="Send"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full transition disabled:opacity-35"
          style={{ background: "rgba(111,168,220,0.14)", border: "1px solid rgba(111,168,220,0.28)", color: "#6FA8DC" }}>
          <Send className="h-4 w-4" />
        </button>
        <button onClick={() => onModeChange(mode === "off" ? "important_only" : "off")} aria-label="Toggle voice"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full"
          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", color: "rgba(232,239,247,0.5)" }}>
          {mode === "off" ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

export default BrainConsole;
