"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, ArrowUp, Plus, LineChart, Waves, Target, CalendarClock, ShieldCheck, MessageSquareQuote, Users, Repeat, CalendarDays, Send, ImagePlus, X, Paperclip } from "lucide-react";
import { earnMission } from "@/lib/earnMission";
import { CREDIT_COST } from "@/lib/creditConfig";

type Mode = "trading" | "business";
type Msg = { role: "user" | "assistant"; content: string; images?: string[]; attached?: boolean };

const KEY = (m: Mode) => `om_ai_chat_${m}`;
const MAX_ATTACH = 4;

// Downscale + re-encode an image on the client so payloads stay small and
// within Anthropic/Vercel limits. Everything becomes JPEG (fine for charts).
function downscaleImage(file: File, max = 1568, quality = 0.85): Promise<string | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) { resolve(null); return; }
    const fr = new FileReader();
    fr.onerror = () => resolve(null);
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(null);
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, max / Math.max(width, height));
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(typeof fr.result === "string" ? fr.result : null); return; }
        ctx.drawImage(img, 0, 0, width, height);
        try { resolve(canvas.toDataURL("image/jpeg", quality)); } catch { resolve(null); }
      };
      img.src = fr.result as string;
    };
    fr.readAsDataURL(file);
  });
}

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
// Inline formatting inside a single line: bold, italic, inline code.
function inlineRich(s: string) {
  let t = escapeHtml(s);
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/`([^`]+?)`/g, '<code class="rounded bg-white/10 px-1 py-0.5 text-[0.85em]">$1</code>');
  return t;
}
// Block-level markdown → HTML, line by line, so headings, lists, rules and
// paragraphs render cleanly (no literal "##" or stray line breaks).
function renderRich(text: string) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let lastSpacer = true; // suppress a leading spacer
  const pushSpacer = () => { if (!lastSpacer) { out.push('<div class="h-2"></div>'); lastSpacer = true; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { pushSpacer(); continue; }
    lastSpacer = false;

    let m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) {
      const lvl = m[1].length;
      const cls = lvl === 1
        ? "mb-1 mt-1 font-serif text-base font-bold text-white"
        : lvl === 2
        ? "mb-0.5 mt-1 text-sm font-bold text-gold-light"
        : "mb-0.5 mt-1 text-[12px] font-semibold uppercase tracking-[0.1em] text-white/60";
      out.push(`<div class="${cls}">${inlineRich(m[2])}</div>`);
      continue;
    }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) { out.push('<div class="my-2 border-t border-white/10"></div>'); continue; }
    m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) { out.push(`<div class="flex gap-2"><span class="mt-px text-gold-light">•</span><span>${inlineRich(m[1])}</span></div>`); continue; }
    m = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (m) { out.push(`<div class="flex gap-2"><span class="tabular-nums text-gold-light">${m[1]}.</span><span>${inlineRich(m[2])}</span></div>`); continue; }
    out.push(`<div>${inlineRich(line)}</div>`);
  }
  return out.join("");
}

export function OmAiChat() {
  const [mode, setMode] = useState<Mode>("trading");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attaching, setAttaching] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    try {
      // Don't store heavy base64 images in localStorage (quota) — keep a flag
      // so the bubble can still show an "attached" marker on reload.
      const light = next.map((m) => (m.images && m.images.length ? { role: m.role, content: m.content, attached: true } : m));
      localStorage.setItem(KEY(mode), JSON.stringify(light.slice(-40)));
    } catch { /* ignore */ }
  }

  async function onFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setAttaching(true);
    try {
      const room = MAX_ATTACH - attachments.length;
      const files = Array.from(list).filter((f) => f.type.startsWith("image/")).slice(0, Math.max(0, room));
      const out: string[] = [];
      for (const f of files) {
        if (f.size > 25 * 1024 * 1024) continue; // skip absurdly large sources
        const d = await downscaleImage(f);
        if (d) out.push(d);
      }
      if (out.length) setAttachments((prev) => [...prev, ...out].slice(0, MAX_ATTACH));
    } finally {
      setAttaching(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function send(text: string) {
    const clean = text.trim();
    const imgs = attachments;
    if ((!clean && imgs.length === 0) || streaming) return;
    const userMsg: Msg = imgs.length ? { role: "user", content: clean, images: imgs } : { role: "user", content: clean };
    const base: Msg[] = [...messages, userMsg];
    setMessages([...base, { role: "assistant", content: "" }]);
    setInput("");
    setAttachments([]);
    setStreaming(true);
    // Auto-earn the daily "ask OM AI" mission for the active side.
    void earnMission(mode === "business" ? "coach" : "omai");

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
            : (res.status === 402 || j.error === "insufficient_credits")
              ? "You're out of credits — each message costs 1. Your free credits reset weekly, or you can top up on the Credits page (Portal → Credits)."
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
      if (typeof window !== "undefined") window.dispatchEvent(new Event("credits-updated"));
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
                {m.role === "user" ? (
                  <div className="flex max-w-[85%] flex-col items-end gap-1.5">
                    {m.images && m.images.length > 0 && (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {m.images.map((src, k) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={k} src={src} alt="Attached chart" className="h-32 w-32 rounded-xl object-cover ring-1 ring-white/15" />
                        ))}
                      </div>
                    )}
                    {!m.images && m.attached && (
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 py-1 text-[11px] text-white/50 ring-1 ring-white/10">
                        <Paperclip className="h-3 w-3" /> Image attached
                      </span>
                    )}
                    {m.content && (
                      <div className="rounded-2xl rounded-tr-sm bg-gold-light px-4 py-2.5 text-sm font-medium text-[#0a0b10]">{m.content}</div>
                    )}
                  </div>
                ) : (
                  <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-white/[0.05] px-4 py-3 text-sm leading-relaxed text-white/90 ring-1 ring-white/10">
                    {m.content
                      ? <div dangerouslySetInnerHTML={{ __html: renderRich(m.content) }} />
                      : <span className="inline-flex gap-1"><Dot /><Dot d={150} /><Dot d={300} /></span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* input */}
      <div className="relative z-10 border-t border-white/10 px-4 py-4 sm:px-8">
        <div className="mx-auto max-w-3xl">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((src, k) => (
                <div key={k} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="Attachment preview" className="h-16 w-16 rounded-lg object-cover ring-1 ring-white/15" />
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== k))}
                    aria-label="Remove attachment"
                    className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/80 text-white ring-1 ring-white/20 hover:bg-black"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => { e.preventDefault(); send(input); }}
            className="flex items-end gap-2 rounded-2xl border border-white/12 bg-white/[0.04] px-3 py-2 focus-within:border-gold-light/40"
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={attaching || attachments.length >= MAX_ATTACH}
              aria-label="Attach an image"
              title={attachments.length >= MAX_ATTACH ? `Up to ${MAX_ATTACH} images` : "Attach a chart or screenshot"}
              className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl border border-white/12 text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
            >
              {attaching ? <Send className="h-4 w-4 animate-pulse" /> : <ImagePlus className="h-4 w-4" />}
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
              rows={1}
              placeholder={mode === "business" ? "Ask about scripts, objections, content, growth…" : "Ask, or attach a chart to analyze…"}
              className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none"
            />
            <button
              type="submit"
              disabled={streaming || (!input.trim() && attachments.length === 0)}
              aria-label="Send"
              className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-gradient-to-br from-gold-light to-[#8a6d35] text-[#0a0b10] transition-opacity disabled:opacity-40"
            >
              {streaming ? <Send className="h-4 w-4 animate-pulse" /> : <ArrowUp className="h-4 w-4" />}
            </button>
          </form>
        </div>
        <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-white/30">
          {mode === "business"
            ? "OM AI is a coaching tool — not a guarantee of results. Follow ConeqtX policies."
            : "OM AI gives educational analysis, not financial advice. No live prices — verify before trading."}
          <span className="text-white/40"> · {CREDIT_COST.chat} credit per message</span>
        </p>
      </div>
    </div>
  );
}

function Dot({ d = 0 }: { d?: number }) {
  return <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/50" style={{ animationDelay: `${d}ms` }} />;
}
