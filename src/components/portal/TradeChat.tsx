"use client";

import { useRef, useState } from "react";
import { MessageCircle, Send, Loader2, ChevronDown, Sparkles } from "lucide-react";

/**
 * TradeChat — a live conversation with the AI about ONE specific open trade,
 * embedded in the signal card. Each question re-reads the live market for the
 * instrument and the AI coaches like a professional (breakeven, partials, hold
 * vs close, invalidation…). Persisted per trade; 1 credit per question.
 */
export type TradeContext = {
  td: string;
  symbol: string;
  style?: string;
  interval?: string;
  direction: string;               // LONG/SHORT or buy/sell
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  since?: string;                  // ISO issue time, scopes "since entry" reads
};

type Msg = { role: "user" | "assistant"; content: string };
type Snap = { r_now?: number; side?: string; price?: number; to_stop_pips?: number; next_target_label?: string; to_next_target_pips?: number };

const QUICK = [
  "Should I move my stop to breakeven?",
  "Is my trade still valid or is it invalidated?",
  "What is price doing right now?",
  "Should I take partial profit here?",
  "Should I hold or close this trade?",
];

export function TradeChat({ trade, creditCost = 1 }: { trade: TradeContext; creditCost?: number }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [needCredits, setNeedCredits] = useState(false);
  const [snap, setSnap] = useState<Snap | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const valid = trade && Number.isFinite(trade.entry) && Number.isFinite(trade.stopLoss) && (trade.takeProfits || []).some((n) => Number.isFinite(n));
  if (!valid) return null;

  const body = () => ({
    td: trade.td, symbol: trade.symbol, style: trade.style, interval: trade.interval,
    direction: trade.direction, entry: trade.entry, stopLoss: trade.stopLoss,
    takeProfits: (trade.takeProfits || []).filter((n) => Number.isFinite(n)), since: trade.since,
  });

  async function openPanel() {
    setOpen((v) => !v);
    if (loaded || open) return;
    setLoaded(true);
    try {
      const res = await fetch("/api/trade-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "load", ...body() }) });
      const d = await res.json();
      if (res.ok && Array.isArray(d.messages)) setMsgs(d.messages);
    } catch { /* silent — history is best-effort */ }
  }

  async function scrollDown() {
    requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });
  }

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setErr(""); setNeedCredits(false); setBusy(true); setInput("");
    setMsgs((m) => [...m, { role: "user", content: question }]);
    scrollDown();
    try {
      const res = await fetch("/api/trade-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ask", question, ...body() }) });
      const d = await res.json();
      if (res.status === 402 || d.error === "insufficient_credits") { setNeedCredits(true); }
      else if (!res.ok || d.error) { setErr(d.reason || "Couldn't reach the coach right now. Try again in a moment."); }
      else { setMsgs((m) => [...m, { role: "assistant", content: d.reply }]); if (d.snapshot) setSnap(d.snapshot); }
    } catch { setErr("Couldn't reach the server. Try again."); }
    finally { setBusy(false); scrollDown(); }
  }

  return (
    <div className="mt-4 rounded-xl border border-sky-400/20 bg-sky-400/[0.04]">
      <button onClick={openPanel} className="flex w-full items-center justify-between px-3.5 py-2.5 text-left">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-sky-200">
          <MessageCircle className="h-4 w-4 text-sky-300" /> Ask the AI about this trade
        </span>
        <ChevronDown className={`h-4 w-4 text-white/40 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-white/10 p-3">
          {snap && typeof snap.r_now === "number" && (
            <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white/[0.03] px-3 py-1.5 text-[11px] text-white/60">
              <span>Now: <span className={`font-semibold ${snap.side === "profit" ? "text-emerald-400" : snap.side === "drawdown" ? "text-red-400" : "text-white/70"}`}>{snap.r_now > 0 ? "+" : ""}{snap.r_now}R</span></span>
              {snap.price != null && <span>Price <span className="font-semibold text-white/80">{snap.price}</span></span>}
              {snap.to_stop_pips != null && <span>Stop ~{snap.to_stop_pips} pips</span>}
              {snap.next_target_label && snap.to_next_target_pips != null && <span>{snap.next_target_label} ~{snap.to_next_target_pips} pips</span>}
            </div>
          )}

          <div ref={scrollRef} className="max-h-72 space-y-2.5 overflow-y-auto pr-1">
            {msgs.length === 0 && (
              <p className="px-1 py-2 text-[12px] leading-relaxed text-white/45">
                Ask anything about managing this trade — the AI checks the live market for {trade.symbol} and answers like a pro. Try a question below, or type your own.
              </p>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed ${m.role === "user" ? "bg-sky-500/20 text-white" : "border border-white/10 bg-white/[0.04] text-white/85"}`}>
                  {m.content}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-[13px] text-white/50">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> reading the live market…
                </div>
              </div>
            )}
          </div>

          {msgs.length === 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {QUICK.map((q) => (
                <button key={q} onClick={() => ask(q)} disabled={busy} className="rounded-full border border-white/12 bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/60 transition-colors hover:border-sky-400/40 hover:text-white/85 disabled:opacity-40">
                  {q}
                </button>
              ))}
            </div>
          )}

          {needCredits && <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-amber-300">You&apos;re out of credits — they reset weekly, or grab more from the Credits page.</p>}
          {err && <p className="mt-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300">{err}</p>}

          <div className="mt-2.5 flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); } }}
              rows={1}
              placeholder="Ask about this trade…"
              className="max-h-28 min-h-[40px] flex-1 resize-none rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] text-white placeholder:text-white/30 outline-none focus:border-sky-400/50"
            />
            <button onClick={() => ask(input)} disabled={busy || !input.trim()} className="inline-flex h-[40px] items-center gap-1.5 rounded-xl bg-sky-500/90 px-3.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
          <p className="mt-1.5 flex items-center gap-1 px-0.5 text-[10px] text-white/35">
            <Sparkles className="h-3 w-3" /> {creditCost} credit per question · live market read · educational, not financial advice
          </p>
        </div>
      )}
    </div>
  );
}
