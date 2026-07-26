"use client";

/**
 * Wins Wall — the community's shared wins feed, in the One Mission palette.
 * Members post a win (a closed trade, a milestone, a rank-up), cheer each
 * other's, and see the room's momentum. Backed by Supabase with RLS.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Trophy, Send, Heart, Trash2, TrendingUp, Flag, Award, Sparkles, AlertTriangle, Check, X,
} from "lucide-react";

type Win = {
  id: string; author: string; kind: string; body: string;
  createdAt: string; cheers: number; cheered: boolean; mine: boolean;
};

const KINDS: { k: string; label: string; icon: typeof TrendingUp }[] = [
  { k: "general", label: "Win", icon: Sparkles },
  { k: "trade", label: "Trade", icon: TrendingUp },
  { k: "milestone", label: "Milestone", icon: Flag },
  { k: "rankup", label: "Rank-up", icon: Award },
];
const kindMeta = (k: string) => KINDS.find((x) => x.k === k) || KINDS[0];

function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const initials = (n: string) => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "M";

export function WinsWall() {
  const [feed, setFeed] = useState<Win[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("general");
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const r = await fetch("/api/wins", { cache: "no-store" });
      const d = await r.json();
      if (d.error === "not_configured") { setMsg("The community feed isn't connected yet."); setFeed([]); return; }
      if (d.error === "load_failed") { setMsg("The Wins Wall table isn't set up yet."); setFeed([]); return; }
      if (d.error) { setMsg("Couldn't load the wall right now — try again shortly."); return; }
      setFeed(Array.isArray(d.feed) ? d.feed : []);
    } catch { setMsg("Couldn't load the wall right now — try again shortly."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function post() {
    const text = body.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      const r = await fetch("/api/wins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: text, kind }) });
      const d = await r.json();
      if (d.win) { setFeed((f) => [d.win, ...f]); setBody(""); setKind("general"); }
      else setMsg("Couldn't post that — try again.");
    } catch { setMsg("Couldn't post that — try again."); }
    finally { setPosting(false); }
  }

  async function cheer(w: Win) {
    // optimistic
    setFeed((f) => f.map((x) => x.id === w.id ? { ...x, cheered: !x.cheered, cheers: x.cheers + (x.cheered ? -1 : 1) } : x));
    try {
      const r = await fetch("/api/wins/react", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ winId: w.id }) });
      const d = await r.json();
      if (typeof d.cheers === "number") setFeed((f) => f.map((x) => x.id === w.id ? { ...x, cheered: d.cheered, cheers: d.cheers } : x));
    } catch { /* keep optimistic */ }
  }

  async function remove(id: string) {
    setFeed((f) => f.filter((x) => x.id !== id));
    try { await fetch(`/api/wins?id=${encodeURIComponent(id)}`, { method: "DELETE" }); } catch { /* ignore */ }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-[#E7E4DD] bg-white shadow-card">
      <div className="flex items-center gap-2.5 border-b border-ice bg-offwhite/50 px-5 py-3.5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-white"><Trophy className="h-4 w-4" /></span>
        <div>
          <h2 className="font-serif text-sm font-semibold uppercase tracking-[0.12em] text-navy">Wins Wall</h2>
          <p className="text-[11px] text-charcoal/45">Share your wins · cheer the room on</p>
        </div>
      </div>

      <div className="p-5">
        {/* Composer */}
        <div className="rounded-2xl border border-ice bg-offwhite/40 p-3.5">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, 500))}
            placeholder="Share a win — a clean trade, a milestone, a breakthrough…"
            rows={2}
            className="w-full resize-none rounded-lg border border-ice bg-white px-3 py-2 text-sm text-charcoal/85 placeholder:text-charcoal/35 focus:border-gold/50 focus:outline-none"
          />
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {KINDS.map((k) => {
                const Icon = k.icon; const on = kind === k.k;
                return (
                  <button key={k.k} onClick={() => setKind(k.k)}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors focus-ring ${on ? "bg-navy text-white" : "bg-white text-charcoal/60 hover:bg-ice"}`}>
                    <Icon className="h-3 w-3" /> {k.label}
                  </button>
                );
              })}
            </div>
            <button onClick={() => void post()} disabled={!body.trim() || posting}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-cream transition-colors hover:bg-navy focus-ring disabled:opacity-40">
              <Send className="h-3.5 w-3.5" /> {posting ? "Posting…" : "Post win"}
            </button>
          </div>
          <p className="mt-1.5 text-right text-[10px] text-charcoal/35">{body.length}/500</p>
        </div>

        {msg && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4" /> {msg}
          </div>
        )}

        {loading && feed.length === 0 && !msg && (
          <div className="mt-4 space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-ice" />)}</div>
        )}

        {!loading && feed.length === 0 && !msg && (
          <p className="mt-6 text-center text-sm text-charcoal/45">No wins yet — be the first to put one on the board.</p>
        )}

        {/* Feed */}
        <ul className="mt-4 space-y-2.5">
          {feed.map((w) => {
            const km = kindMeta(w.kind); const KIcon = km.icon;
            return (
              <li key={w.id} className="rounded-2xl border border-ice bg-white p-3.5">
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-navy text-[11px] font-bold text-white">{initials(w.author)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-navy">{w.author}</span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-gold/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-gold-deep"><KIcon className="h-2.5 w-2.5" /> {km.label}</span>
                      <span className="text-[11px] text-charcoal/40">{timeAgo(w.createdAt)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-charcoal/80">{w.body}</p>
                    <div className="mt-2 flex items-center gap-3">
                      <button onClick={() => void cheer(w)}
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors focus-ring ${w.cheered ? "bg-red-50 text-red-500" : "bg-offwhite text-charcoal/55 hover:bg-ice"}`}>
                        <Heart className={`h-3.5 w-3.5 ${w.cheered ? "fill-red-500" : ""}`} /> {w.cheers > 0 ? w.cheers : ""} Cheer
                      </button>
                      {w.mine && <DeleteBtn onDelete={() => void remove(w.id)} />}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function DeleteBtn({ onDelete }: { onDelete: () => void }) {
  const [confirm, setConfirm] = useState(false);
  if (confirm) return (
    <span className="inline-flex items-center gap-1">
      <button onClick={onDelete} className="grid h-7 w-7 place-items-center rounded-full bg-red-500 text-white hover:bg-red-600 focus-ring"><Check className="h-3.5 w-3.5" /></button>
      <button onClick={() => setConfirm(false)} className="grid h-7 w-7 place-items-center rounded-full bg-ice text-charcoal/60 hover:bg-[#E7E4DD] focus-ring"><X className="h-3.5 w-3.5" /></button>
    </span>
  );
  return (
    <button onClick={() => setConfirm(true)} className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-charcoal/40 transition-colors hover:text-red-500 focus-ring">
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}
