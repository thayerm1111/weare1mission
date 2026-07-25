"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, ArrowUp, Plus, LineChart, Waves, Target, CalendarClock, ShieldCheck, MessageSquareQuote, Users, Repeat, CalendarDays, Send } from "lucide-react";

type Mode = "trading" | "business";
type Msg = { role: "user" | "assistant"; content: string };

const KEY = (m: Mode) => `om_ai_chat_${m}`;

const SPECIALISTS: Record<Mode, { icon: typeof LineChart; label: string; prompt: string }[]> = {
  trading: [
    { icon: LineChart, label: "Market structure", prompt: "Break down how you read market structure — trend, ranges, breaks of structure, and liquidity — with a simple example." },
    { icon: Waves, label: "Volume & order flow", prompt: "Explain how to use volume and order-flow concepts to confirm or fade a move." },
    { icon: Target, label: "Walk a trade idea", prompt: "Walk me through how you'd build a trade idea on a market of your choice — structure, entry logic, invalidation, and risk." },
    { icon: CalendarClock, label: "Plan my session", prompt: "Help me build a pre-session trading plan: what to check, levels to mark, and rules to follow today." },
    { icon: ShieldCheck, label: "Risk check", prompt: "Teach me how to size a position and set a stop with a solid risk-to-reward for a typical setup." },
  ],
  business: [
    { icon: MessageSquareQuote, label: "Invite script", prompt: "Write me a natural, non-salesy invite script to introduce someone to what I do." },
    { icon: ShieldCheck, label: "Handle an objection", prompt: "Someone said 'is this a pyramid scheme?' — coach me on a confident, honest response." },
    { icon: Repeat, label: "Follow-up system", prompt: "Design me a simple follow-up cadence for new prospects so none fall through the cracks." },
    { icon: CalendarDays, label: "Content this week", prompt: "Give me a week of social content ideas that attract the right people without being spammy." },
    { icon: Users, label: "Coach my routine", prompt: "Help me build a daily income-producing-activity routine I can actually stick to." },
  ],
};

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderRich(text: string) {
  let t = escapeHtml(text);
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/`([^`]+?)`/g, '<code class="rounded bg-white/10 px-1 py-0.5 text-[0.85em]">$1</code>');
  t = t.replace(/^\s*[-*]\s+(.*)$/gm, '<span class="flex gap-2"><span class="text-gold-light">•</span><span>$1</span></span>');
  t = t.replace(/\n/g, "<br/>");
  return t;
}

export function OmAiChat() {
  const [mode, setMode] = useState<Mode>("trading");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the portal side toggle: The Ones → trading, The Builders → business.
  useEffect(() => {
    try {
      const s = localStorage.getItem("portal_side");
      if (s === "builders") setMode("business");
    } catch { /* ignore */ }
    const onSide = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d === "ones") setMode("trading");
      else if (d === "builders") setMode("business");
    };
    window.addEventListener("portal-side", onSide as EventListener);
    return () => window.removeEventListener("portal-side", onSide as EventListener);
  }, []);

  // Load this mode's saved conversation (memory persists across sessions on this device).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY(mode));
      setMessages(raw ? JSON.parse(raw) : []);
    } catch { setMessages([]); }
    setLoaded(true);
  }, [mode]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function persist(next: Msg[]) {
    try { localStorage.setItem(KEY(mode), JSON.stringify(next.slice(-40))); } catch { /* ignore */ }
  }

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || streaming) return;
    const base: Msg[] = [...messages, { role: "user", content: clean }];
    setMessages([...base, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);

    const finalize = (content: string) => {
      setMessages(() => {
        const done = [...base, { role: "assistant" as const, content }];
        persist(done);
        return done;
      });
    };

    try {
      const res = await fetch("/api/om-ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: base, mode }),
      });
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j = await res.json().catch(() => ({}));
        finalize(
          j.notConfigured
            ? "OM AI isn't switched on yet — your Anthropic API key needs to be added in Vercel. Once it's in, I'll come alive here."
            : "I hit a snag reaching the engine. Give it another try in a moment."
        );
        return;
      }
      if (!res.body) { finalize("No response received. Try again."); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        const live = acc;
        setMessages([...base, { role: "assistant", content: live }]);
      }
      finalize(acc || "…");
    } catch {
      finalize("Something interrupted the connection. Try again.");
    } finally {
      setStreaming(false);
    }
  }

  function newChat() {
    setMessages([]);
    persist([]);
  }

  const empty = loaded && messages.length === 0;
  const label = mode === "business" ? "Business Co-Pilot" : "Trading Co-Pilot";

  return (
    <div className="relative flex h-[calc(100vh-190px)] min-h-[560px] flex-col overflow-hidden rounded-3xl bg-[#0a0b10] text-white ring-1 ring-white/10">
      {/* ambient glow */}
      <div className="pointer-events-none absolute inset-x-0 -top-24 h-64 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(198,166,103,0.18),transparent)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:40px_40px]" />

      {/* header */}
      <div className="relative z-10 flex items-center justify-between border-b border-white/10 px-5 py-3.5 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="relative grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-gold-light to-[#8a6d35]">
            <Sparkles className="h-4 w-4 text-[#0a0b10]" aria-hidden="true" />
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-emerald-400 ring-2 ring-[#0a0b10]" />
          </span>
          <div className="leading-tight">
            <p className="font-serif text-sm font-semibold uppercase tracking-[0.16em]">OM AI</p>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/40">{label}</p>
          </div>
        </div>
        <button
          onClick={newChat}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-white/80 transition-colors hover:bg-white/10"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New chat
        </button>
      </div>

      {/* messages / empty state */}
      <div ref={scrollRef} className="relative z-10 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        {empty ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-gold-light/25 to-transparent ring-1 ring-gold-light/30">
              <Sparkles className="h-6 w-6 text-gold-light" aria-hidden="true" />
            </span>
            <h1 className="mt-5 font-serif text-3xl font-bold leading-[1.1] sm:text-4xl">
              <span className="bg-gradient-to-r from-white via-gold-light to-white bg-clip-text text-transparent">
                Your AI-Powered<br />{mode === "business" ? "Business" : "Trading"} Co-Pilot
              </span>
            </h1>
            <p className="mt-3 max-w-md text-sm text-white/50">
              {mode === "business"
                ? "Scripts, objection handling, content, and coaching to grow your business. Ask anything — OM AI learns how you build."
                : "Market structure, volume, trade ideas, and session planning across every market. Ask anything — OM AI learns how you trade."}
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-2">
              {SPECIALISTS[mode].map((s) => {
                const Icon = s.icon;
                return (
                  <button
                    key={s.label}
                    onClick={() => send(s.prompt)}
                    className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.03] px-3.5 py-2 text-xs font-medium text-white/80 transition-colors hover:border-gold-light/40 hover:bg-white/[0.07]"
                  >
                    <Icon className="h-3.5 w-3.5 text-gold-light" aria-hidden="true" /> {s.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-5">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex gap-3"}>
                {m.role === "assistant" && (
                  <span className="mt-0.5 grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-gradient-to-br from-gold-light to-[#8a6d35]">
                    <Sparkles className="h-3.5 w-3.5 text-[#0a0b10]" aria-hidden="true" />
                  </span>
                )}
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[85%] rounded-2xl rounded-tr-sm bg-gold-light px-4 py-2.5 text-sm font-medium text-[#0a0b10]"
                      : "max-w-[85%] rounded-2xl rounded-tl-sm bg-white/[0.05] px-4 py-3 text-sm leading-relaxed text-white/90 ring-1 ring-white/10"
                  }
                >
                  {m.role === "assistant"
                    ? (m.content
                        ? <span dangerouslySetInnerHTML={{ __html: renderRich(m.content) }} />
                        : <span className="inline-flex gap-1"><Dot /><Dot d={150} /><Dot d={300} /></span>)
                    : m.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* input */}
      <div className="relative z-10 border-t border-white/10 px-4 py-4 sm:px-8">
        <form
          onSubmit={(e) => { e.preventDefault(); send(input); }}
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-white/12 bg-white/[0.04] px-3 py-2 focus-within:border-gold-light/40"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            rows={1}
            placeholder={mode === "business" ? "Ask about scripts, objections, content, growth…" : "Ask about setups, structure, volume, risk…"}
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none"
          />
          <button
            type="submit"
            disabled={streaming || !input.trim()}
            aria-label="Send"
            className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-gradient-to-br from-gold-light to-[#8a6d35] text-[#0a0b10] transition-opacity disabled:opacity-40"
          >
            {streaming ? <Send className="h-4 w-4 animate-pulse" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </form>
        <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-white/30">
          {mode === "business"
            ? "OM AI is a coaching tool — not a guarantee of results. Follow ConeqtX policies."
            : "OM AI gives educational analysis, not financial advice. No live prices — verify before trading."}
        </p>
      </div>
    </div>
  );
}

function Dot({ d = 0 }: { d?: number }) {
  return <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/50" style={{ animationDelay: `${d}ms` }} />;
}
