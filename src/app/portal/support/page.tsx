"use client";

import { useEffect, useRef, useState } from "react";
import { LifeBuoy, ArrowUp, Mail, Send, Plus } from "lucide-react";

const SUPPORT_EMAIL = "support@onemissioncollection.com";
const STORE_KEY = "w1m_support_chat";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTED = [
  "How do credits work?",
  "How do I buy more credits?",
  "How do I log in / reset my password?",
  "Where do I see what I've purchased?",
];

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineRich(s: string) {
  let t = escapeHtml(s);
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/`([^`]+?)`/g, '<code class="rounded bg-navy/5 px-1 py-0.5 text-[0.85em]">$1</code>');
  return t;
}
function renderRich(text: string) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { out.push('<div class="h-2"></div>'); continue; }
    let m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m) { out.push(`<div class="flex gap-2"><span class="mt-px text-primary">•</span><span>${inlineRich(m[1])}</span></div>`); continue; }
    m = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (m) { out.push(`<div class="flex gap-2"><span class="tabular-nums text-primary">${m[1]}.</span><span>${inlineRich(m[2])}</span></div>`); continue; }
    out.push(`<div>${inlineRich(line)}</div>`);
  }
  return out.join("");
}

export default function SupportPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      setMessages(raw ? JSON.parse(raw) : []);
    } catch { setMessages([]); }
    setLoaded(true);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function persist(next: Msg[]) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next.slice(-40))); } catch { /* ignore */ }
  }

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || busy) return;
    const base: Msg[] = [...messages, { role: "user", content: clean }];
    setMessages([...base, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);

    const finalize = (content: string) => {
      setMessages(() => {
        const done: Msg[] = [...base, { role: "assistant", content }];
        persist(done);
        return done;
      });
    };

    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: base }),
      });
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j = await res.json().catch(() => ({}));
        finalize(
          j.notConfigured
            ? `Support AI isn't switched on yet. In the meantime, email us at ${SUPPORT_EMAIL} and we'll help you out.`
            : `I hit a snag. Please try again, or email ${SUPPORT_EMAIL} and we'll help directly.`
        );
        return;
      }
      if (!res.body) { finalize(`No response received. Please email ${SUPPORT_EMAIL}.`); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        setMessages([...base, { role: "assistant", content: acc }]);
      }
      finalize(acc || "…");
    } catch {
      finalize(`Something interrupted the connection. Please try again, or email ${SUPPORT_EMAIL}.`);
    } finally {
      setBusy(false);
    }
  }

  function newChat() {
    setMessages([]);
    persist([]);
  }

  const empty = loaded && messages.length === 0;
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("weare1mission support request")}`;

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <p className="eyebrow">Help</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <LifeBuoy className="h-7 w-7 text-primary" aria-hidden="true" /> Support
        </h1>
        <p className="mt-2 text-charcoal/70">
          Ask our AI assistant anything about your account, credits, or the tools. Need a human? Email us anytime.
        </p>
      </header>

      {/* Email a human */}
      <div className="flex flex-col gap-3 rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-bold text-navy">Prefer to email?</h2>
          <p className="text-sm text-charcoal/60">
            Reach the team at {SUPPORT_EMAIL}. Include your member ID and a short description.
          </p>
        </div>
        <a
          href={mailto}
          className="inline-flex flex-shrink-0 items-center justify-center gap-2 rounded-full bg-gradient-primary px-5 py-2.5 text-sm font-semibold text-cream shadow-card transition-transform hover:-translate-y-0.5"
        >
          <Mail className="h-4 w-4" aria-hidden="true" /> Email support
        </a>
      </div>

      {/* AI chat */}
      <div className="flex h-[calc(100vh-360px)] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
        <div className="flex items-center justify-between border-b border-[#E4DCCB] px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-primary">
              <LifeBuoy className="h-4 w-4 text-cream" aria-hidden="true" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-bold text-navy">Support Assistant</p>
              <p className="text-[11px] uppercase tracking-[0.12em] text-emerald-700">Free · no credits</p>
            </div>
          </div>
          <button
            onClick={newChat}
            className="inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] px-3 py-1.5 text-[11px] font-semibold text-charcoal/70 transition-colors hover:bg-ice"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New chat
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {empty ? (
            <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center text-center">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10">
                <LifeBuoy className="h-6 w-6 text-primary" aria-hidden="true" />
              </span>
              <h2 className="mt-4 text-lg font-bold text-navy">How can we help?</h2>
              <p className="mt-1 max-w-sm text-sm text-charcoal/60">
                Ask about credits, login, purchases, or how any of the tools work.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SUGGESTED.map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    className="rounded-full border border-[#E4DCCB] bg-offwhite/60 px-3.5 py-2 text-xs font-medium text-charcoal/75 transition-colors hover:border-primary/40 hover:text-navy"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-4">
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex gap-2.5"}>
                  {m.role === "assistant" && (
                    <span className="mt-0.5 grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-gradient-primary">
                      <LifeBuoy className="h-3.5 w-3.5 text-cream" aria-hidden="true" />
                    </span>
                  )}
                  {m.role === "user" ? (
                    <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm font-medium text-cream">
                      {m.content}
                    </div>
                  ) : (
                    <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-[#E4DCCB] bg-offwhite/70 px-4 py-3 text-sm leading-relaxed text-charcoal/90">
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

        <div className="border-t border-[#E4DCCB] px-4 py-3 sm:px-6">
          <form
            onSubmit={(e) => { e.preventDefault(); send(input); }}
            className="mx-auto flex max-w-2xl items-end gap-2 rounded-2xl border border-[#E4DCCB] bg-offwhite/60 px-3 py-2 focus-within:border-primary/50"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
              rows={1}
              placeholder="Ask a question…"
              className="max-h-32 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-navy placeholder:text-charcoal/35 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label="Send"
              className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-gradient-primary text-cream transition-opacity disabled:opacity-40"
            >
              {busy ? <Send className="h-4 w-4 animate-pulse" /> : <ArrowUp className="h-4 w-4" />}
            </button>
          </form>
          <p className="mx-auto mt-2 max-w-2xl text-center text-[11px] text-charcoal/45">
            Support AI gives general help, not financial advice. For account-specific or billing issues, email {SUPPORT_EMAIL}.
          </p>
        </div>
      </div>
    </div>
  );
}

function Dot({ d = 0 }: { d?: number }) {
  return <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-charcoal/40" style={{ animationDelay: `${d}ms` }} />;
}
