"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, ArrowUpRight, ChevronDown, Layers3, Loader2, MessageCircle, Mic, MicOff, PhoneOff, Send, Settings2, Sparkles, SquarePen, Volume2, VolumeX, X } from "lucide-react";
import { VoiceSession, type VoiceTurn } from "@/components/command-center/VoiceSession";
import { appVoiceBus, lineOpen, useAppVoiceBus, voiceBus } from "@/components/command-center/voiceBus";
import { useFlowAccount } from "@/components/om/FlowAccount";
import { ProductIcon } from "@/components/om/ProductIcon";
import { findAsset } from "@/data/signalAssets";
import { ATLAS_OPEN_EVENT, type AtlasContext as ViewContext, type AtlasOpenRequest } from "@/lib/atlas/open";
import { atlasMessages, normalizeAtlasActions, planAtlasActions } from "@/lib/atlas/actions";
import { atlasSignalContext, generateAtlasSignal, restoreAtlasSignalResult, type AtlasSignalResult } from "@/lib/atlas/signals";
import { parseAtlasPulseResult, scanWithAtlas, type AtlasPulseResult } from "@/lib/atlas/pulse";
import type { AtlasAction, AtlasContext, AtlasDestination, AtlasMessage } from "@/lib/atlas/types";
import { AtlasActionCard, AtlasPulseCard, ATLAS_LINKS } from "./AtlasActionCard";
import { AtlasSignalCard } from "./AtlasSignalCard";
import "./atlas.css";

type Message = AtlasMessage & {
  id: string; at: number; source?: "voice"; actions?: AtlasAction[]; completed?: number[];
  signal?: AtlasSignalResult; pulse?: AtlasPulseResult;
};
const PanelContext = createContext({ open: false });
export const useAtlasPanel = () => useContext(PanelContext);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const newMessage = (role: Message["role"], content: string, extra: Partial<Message> = {}): Message => ({ id: uid(), role, content, at: Date.now(), ...extra });

