"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { explainBus } from "./hud/explainBus";
import { asksToShow, isRepeatAsk, transcriptOf, turnKey } from "./voiceLine";
import { Crosshair, Mic, Send, Square } from "lucide-react";
import { CHART_ACTION_EVENT, type ChartAction, type FeedStatus, type Lean } from "../../../command-center/core/atlasContract";
import { FEED_WORD, refToAction, type AnswerItem, type AtlasAnswer } from "../../../command-center/brain/answer";

/**
 * TALKING TO ATLAS.
 *
 * Speech in through the browser's recognition API, speech out through its synthesis API, behind one small
 * abstraction so a dedicated speech provider can replace either end without touching this component.
 * Nothing here is simulated: if the browser cannot listen, the microphone says so rather than pretending.
 *
 * Interruption is the part that makes it feel like a conversation rather than an announcement system:
 * the moment you start speaking, ATLAS stops.
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

/*
 * OWNER 09-21: the written console never speaks. Only the ATLAS voice line (VoiceSession) talks —
 * one voice, the one you called. These modes now only decide how much ATLAS volunteers IN TEXT.
 */
export const VOICE_MODES: { id: VoiceMode; label: string; hint: string }[] = [
  { id: "off", label: "Quiet", hint: "ATLAS only answers what you ask." },
  { id: "push_to_talk", label: "On ask", hint: "Answers what you ask, plus urgent alerts." },
  { id: "important_only", label: "Important only", hint: "Posts a line when something genuinely changes." },
  { id: "briefing_1m", label: "Every minute", hint: "A short written read every minute." },
  { id: "briefing_5m", label: "Every 5 minutes", hint: "A fuller written read every five minutes." },
  { id: "war_room", label: "War room", hint: "Writes up everything it notices." },
];

const TEXT_ONLY = true;

/** What the console shows for an answer: the contract (lean, evidence, next, wrong-if, freshness, actions). */
export type Turn = {
  role: "user" | "assistant";
  content: string;
  source?: string;
  at: number;
  /** A structured answer from /api/command-center/brain. Absent on announcements and older replies. */
  answer?: AtlasAnswer | null;
  /** `answeredAt` is the SERVER's clock, sent back so "since your last update" is measured on one clock. */
  meta?: { snapshotId: number | null; analysisAt: number | null; answeredAt: number | null; feed: FeedStatus | null } | null;
};

/** The read the screen is showing, so "what changed since…" is measured from what the trader actually saw. */
export type SeenRead = { snapshotId?: number | null; at?: number | null; lean?: Lean | string | null } | null;

/** Said once, plainly, when the server answers 401/402 — never "something went wrong". */
export const PASS_ENDED = "Your Command Center window has ended.";
/** The page (PassGate) listens for this and offers the renewal. */
export const PASS_RENEW_EVENT = "cc:pass-renew";

/** Put a validated chart action on the chart. The chart listens for CHART_ACTION_EVENT. */
export function dispatchChartAction(a: ChartAction | null | undefined) {
  if (!a || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHART_ACTION_EVENT, { detail: a }));
}

export type BrainConsoleProps = {
  /** A proactive line ATLAS wants to say. A new `key` means a new thing to announce. */
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
  /** Lets the page show Atlas as thinking / speaking / listening. */
  onActivity?: (a: { busy: boolean; speaking: boolean; listening: boolean }) => void;
  /** The timeframe the chart is showing. Sent with each question: a view, never the analysis horizon. */
  chartTf?: string | null;
  /** The read the screen is showing (snapshot id, time, lean). Sent with each question. */
  seen?: SeenRead;
};

const LEAN_TONE: Record<Lean, string> = {
  bullish_lean: "#2BD48F",
  bearish_lean: "#FF5364",
  balanced: "#27D7F2",
  transitioning: "#E7C467",
  insufficient_data: "#81909E",
};

/** The turns sent back with a question: what was asked, what was answered, and the read it was answered against. */
function wireHistory(turns: Turn[]) {
  return turns.filter((t) => t.source !== "system").slice(-8).map((t) => ({
    role: t.role,
    content: t.content,
    at: t.meta?.answeredAt ?? t.at,
    ...(t.answer?.read ? { read: { lean: t.answer.read.lean, snapshotId: t.meta?.snapshotId ?? t.answer.read.snapshotId ?? null, at: t.answer.read.at ?? null } } : {}),
  }));
}

