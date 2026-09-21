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
  /** "hud" is the Command Center HUD layout: avatars, action chips, and the large microphone bar. */
  variant?: "classic" | "hud";
  /** HUD action chips (replace the classic quick asks). */
  quick?: { label: string; q: string }[];
  /** Ask something from outside the console (EXPLAIN FURTHER, a chip elsewhere). A new `n` asks again. */
  askSignal?: { n: number; q: string } | null;
  /** Lets the page show the Brain as thinking / speaking / listening. */
  onActivity?: (a: { busy: boolean; speaking: boolean; listening: boolean }) => void;
};

const QUICK = [
  { label: "Talk to me", q: "THE BRAIN, talk to me." },
  { label: "What changed?", q: "What changed over the last five minutes?" },
  { label: "Why?", q: "Why are you reading it that way?" },
  { label: "What would change your mind?", q: "What would change your mind?" },
  { label: "Show me the math", q: "Show me the math." },
];

export function BrainConsole({ announce, onUiAction, mode, onModeChange, live = false, className = "", variant = "classic", quick, askSignal, onActivity }: BrainConsoleProps) {
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

  // Outside asks (EXPLAIN FURTHER, HUD chips elsewhere on the page).
  const lastSignal = useRef<number | null>(null);
  useEffect(() => {
    if (!askSignal || askSignal.n === lastSignal.current) return;
    lastSignal.current = askSignal.n;
    void askRef.current(askSignal.q);
  }, [askSignal]);

  useEffect(() => { onActivity?.({ busy, speaking, listening }); }, [busy, speaking, listening, onActivity]);

  // Space to talk, when the HUD is showing and focus is not in a text field.
  useEffect(() => {
    if (variant !== "hud") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.tagName === "BUTTON" || el.tagName === "SELECT")) return;
      e.preventDefault();
      if (listening) stopListening(); else startListening();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant, listening, startListening, stopListening]);

  if (variant === "hud") {
    const t12 = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return (
      <div className={`flex h-full min-h-0 flex-col ${className}`}>
        <div ref={scroller} className="hud-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
          {!turns.length && (
            <div className="flex gap-2.5">
              <BrainAvatar />
              <div className="min-w-0 flex-1">
                <p className="mb-1 text-[9.5px] font-bold uppercase tracking-[0.12em]" style={{ color: "#E7C467" }}>The Brain</p>
                <div className="rounded-[8px] px-3 py-2.5 text-[12.5px] leading-relaxed" style={{ background: "rgba(9,19,29,0.9)", border: "1px solid rgba(89,175,255,0.13)", color: "#DCE6EE" }}>
                  I&rsquo;m watching gold. Ask me what I&rsquo;m seeing, why, or what would change my mind — or press the microphone and just talk.
                </div>
              </div>
            </div>
          )}
          {turns.map((t, i) => t.role === "user" ? (
            <div key={i} className="flex flex-col items-end">
              <p className="mb-1 text-[9.5px]" style={{ color: "#81909E" }}><span style={{ color: "#59AFFF", fontWeight: 700 }}>You</span> &nbsp;{t12(t.at)}</p>
              <div className="max-w-[88%] rounded-[8px] px-3 py-2 text-[12.5px] leading-relaxed" style={{ background: "rgba(21,52,92,0.75)", border: "1px solid rgba(89,175,255,0.35)", color: "#F0F4F7" }}>{t.content}</div>
            </div>
          ) : (
            <div key={i} className="flex gap-2.5">
              <BrainAvatar />
              <div className="min-w-0 flex-1">
                <p className="mb-1 text-[9.5px]" style={{ color: "#81909E" }}><span className="font-bold uppercase tracking-[0.12em]" style={{ color: "#E7C467" }}>The Brain</span> &nbsp;{t12(t.at)}</p>
                <div className="whitespace-pre-line rounded-[8px] px-3 py-2.5 text-[12.5px] leading-relaxed" style={{ background: "rgba(9,19,29,0.9)", border: "1px solid rgba(89,175,255,0.13)", color: "#DCE6EE" }}>{t.content}</div>
              </div>
            </div>
          ))}
          {busy && <p className="pl-10 text-[11.5px]" style={{ color: "#27D7F2" }}>THE BRAIN is thinking…</p>}
          {notice && <p className="text-[11px]" style={{ color: "#E7C467" }}>{notice}</p>}
          {micError && <p className="text-[11px]" style={{ color: "#FF5364" }}>{micError}</p>}
        </div>

        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {(quick ?? QUICK).map((q) => (
            <button key={q.label} onClick={() => void ask(q.q)} disabled={busy}
              className="rounded-[6px] px-2.5 py-[5px] text-[10.5px] transition hover:brightness-125 disabled:opacity-40"
              style={{ background: "rgba(9,19,29,0.9)", color: "#C5D1DB", border: "1px solid rgba(89,175,255,0.18)" }}>
              {q.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t px-3 py-2.5" style={{ borderColor: "rgba(89,175,255,0.1)" }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
            placeholder={listening ? "Listening…" : "Ask THE BRAIN…"}
            className="min-w-0 flex-1 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none"
            style={{ background: "rgba(3,7,11,0.8)", border: "1px solid rgba(89,175,255,0.14)", color: "#F0F4F7" }}
          />
          <button onClick={() => void ask(input)} disabled={busy || !input.trim()} aria-label="Send"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full disabled:opacity-35"
            style={{ border: "1px solid rgba(89,175,255,0.25)", color: "#59AFFF" }}>
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-1">
          <button onClick={() => onModeChange(mode === "off" ? "important_only" : "off")} aria-label="Toggle spoken replies"
            className="grid h-8 w-8 place-items-center rounded-full" style={{ border: "1px solid rgba(89,175,255,0.18)", color: "#81909E" }}>
            {mode === "off" ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
          <Wave active={listening || speaking} color={speaking ? "#E7C467" : "#27D7F2"} />
          <button
            onClick={listening ? stopListening : startListening}
            aria-label={listening ? "Stop listening" : "Talk to THE BRAIN"}
            className="relative grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full transition"
            style={{
              background: "radial-gradient(circle at 40% 35%, #3A2C0C, #120D04)",
              border: `2px solid ${listening ? "#FFD875" : "#D5A93D"}`,
              color: "#FFD875",
              boxShadow: listening ? "0 0 0 6px rgba(255,216,117,0.12), 0 0 26px rgba(255,216,117,0.55)" : "0 0 16px rgba(213,169,61,0.35)",
            }}>
            {listening && <span className="hud-ping absolute inset-0 rounded-full" style={{ border: "1px solid #FFD875" }} />}
            <Mic className="h-5 w-5" />
          </button>
          <Wave active={listening || speaking} color={speaking ? "#E7C467" : "#27D7F2"} flip />
          <p className="w-[72px] text-[10px] leading-tight" style={{ color: "#81909E" }}>{listening ? "Listening…" : speaking ? "Speaking — tap to interrupt" : "Click to speak or press space"}</p>
          {speaking && (
            <button onClick={stopSpeaking} aria-label="Stop speaking" className="grid h-8 w-8 place-items-center rounded-full" style={{ border: "1px solid rgba(231,196,103,0.4)", color: "#E7C467" }}>
              <Square className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    );
  }

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

function BrainAvatar() {
  return (
    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full" style={{ background: "radial-gradient(circle at 40% 35%, #FFD875, #8A5F12 70%)", boxShadow: "0 0 0 2px rgba(39,215,242,0.35), 0 0 10px rgba(255,216,117,0.4)" }}>
      <span className="h-2 w-2 rounded-full" style={{ background: "#FFF3D0" }} />
    </span>
  );
}

function Wave({ active, color, flip = false }: { active: boolean; color: string; flip?: boolean }) {
  const hs = [4, 8, 13, 7, 16, 10, 5, 12, 6];
  return (
    <span className="flex h-6 items-center gap-[2px]" style={{ transform: flip ? "scaleX(-1)" : undefined }} aria-hidden>
      {hs.map((h, i) => (
        <span key={i} className="w-[2px] rounded-full" style={{
          height: h + 4, background: color, opacity: active ? 0.95 : 0.35,
          animation: active ? `hudBar ${0.6 + (i % 4) * 0.15}s ease-in-out ${i * 0.07}s infinite` : "none", transformOrigin: "center",
        }} />
      ))}
    </span>
  );
}

export default BrainConsole;