function restoreMessages(raw: string | null): Message[] {
  try {
    const stored = JSON.parse(raw ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((m) => m && typeof m.id === "string" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-24).map((m) => {
      const clean: Message = { id: m.id, role: m.role, content: m.content.slice(0, 8000), at: Number(m.at) || 0 };
      if (m.source === "voice") clean.source = "voice";
      if (Array.isArray(m.actions)) clean.actions = normalizeAtlasActions(m.actions);
      if (Array.isArray(m.completed)) clean.completed = m.completed.filter((n: unknown) => Number.isInteger(n));
      const signal = restoreAtlasSignalResult(m.signal);
      if (signal) clean.signal = signal;
      const pulse = parseAtlasPulseResult(m.pulse);
      if (pulse) clean.pulse = pulse;
      return clean;
    });
  } catch { return []; }
}

/** Only the tool data being discussed goes to the assistant. The server re-checks the selected account. */
function contextFor(view: ViewContext | null, account: { id: string; environment: string } | null): AtlasContext {
  const source = view?.source.toLowerCase() ?? "";
  const kind = source === "floor" ? "floor" : source.includes("genx") ? "genx" : source.includes("pulse") ? "pulse" : source.includes("play") || source.includes("signal") ? "plays" : null;
  return {
    screen: typeof window === "undefined" ? "" : window.location.pathname + (new URLSearchParams(window.location.search).has("view") ? `?view=${new URLSearchParams(window.location.search).get("view")}` : ""),
    ...(account ? { account: { id: account.id, environment: account.environment } } : {}),
    ...(kind && view?.data ? { result: { kind, data: view.data } } : {}),
  };
}

function actionFromOpen(request: AtlasOpenRequest): AtlasAction | null {
  const d = request.context?.data;
  if (request.tool === "plays") {
    const proposed = typeof d?.td === "string" ? d.td : typeof d?.symbol === "string" ? d.symbol : "";
    const td = findAsset(proposed)?.asset.td;
    const style = d?.style === "scalp" || d?.style === "intraday" || d?.style === "swing" ? d.style : undefined;
    return { type: "plays", ...(td ? { td } : {}), ...(style ? { style } : {}) };
  }
  if (request.tool === "genx") return { type: "genx", ...(d?.mode === "quick" || d?.mode === "intraday" || d?.mode === "swing" ? { mode: d.mode } : {}) };
  return request.tool === "pulse" ? { type: "pulse" } : null;
}

export function AtlasProvider({ children, configured = true, memberKey }: {
  children: React.ReactNode; configured?: boolean; memberKey: string;
}) {
  const router = useRouter();
  const flow = useFlowAccount();
  const voice = useAppVoiceBus();
  const onLine = lineOpen(voice.status);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [context, setContext] = useState<ViewContext | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pass, setPass] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState(false);
  const [voiceAttempted, setVoiceAttempted] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const messageRef = useRef(messages);
  const contextRef = useRef(context);
  const openRef = useRef(open);
  const busyRef = useRef(false);
  const workRef = useRef(false);
  const mounted = useRef(true);
  const voiceAfter = useRef(0);
  const account = flow && !flow.switching ? flow.ov?.account ?? null : null;
  const accountRef = useRef(account);
  accountRef.current = account; messageRef.current = messages; contextRef.current = context; openRef.current = open;
  const storageKey = `om:atlas:conversation:v1:${encodeURIComponent(memberKey)}`;
  const sessionKey = useRef(storageKey); sessionKey.current = storageKey;

  useEffect(() => {
    mounted.current = true;
    voiceAfter.current = Date.now();
    busyRef.current = false; workRef.current = false;
    setBusy(false); setWorking(null); setContext(null); setError(""); setInput("");
    const restored = restoreMessages(sessionStorageSafe(storageKey));
    setMessages(restored);
    const latestResult = [...restored].reverse().find((message) => message.signal || message.pulse);
    if (latestResult?.signal) setContext(atlasSignalContext(latestResult.signal));
    else if (latestResult?.pulse) setContext({ source: "Market Pulse", label: "Latest market scan", data: latestResult.pulse });
    setHydratedKey(storageKey);
    return () => { mounted.current = false; appVoiceBus.end(); };
  }, [storageKey]);
  useEffect(() => {
    if (hydratedKey !== storageKey) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(messages.slice(-24))); } catch { /* The active conversation still works. */ }
  }, [messages, hydratedKey, storageKey]);

  const append = useCallback((message: Message) => setMessages((previous) => [...previous, message].slice(-40)), []);
  const close = useCallback(() => {
    appVoiceBus.end();
    setOpen(false); setVoiceSettings(false); setVoiceAttempted(false);
  }, []);
  const startVoice = useCallback((view?: ViewContext) => {
    setError("");
    if (!configured) return;
    setVoiceAttempted(true);
    if (lineOpen(voiceBus.get().status)) voiceBus.end();
    if (appVoiceBus.ready()) appVoiceBus.start(contextFor(view ?? contextRef.current, accountRef.current));
    else setError("Voice is still getting ready. You can type here, or try the microphone again in a moment.");
  }, [configured]);

  const ask = useCallback(async (raw: string, supplied?: ViewContext) => {
    const question = raw.trim().slice(0, 3000);
    if (!question || busyRef.current || !configured) return;
    const activeContext = supplied ?? contextRef.current;
    if (supplied) setContext(supplied);
    setInput(""); setError("");
    // A typed message on an open voice line is one turn on that same line, with no second text charge.
    // An explicit signal explanation uses the text endpoint so the exact result travels with it.
    if (!supplied && lineOpen(appVoiceBus.get().status) && appVoiceBus.sendText(question)) return;
    busyRef.current = true; setBusy(true);
    const requestKey = sessionKey.current;
    const history = atlasMessages(messageRef.current);
    append(newMessage("user", question));
    try {
      const response = await fetch("/api/atlas/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: question, history, context: contextFor(activeContext, accountRef.current) }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || typeof data?.reply !== "string" || !data.reply.trim()) {
        throw new Error(response.status === 401 ? "Your session has ended. Sign in again to talk to Atlas." : response.status === 402 ? "You need a credit for this AI answer. Tool help is free; you can also use the signal actions below." : data?.reason || "Atlas could not finish that answer. Your conversation and signals are still here.");
      }
      if (!mounted.current || requestKey !== sessionKey.current) return;
      append(newMessage("assistant", data.reply, { actions: normalizeAtlasActions(data.actions) }));
      window.dispatchEvent(new Event("credits-updated"));
    } catch (err) {
      if (mounted.current && requestKey === sessionKey.current) { setError(err instanceof Error ? err.message : "Atlas could not respond. Please try again."); setInput(question); }
    } finally { if (requestKey === sessionKey.current) { busyRef.current = false; if (mounted.current) setBusy(false); } }
  }, [append, configured]);
  const askRef = useRef(ask); askRef.current = ask;

  const prepare = useCallback((action: AtlasAction) => {
    const content = action.type === "plays" ? "Let’s build an OM AI Play. Choose the market and style below." : action.type === "genx" ? "I can run GENX on gold right here. Choose the horizon for your read." : action.type === "pulse" ? "Start with a market scan. Then we can turn a candidate into a full play." : "Here’s the workspace you asked for.";
    append(newMessage("assistant", content, { actions: [action] }));
  }, [append]);

  useEffect(() => {
    const receive = (event: Event) => {
      if (!configured) return;
      const request = (event as CustomEvent<AtlasOpenRequest>).detail ?? {};
      if (!openRef.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true); setError("");
      if (request.context) setContext(request.context);
      const action = actionFromOpen(request);
      if (action) prepare(action);
      else if (request.question?.trim()) void askRef.current(request.question, request.context);
      // This callback runs on the original button tap, preserving Safari's audio gesture.
      if (request.voice) startVoice(request.context);
    };
    window.addEventListener(ATLAS_OPEN_EVENT, receive);
    return () => window.removeEventListener(ATLAS_OPEN_EVENT, receive);
  }, [configured, prepare, startVoice]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) {
      if (!element.open) element.showModal();
      document.documentElement.classList.add("om-atlas-open");
      element.focus({ preventScroll: true });
    } else {
      if (element.open) element.close();
      document.documentElement.classList.remove("om-atlas-open");
      opener.current?.focus({ preventScroll: true });
    }
    return () => { document.documentElement.classList.remove("om-atlas-open"); };
  }, [open]);
  useEffect(() => {
    if (!open || !configured) return;
    let alive = true;
    const refresh = () => void fetch("/api/credits", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => { if (alive && d) setPass(d.pass === true); }).catch(() => {});
    refresh(); window.addEventListener("credits-updated", refresh);
    return () => { alive = false; window.removeEventListener("credits-updated", refresh); };
  }, [open, configured]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => { if (log.current) log.current.scrollTo({ top: log.current.scrollHeight, behavior: "auto" }); });
    return () => cancelAnimationFrame(frame);
  }, [messages.length, busy, working, open]);
  useEffect(() => {
    if (open && voiceAttempted && (voice.needsSubscription || voice.status === "locked")) setVoiceSettings(true);
  }, [open, voiceAttempted, voice.needsSubscription, voice.status]);

  const onVoiceTurns = useCallback((turns: VoiceTurn[]) => {
    if (!mounted.current || !turns.length) return;
    setMessages((previous) => {
      const next = [...previous];
      for (const turn of turns) {
        if (turn.source === "volunteered" || !turn.text.trim() || turn.at < voiceAfter.current) continue;
        const id = `voice:${turn.id}`;
        const index = next.findIndex((m) => m.id === id);
        const content = turn.cut && turn.spoken ? turn.spoken : turn.text;
        const message: Message = { id, role: turn.who === "you" ? "user" : "assistant", content, at: turn.at, source: "voice" };
        if (index >= 0) next[index] = { ...next[index], content };
        else {
          next.push(message);
          if (turn.who === "you") {
            const actions = planAtlasActions(content, atlasMessages(next.slice(0, -1)));
            if (actions.length) next.push(newMessage("assistant", "Ready here when you are. Review the tool and cost below.", { id: `actions:${turn.id}`, actions }));
          }
        }
      }
      return next.slice(-40);
    });
  }, []);

  const run = useCallback(async (action: AtlasAction, messageId: string, actionIndex: number) => {
    if (workRef.current || action.type === "navigate" || !configured) return;
    workRef.current = true; setWorking(`${messageId}:${actionIndex}`); setError("");
    const requestKey = sessionKey.current;
    const isCurrent = () => requestKey === sessionKey.current;
    try {
      if (action.type === "pulse") {
        const pulse = await scanWithAtlas(isCurrent);
        if (!mounted.current || !isCurrent()) return;
        append(newMessage("assistant", pulse.setups.length ? "The scan is ready. Pick a market below to build its full play." : "The scan finished without a qualifying candidate.", { pulse }));
        setContext({ source: "Market Pulse", label: "Latest market scan", data: pulse });
      } else {
        if (action.type === "plays" && !action.td) throw new Error("Choose a market for this play first.");
        const signal = await generateAtlasSignal(action.type === "plays" ? { tool: "plays", td: action.td!, style: action.style } : { tool: "genx", mode: action.mode }, undefined, isCurrent);
        if (!mounted.current || !isCurrent()) return;
        append(newMessage("assistant", "Your read is ready. The engine’s decision and levels are below.", { signal }));
        setContext(atlasSignalContext(signal));
      }
      setMessages((previous) => previous.map((m) => m.id === messageId ? { ...m, completed: [...(m.completed ?? []), actionIndex] } : m));
    } catch (err) {
      if (mounted.current && isCurrent()) setError(err instanceof Error ? err.message : "This read could not finish. Check your saved results before trying again.");
    } finally { if (isCurrent()) { workRef.current = false; if (mounted.current) setWorking(null); } }
  }, [append, configured]);

  const navigate = useCallback((destination: AtlasDestination) => {
    close();
    if (destination === "command-center") window.location.assign(ATLAS_LINKS[destination].href);
    else router.push(ATLAS_LINKS[destination].href);
  }, [close, router]);
  const explain = useCallback((question: string, view: ViewContext) => { void askRef.current(question, view); }, []);
  const stateLabel = voice.activity === "connecting" ? "Connecting voice…" : voice.activity === "awaiting_mic" ? "Allow your microphone to talk" : voice.activity === "user_speaking" ? "Listening to you…" : voice.activity === "thinking" ? "Atlas is thinking…" : voice.activity === "speaking" ? "Atlas is speaking" : onLine ? voice.micMuted ? "Microphone muted" : "Voice is on · go ahead" : voiceAttempted && voice.status === "error" ? "Voice needs attention" : "Your AI trading assistant";
  const hasResult = messages.some((message) => !!message.signal);

  return <PanelContext.Provider value={{ open }}>
    {children}
    {configured && <>
      {!open && working && <button type="button" className="om-atlas-background" onClick={() => setOpen(true)}><Loader2 className="animate-spin" aria-hidden="true" />Atlas is reading the market<ChevronDown aria-hidden="true" /></button>}
      <dialog ref={dialog} className="om-atlas-dialog" aria-labelledby="om-atlas-title" tabIndex={-1} onCancel={(e) => { e.preventDefault(); close(); }} onClose={() => { if (openRef.current) close(); }} onClick={(e) => { if (e.target === dialog.current) { const r = dialog.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(); } }}>
        <header className="om-atlas-top">
          <ProductIcon kind="atlas" size="md" />
          <div><h2 id="om-atlas-title">Atlas</h2><p role="status">{stateLabel}</p></div>
          <button type="button" className="om-atlas-icon" aria-label="New Atlas conversation" title="New conversation" disabled={busy || !!working} onClick={() => { voiceAfter.current = Date.now(); appVoiceBus.end(); setMessages([]); setContext(null); setError(""); setInput(""); }}><SquarePen aria-hidden="true" /></button>
          <button type="button" className="om-atlas-icon" aria-label="Close Atlas" onClick={close}><X aria-hidden="true" /></button>
        </header>
        <div className="om-atlas-journey" aria-label="Signal workflow"><span className={hasResult ? "" : "is-current"}><i>1</i>Discover</span><span className={hasResult ? "is-current" : ""}><i>2</i>Review the signal</span><span><i>3</i>Execute with FLOW</span></div>
        <div className="om-atlas-log" ref={log}>
          {messages.length === 0 && <section className="om-atlas-welcome">
            <p className="om-atlas-eyebrow">One conversation. Your trading tools.</p>
            <h3>Let’s find your next setup.</h3>
            <p>Talk to me about a market, generate a play, or read gold with GENX. We’ll keep the signal and its next steps right here.</p>
            <div className="om-atlas-starts">
              <button type="button" onClick={() => prepare({ type: "plays" })}><Sparkles aria-hidden="true" /><span><strong>Find a trade signal</strong><small>OM AI Plays · choose your market</small></span><ArrowUpRight aria-hidden="true" /></button>
              <button type="button" onClick={() => prepare({ type: "genx" })}><Layers3 aria-hidden="true" /><span><strong>Analyze gold</strong><small>GENX · the gold engine</small></span><ArrowUpRight aria-hidden="true" /></button>
              <button type="button" onClick={() => prepare({ type: "pulse" })}><Activity aria-hidden="true" /><span><strong>Find a market to watch</strong><small>Pulse · scan the opportunities</small></span><ArrowUpRight aria-hidden="true" /></button>
            </div>
            <button type="button" className="om-atlas-starter-question" onClick={() => void ask("What is happening with gold right now?")}><MessageCircle aria-hidden="true" />What’s happening with gold?</button>
          </section>}
          <div className="om-atlas-messages" role="log" aria-label="Conversation with Atlas" aria-live="polite" aria-relevant="additions text">
            {messages.map((message) => <div className={`om-atlas-message is-${message.role}`} key={message.id}>
              <span className="om-atlas-message-who">{message.role === "user" ? "You" : "Atlas"}{message.source === "voice" ? " · voice" : ""}</span>
              {message.content && <p className="om-atlas-message-text">{message.content}</p>}
              {message.actions?.map((action, index) => <AtlasActionCard key={`${message.id}:${index}`} action={action} busy={working === `${message.id}:${index}`} disabled={!!working} completed={message.completed?.includes(index) ?? false} pass={pass} onRun={(chosen) => void run(chosen, message.id, index)} onNavigate={navigate} />)}
              {message.signal && <AtlasSignalCard signal={message.signal} onAsk={explain} />}
              {message.pulse && <AtlasPulseCard result={message.pulse} onPlay={(td) => prepare({ type: "plays", td, style: "intraday" })} onNavigate={() => navigate("pulse")} />}
            </div>)}
            {busy && <div className="om-atlas-thinking" role="status"><Loader2 className="animate-spin" aria-hidden="true" />Atlas is reading your question…</div>}
            {working && <div className="om-atlas-thinking" role="status"><Loader2 className="animate-spin" aria-hidden="true" />Reading real market data. Your result will appear here.</div>}
          </div>
          {voice.partial && <p className="om-atlas-partial" aria-live="polite">{voice.partial}</p>}
          {error && <div className="om-atlas-error" role="alert"><p>{error}</p>{/credit|balance|FLOW Pass/i.test(error) && <button type="button" onClick={() => navigate("credits")}>Check credits<ArrowUpRight aria-hidden="true" /></button>}</div>}
          {voiceAttempted && voice.error && <p className="om-atlas-error" role="alert">{voice.error}</p>}
          {/* The transport is mounted before the first tap. Its existing plan/settings surface is available in place. */}
          <div className="om-atlas-voice-settings" hidden={!voiceSettings}><VoiceSession surface="app" context={contextFor(context, account)} onTurns={onVoiceTurns} /></div>
        </div>
        <div className="om-atlas-compose">
          {context && <div className="om-atlas-context"><span><b>{context.source}</b> · {context.label}</span><button type="button" aria-label="Stop discussing this result" onClick={() => setContext(null)}><X aria-hidden="true" /></button></div>}
          {onLine && <div className="om-atlas-voice-controls" aria-label="Atlas voice controls">
            <span className="om-atlas-listening" data-speaking={voice.activity === "speaking"}><i /><i /><i /><i /><i /></span>
            <button type="button" onClick={() => appVoiceBus.setMicMuted(!voice.micMuted)} aria-label={voice.micMuted ? "Unmute microphone" : "Mute microphone"}>{voice.micMuted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}</button>
            <button type="button" onClick={() => appVoiceBus.setSpeakerMuted(!voice.speakerMuted)} aria-label={voice.speakerMuted ? "Unmute Atlas" : "Mute Atlas"}>{voice.speakerMuted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}</button>
            <button type="button" onClick={() => appVoiceBus.end()}><PhoneOff aria-hidden="true" /><span>End voice</span></button>
          </div>}
          <form onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
            {!onLine && <button type="button" className="om-atlas-mic" aria-label="Talk to Atlas" title="Talk to Atlas" onClick={() => startVoice()}><Mic aria-hidden="true" /></button>}
            <textarea aria-label="Message Atlas" placeholder={onLine ? "Or type to Atlas…" : "Ask Atlas or name a market…"} value={input} maxLength={3000} rows={1} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(input); } }} />
            <button type="submit" className="om-atlas-send" aria-label="Send to Atlas" disabled={!input.trim() || busy}>{busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}</button>
          </form>
          <div className="om-atlas-compose-meta"><span>Tool help is free · AI answers 1 credit · Voice uses your plan</span><button type="button" aria-label="Voice settings and plan" aria-expanded={voiceSettings} onClick={() => setVoiceSettings((v) => !v)}><Settings2 aria-hidden="true" /></button></div>
          {messages.length > 0 && <div className="om-atlas-quick-tools" aria-label="Use a tool with Atlas"><button type="button" disabled={!!working} onClick={() => prepare({ type: "plays" })}><Sparkles aria-hidden="true" />New play</button><button type="button" disabled={!!working} onClick={() => prepare({ type: "genx" })}><Layers3 aria-hidden="true" />GENX</button><button type="button" disabled={!!working} onClick={() => prepare({ type: "pulse" })}><Activity aria-hidden="true" />Scan</button><button type="button" disabled={!!working} onClick={() => navigate("command-center")}>Gold desk<ArrowUpRight aria-hidden="true" /></button></div>}
        </div>
      </dialog>
    </>}
  </PanelContext.Provider>;
}

function sessionStorageSafe(key: string): string | null { try { return sessionStorage.getItem(key); } catch { return null; } }