const QUICK = [
  { label: "Talk to me", q: "ATLAS, talk to me." },
  { label: "What changed?", q: "What changed over the last five minutes?" },
  { label: "Why?", q: "Why are you reading it that way?" },
  { label: "What would change your mind?", q: "What would change your mind?" },
  { label: "Show me the math", q: "Show me the math." },
];

export function BrainConsole({ announce, onUiAction, mode, onModeChange, live = false, className = "", variant = "classic", quick, askSignal, onActivity, chartTf = null, seen = null }: BrainConsoleProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The server said 401/402: the Command Center window is over until it is renewed. */
  const [ended, setEnded] = useState<null | "pass" | "auth">(null);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const spokenKeys = useRef<Set<string>>(new Set());
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Read inside `ask` without re-creating it on every turn.
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const chartTfRef = useRef(chartTf);
  chartTfRef.current = chartTf;
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const busyRef = useRef(false);
  const endedRef = useRef(ended);
  endedRef.current = ended;
  /*
   * STALE-RESPONSE GUARD. Every question gets a sequence number; a newer question aborts the one in
   * flight, and an answer that arrives for anything but the newest question is dropped — so "what about
   * now?" can never be answered by the reply to the question before it.
   */
  const seqRef = useRef(0);
  /** The last question the member asked, and when: the same words again within a moment are one question. */
  const lastAskRef = useRef<{ key: string; at: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** The level the chart last highlighted for the trader: "watch this level" means this one. */
  const focusRef = useRef<string | null>(null);

  const pointAt = useCallback((a: ChartAction | null | undefined) => {
    if (!a) return;
    if (a.type === "highlight_level") focusRef.current = a.levelId;
    dispatchChartAction(a);
  }, []);
  const renew = useCallback(() => {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PASS_RENEW_EVENT));
  }, []);

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

  // The written console is text only (owner 09-21). Kept as a no-op so every caller stays simple.
  const speak = useCallback((text: string) => {
    if (TEXT_ONLY || !canSpeak || modeRef.current === "off" || !text.trim()) return;
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
  /**
   * Ask ATLAS. A question typed or spoken while another is in flight supersedes it (the older request is
   * aborted and its answer ignored); a scheduled briefing never interrupts a question — it just skips.
   * Each question carries the recent turns and what the trader last saw, so "why?" and "what about
   * now?" are answered about the right statement.
   */
  const ask = useCallback(async (question: string, opts: { auto?: boolean } = {}) => {
    const q = question.trim();
    if (!q) return;
    if (opts.auto && (busyRef.current || endedRef.current)) return;
    /* ONE QUESTION, ONE TURN (owner 11-11: "repeats my question twice"): the same words submitted again within a
       moment — a double Enter, a double tap, a recogniser ending twice — are the same question, not a second. */
    const askedAt = Date.now();
    if (!opts.auto && isRepeatAsk(q, lastAskRef.current, askedAt)) return;
    if (!opts.auto) lastAskRef.current = { key: turnKey(q), at: askedAt };
    stopSpeaking();
    setInput("");
    setNotice(null);
    const prior = turnsRef.current;
    const history = wireHistory(prior);
    const lastAnswer = [...prior].reverse().find((t) => t.role === "assistant" && t.answer);
    const s = seenRef.current;
    const lastSeen = {
      snapshotId: s?.snapshotId ?? lastAnswer?.meta?.snapshotId ?? null,
      readAt: s?.at ?? lastAnswer?.answer?.read?.at ?? null,
      lean: s?.lean ?? lastAnswer?.answer?.read?.lean ?? null,
      answerAt: lastAnswer?.meta?.answeredAt ?? lastAnswer?.at ?? null,
      focusLevelId: focusRef.current,
    };
    setTurns((t) => [...t, { role: "user", content: q, at: Date.now() }]);

    const mySeq = ++seqRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // "Show me that": the evidence from the last answer is pointed at straight away, before the reply.
    if (asksToShow(q)) explainBus.showNext();
    const requestId = `${Date.now().toString(36)}-${mySeq}`;
    busyRef.current = true;
    setBusy(true);
    const current = () => mySeq === seqRef.current;
    try {
      const r = await fetch("/api/command-center/brain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: q, history, lastSeen, chartTf: chartTfRef.current ?? null, requestId }),
        signal: ac.signal,
      });
      if (!current()) return;
      // The window is over: say so plainly and offer the renewal, rather than "something went wrong".
      if (r.status === 401 || r.status === 402) {
        setEnded(r.status === 402 ? "pass" : "auth");
        return;
      }
      const j = await r.json().catch(() => null);
      if (!current() || (j?.requestId && j.requestId !== requestId)) return;
      if (!r.ok || !j) {
        setTurns((t) => [...t, { role: "assistant", content: "ATLAS couldn't answer that just then. Try again in a moment.", source: "system", at: Date.now() }]);
        return;
      }
      setEnded(null);
      const answer: AtlasAnswer | null = j.answer && typeof j.answer.say === "string" ? (j.answer as AtlasAnswer) : null;
      const text: string = answer?.say ?? (typeof j.spokenText === "string" ? j.spokenText : "ATLAS couldn't answer that just then.");
      setTurns((t) => [...t, {
        role: "assistant", content: text, source: j.source, at: Date.now(), answer,
        meta: {
          snapshotId: j.snapshotId ?? null, analysisAt: j.analysisAt ?? null,
          answeredAt: typeof j.answeredAt === "number" ? j.answeredAt : null, feed: (j.feed?.status as FeedStatus) ?? null,
        },
      }]);
      if (j.notice) setNotice(String(j.notice));
      /* THE ANSWER, EXPLAINED ON THE CHART (hud/explainBus.ts). Its text is turned into an explanation sequence
         against what the screen really holds; the server's own validated actions ride along. A typed answer has
         no audio to follow, so its whole sequence is shown at once and "Show me" steps through it. Without a
         desk to explain on (the classic console) the validated actions are applied as before. */
      const explained = explainBus.begin(`chat-${requestId}`, text, {
        actions: answer?.actions ?? [], typed: true,
        // The price this answer was built from: the screen re-checks it against the live price before showing it.
        priceAt: typeof j.feed?.price === "number" ? j.feed.price : null,
      });
      if (!explained) for (const a of answer?.actions ?? []) pointAt(a);
      for (const a of (j.uiActions ?? []) as { name: string; arg: string | number | null }[]) onUiAction?.(a.name, a.arg);
      if (modeRef.current !== "off") speak(text);
    } catch {
      if (ac.signal.aborted || !current()) return;   // superseded by a newer question
      setTurns((t) => [...t, { role: "assistant", content: "I couldn't reach the command center just then.", source: "system", at: Date.now() }]);
    } finally {
      if (current()) { busyRef.current = false; setBusy(false); }
    }
  }, [speak, stopSpeaking, onUiAction, pointAt]);

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
        /* ONE QUESTION, ONCE (owner 11-11: "repeats my question twice"). This used to ADD every final result to
           what it already had. Chrome on Android re-delivers the utterance so far as a new final result, so the
           question was sent with its own words repeated. The transcript is now rebuilt from all the results each
           time, and a final that only repeats or restarts what is there is dropped (voiceLine.ts transcriptOf). */
        const t = transcriptOf(e.results);
        finalText = t.final;
        setInput(`${t.final} ${t.interim}`.trim());
      };
      rec.onerror = (e) => {
        setMicError(e?.error === "not-allowed" ? "Microphone permission was declined." : "The microphone stopped unexpectedly.");
        setListening(false);
      };
      let sent = false;
      rec.onend = () => {
        setListening(false);
        const said = finalText.trim();
        // `onend` can fire twice on some browsers (once for stop(), once for the session): one question, one ask.
        if (said && !sent) { sent = true; void ask(said); }
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
   * On the briefing modes ATLAS volunteers a short read on a fixed cadence. It only runs against a
   * live market — briefing someone about a frozen feed is theatre — and it never stacks on top of a
   * request already in flight.
   */
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    const everyMs = mode === "briefing_1m" ? 60_000 : mode === "briefing_5m" ? 300_000 : 0;
    if (!everyMs || !live) return;
    const id = setInterval(() => {
      // auto: a scheduled update never interrupts a question in flight, and stops once the window has ended.
      void askRef.current(
        mode === "briefing_1m"
          ? "Minute update. What has changed in the last minute, and what does it mean? Keep it to two or three sentences."
          : "Five minute update. What has changed, and has your read moved?",
        { auto: true },
      );
    }, everyMs);
    return () => clearInterval(id);
  }, [mode, live]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  useEffect(() => () => {
    try { recognition.current?.abort(); } catch { /* noop */ }
    window.speechSynthesis?.cancel();
    abortRef.current?.abort();
  }, []);

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
                <p className="mb-1 text-[9.5px] font-bold uppercase tracking-[0.12em]" style={{ color: "#E7C467" }}>Atlas</p>
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
                <p className="mb-1 text-[9.5px]" style={{ color: "#81909E" }}><span className="font-bold uppercase tracking-[0.12em]" style={{ color: "#E7C467" }}>Atlas</span> &nbsp;{t12(t.at)}</p>
                <div className="whitespace-pre-line rounded-[8px] px-3 py-2.5 text-[12.5px] leading-relaxed" style={{ background: "rgba(9,19,29,0.9)", border: "1px solid rgba(89,175,255,0.13)", color: "#DCE6EE" }}>
                  {t.answer ? <AnswerView answer={t.answer} feed={t.meta?.feed ?? null} onPoint={pointAt} palette={HUD_PALETTE} /> : t.content}
                </div>
              </div>
            </div>
          ))}
          {busy && <p className="pl-10 text-[11.5px]" style={{ color: "#27D7F2" }}>ATLAS is thinking…</p>}
          {ended && <PassEnded kind={ended} onRenew={renew} palette={HUD_PALETTE} />}
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
            placeholder={listening ? "Listening…" : "Ask ATLAS…"}
            className="min-w-0 flex-1 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none"
            style={{ background: "rgba(3,7,11,0.8)", border: "1px solid rgba(89,175,255,0.14)", color: "#F0F4F7" }}
          />
          <button onClick={() => void ask(input)} disabled={!input.trim()} aria-label="Send"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full disabled:opacity-35"
            style={{ border: "1px solid rgba(89,175,255,0.25)", color: "#59AFFF" }}>
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-1">
          <span className="h-8 w-8" aria-hidden />
          <Wave active={listening || speaking} color={speaking ? "#E7C467" : "#27D7F2"} />
          <button
            onClick={listening ? stopListening : startListening}
            aria-label={listening ? "Stop listening" : "Talk to ATLAS"}
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
              Press the microphone and say &ldquo;ATLAS, talk to me&rdquo;, or ask it anything about gold right now.
            </p>
            
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
              {t.role === "assistant" && t.answer
                ? <AnswerView answer={t.answer} feed={t.meta?.feed ?? null} onPoint={pointAt} palette={CLASSIC_PALETTE} />
                : t.content}
              {t.role === "assistant" && t.source === "narrator" && (
                <span className="mt-1 block text-[10px]" style={{ color: "rgba(232,239,247,0.32)" }}>deterministic voice</span>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="text-[12px]" style={{ color: "rgba(232,239,247,0.4)" }}>ATLAS is thinking…</div>}
        {ended && <PassEnded kind={ended} onRenew={renew} palette={CLASSIC_PALETTE} />}
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
          aria-label={listening ? "Stop listening" : "Talk to ATLAS"}
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
          placeholder={listening ? "Listening…" : "Ask ATLAS about gold…"}
          className="min-w-0 flex-1 rounded-xl px-3 py-2 text-[13px] outline-none"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#E8EFF7" }}
        />
        <button onClick={() => void ask(input)} disabled={!input.trim()} aria-label="Send"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full transition disabled:opacity-35"
          style={{ background: "rgba(111,168,220,0.14)", border: "1px solid rgba(111,168,220,0.28)", color: "#6FA8DC" }}>
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/* ── a structured answer ─────────────────────────────────────────────────── */

type Palette = { muted: string; text: string; cyan: string; red: string; green: string; gold: string; chip: string };
const HUD_PALETTE: Palette = { muted: "#81909E", text: "#DCE6EE", cyan: "#27D7F2", red: "#FF5364", green: "#2BD48F", gold: "#E7C467", chip: "rgba(89,175,255,0.18)" };
const CLASSIC_PALETTE: Palette = { muted: "rgba(232,239,247,0.45)", text: "#E8EFF7", cyan: "#6FA8DC", red: "#F4737B", green: "#5FD3A0", gold: "#F0C475", chip: "rgba(255,255,255,0.1)" };

/**
 * The read first (lean + horizon, and the feed when it is not live), then what ATLAS said, then the
 * evidence for and against — each line that points at something on the chart is a button that shows it —
 * then what it is waiting for, what would make it wrong, and how fresh all of it is.
 */
function AnswerView({ answer, feed, onPoint, palette: P }: { answer: AtlasAnswer; feed: FeedStatus | null; onPoint: (a: ChartAction | null) => void; palette: Palette }) {
  const r = answer.read;
  const tone = r ? LEAN_TONE[r.lean] ?? P.muted : P.muted;
  return (
    <div className="whitespace-normal">
      {(r || (feed && feed !== "live")) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {r && (
            <span className="rounded-[4px] px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-[0.1em]"
              style={{ color: tone, border: `1px solid ${tone}66`, background: `${tone}17` }}>
              {r.label}{r.strength ? ` · ${r.strength}` : ""}
            </span>
          )}
          {r && <span className="text-[10px]" style={{ color: P.muted }}>{r.horizon === "intraday" ? "Intraday" : r.horizon} · {r.horizonTf} horizon</span>}
          {feed && feed !== "live" && (
            <span className="rounded-[4px] px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-[0.1em]"
              style={{ color: P.gold, border: `1px solid ${P.gold}66` }}>{FEED_WORD[feed]}</span>
          )}
        </div>
      )}
      <p className="whitespace-pre-line">{answer.say}</p>
      {(answer.evidence.length > 0 || answer.against.length > 0) && (
        <ul className="mt-2 space-y-1">
          {answer.evidence.map((e, i) => <EvidenceRow key={`f${i}`} item={e} kind="for" onPoint={onPoint} palette={P} />)}
          {answer.against.map((e, i) => <EvidenceRow key={`a${i}`} item={e} kind="against" onPoint={onPoint} palette={P} />)}
        </ul>
      )}
      {answer.next && (
        <p className="mt-2 text-[11.5px] leading-snug"><span className="mr-1 text-[9.5px] font-bold uppercase tracking-[0.1em]" style={{ color: P.cyan }}>Next</span>{answer.next}</p>
      )}
      {answer.invalidation && (
        <p className="mt-0.5 text-[11.5px] leading-snug"><span className="mr-1 text-[9.5px] font-bold uppercase tracking-[0.1em]" style={{ color: P.red }}>Wrong if</span>{answer.invalidation}</p>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-[9.5px] tabular-nums" style={{ color: P.muted }}>{answer.freshness}</span>
        {answer.actions.length > 0 && (
          <button onClick={() => answer.actions.forEach((a) => onPoint(a))}
            className="inline-flex shrink-0 items-center gap-1 rounded-[5px] px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-[0.08em] hover:brightness-125"
            style={{ color: P.cyan, border: `1px solid ${P.chip}` }}>
            <Crosshair className="h-3 w-3" /> Show on chart
          </button>
        )}
      </div>
    </div>
  );
}

function EvidenceRow({ item, kind, onPoint, palette: P }: { item: AnswerItem; kind: "for" | "against"; onPoint: (a: ChartAction | null) => void; palette: Palette }) {
  const action = item.action ?? (item.ref ? refToAction(item.ref) : null);
  const mark = <span className="mt-[1px] w-3 shrink-0 text-center font-bold" style={{ color: kind === "for" ? P.green : P.red }} aria-hidden>{kind === "for" ? "+" : "−"}</span>;
  return (
    <li className="flex gap-1.5 text-[11.5px] leading-snug">
      {mark}
      {action ? (
        <button onClick={() => onPoint(action)} title="Show this on the chart"
          className="text-left underline decoration-dotted underline-offset-2 hover:brightness-125" style={{ color: P.text }}>
          <span className="sr-only">{kind === "for" ? "Evidence for: " : "Evidence against: "}</span>
          {item.text}
          <Crosshair className="ml-1 inline h-3 w-3 align-[-2px]" style={{ color: P.cyan }} />
        </button>
      ) : (
        <span style={{ color: P.text }}><span className="sr-only">{kind === "for" ? "Evidence for: " : "Evidence against: "}</span>{item.text}</span>
      )}
    </li>
  );
}

/** 401/402: the window is over. Said once, plainly, with the way back. */
function PassEnded({ kind, onRenew, palette: P }: { kind: "pass" | "auth"; onRenew: () => void; palette: Palette }) {
  return (
    <div role="status" className="rounded-[8px] px-3 py-2.5 text-[12px] leading-snug" style={{ border: `1px solid ${P.gold}73`, background: "rgba(213,169,61,0.08)", color: P.text }}>
      <p className="font-semibold" style={{ color: P.gold }}>{PASS_ENDED}</p>
      <p className="mt-0.5" style={{ color: P.muted }}>
        {kind === "auth" ? "You've also been signed out — sign in again, then renew to keep talking to ATLAS." : "Renew it to keep talking to ATLAS. Nothing renews without you."}
      </p>
      <button onClick={onRenew} className="mt-2 rounded-[6px] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.1em] hover:brightness-110"
        style={{ background: "#D5A93D", color: "#10131A" }}>
        Renew
      </button>
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
