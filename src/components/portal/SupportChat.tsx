"use client";

/**
 * SUPPORT CHAT — the member's view (owner 09-24).
 *
 * Deliberately a conversation, not a ticket form. The two things that make people message twice are
 * not knowing whether it arrived and not knowing whether anyone is coming, so the thread shows their
 * own words back immediately and says plainly what happens next.
 *
 * Drafts are invisible here by construction — RLS filters them at the database, so this component
 * could not render one even if it tried.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Send, Loader2, Check } from "lucide-react";

type Msg = { id: string; role: "member" | "staff"; body: string; created_at: string };
type Thread = { id: string; status: string; last_staff_at: string | null } | null;

function when(iso: string) {
  const d = new Date(iso), now = Date.now();
  const mins = Math.round((now - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SupportChat() {
  const [thread, setThread] = useState<Thread>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/support/thread", { cache: "no-store" });
      const d = await r.json();
      if (d?.ok) { setThread(d.thread ?? null); setMsgs((d.messages ?? []) as Msg[]); }
    } catch { /* keep what's on screen */ }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => { void load(); const id = setInterval(load, 20_000); return () => clearInterval(id); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [msgs.length]);

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setErr("");
    // Show it straight away — waiting on a round-trip is what makes people hit send twice.
    const optimistic: Msg = { id: `tmp-${Date.now()}`, role: "member", body, created_at: new Date().toISOString() };
    setMsgs((m) => [...m, optimistic]); setText("");
    try {
      const r = await fetch("/api/support/thread", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }),
      });
      const d = await r.json();
      if (d?.error === "slow_down") setErr(d.detail || "Give us a moment.");
      else if (d?.error) setErr("That didn't send — try again in a moment.");
      await load();
    } catch {
      setErr("That didn't send — check your connection.");
    }
    setBusy(false);
  }

  return (
    <section className="rounded-2xl border border-[#E7E4DD] bg-white p-5 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-bold text-navy">
          <MessageCircle className="h-4 w-4 text-primary" aria-hidden="true" /> Support
        </h2>
        {thread?.status === "answered" && (
          <span className="rounded-full bg-navy/[0.06] px-3 py-1 text-[11px] font-bold text-navy">Replied</span>
        )}
      </div>

      <p className="mt-1 text-[12px] text-charcoal/55">
        Message us about your account, your credits, or a trade. We read every one.
      </p>

      <div className="mt-4 max-h-[340px] space-y-2 overflow-y-auto pr-1">
        {!loaded && <p className="text-[12px] text-charcoal/40">Loading…</p>}
        {loaded && msgs.length === 0 && (
          <p className="rounded-xl bg-offwhite/70 px-3 py-3 text-[12.5px] text-charcoal/60">
            Nothing here yet. Tell us what&rsquo;s going on and we&rsquo;ll take a look at your account.
          </p>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={m.role === "member" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-snug ${
                m.role === "member" ? "bg-navy text-white" : "bg-offwhite text-charcoal"
              }`}
            >
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
              <p className={`mt-1 text-[10px] ${m.role === "member" ? "text-white/45" : "text-charcoal/40"}`}>
                {m.role === "member" ? "You" : "1 Mission"} · {when(m.created_at)}
              </p>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {msgs.length > 0 && thread?.status === "open" && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-charcoal/45">
          <Check className="h-3 w-3" /> Received — we&rsquo;ll come back to you here.
        </p>
      )}

      <div className="mt-3 flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }}
          rows={2}
          maxLength={4000}
          placeholder="What's going on?"
          className="min-h-[46px] flex-1 resize-y rounded-xl border border-[#E7E4DD] bg-offwhite/40 px-3 py-2 text-[13px] text-charcoal outline-none focus:border-primary/50"
        />
        <button
          onClick={() => void send()}
          disabled={busy || !text.trim()}
          className="inline-flex h-[46px] items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-cream transition-colors hover:bg-navy disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send
        </button>
      </div>
      {err && <p className="mt-2 text-[11.5px] text-amber-700">{err}</p>}
    </section>
  );
}
