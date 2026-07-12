"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Megaphone, Pin, PinOff, Trash2, Plus, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { fmtDateTime } from "@/lib/format";

export interface Update {
  id: string;
  title: string;
  body: string;
  category: string;
  pinned: boolean;
  created_at: string;
}

const CATEGORIES = ["Announcement", "Weekly Focus", "Event", "Win", "Reminder"];

export function MissionUpdatesClient({ updates, isAdmin }: { updates: Update[]; isAdmin: boolean }) {
  const router = useRouter();

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow text-gold">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 font-serif text-4xl font-black tracking-tight text-navy">
          <Megaphone className="h-8 w-8 text-gold" aria-hidden="true" /> Mission Update
        </h1>
        <p className="mt-2 text-charcoal/70">News, announcements, and weekly focus from the leadership team.</p>
      </header>

      {isAdmin && <Composer onPosted={() => router.refresh()} />}

      <div className="space-y-3">
        {updates.length === 0 ? (
          <p className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-6 text-sm text-charcoal/60">No updates posted yet.</p>
        ) : (
          updates.map((u) => <UpdateCard key={u.id} u={u} isAdmin={isAdmin} onChange={() => router.refresh()} />)
        )}
      </div>
    </div>
  );
}

function UpdateCard({ u, isAdmin, onChange }: { u: Update; isAdmin: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  async function act(patch: Record<string, unknown> | "delete") {
    const supabase = createClient();
    if (!supabase) return;
    setBusy(true);
    if (patch === "delete") await supabase.from("team_updates").delete().eq("id", u.id);
    else await supabase.from("team_updates").update(patch).eq("id", u.id);
    setBusy(false);
    onChange();
  }
  return (
    <article className="rounded-2xl border border-[#E4DCCB] bg-cream p-6 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        {u.pinned && <span className="inline-flex items-center gap-1 rounded-full bg-gold/15 px-2.5 py-0.5 text-xs font-semibold text-gold-deep"><Pin className="h-3 w-3" /> Pinned</span>}
        <span className="rounded-full bg-ice px-2.5 py-0.5 text-xs font-semibold text-navy">{u.category}</span>
        <span className="text-xs text-medium">{fmtDateTime(u.created_at)}</span>
        {isAdmin && (
          <span className="ml-auto flex gap-1">
            <button disabled={busy} onClick={() => act({ pinned: !u.pinned })} title={u.pinned ? "Unpin" : "Pin"} className="rounded-lg p-1.5 text-medium hover:text-gold">
              {u.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            </button>
            <button disabled={busy} onClick={() => act("delete")} title="Delete" className="rounded-lg p-1.5 text-medium hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
          </span>
        )}
      </div>
      <h2 className="mt-3 text-lg font-bold text-navy">{u.title}</h2>
      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-charcoal/75">{u.body}</p>
    </article>
  );
}

function Composer({ onPosted }: { onPosted: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    const supabase = createClient();
    if (!supabase) return;
    setBusy(true); setErr("");
    const { error } = await supabase.from("team_updates").insert({
      title: title.trim(), body: body.trim(), category, pinned, published: true,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setTitle(""); setBody(""); setPinned(false); setCategory(CATEGORIES[0]);
    onPosted();
  }

  const field = "w-full rounded-xl border border-[#E4DCCB] bg-cream px-3 py-2.5 text-sm outline-none focus:border-gold";
  return (
    <form onSubmit={submit} className="rounded-2xl border border-gold/40 bg-offwhite/40 p-5">
      <p className="text-xs font-bold uppercase tracking-label text-gold">Post an update</p>
      <input className={field + " mt-3"} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea className={field + " mt-3"} rows={3} placeholder="Write your announcement…" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <select className={field + " w-auto"} value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="inline-flex items-center gap-2 text-sm text-charcoal/75">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to top
        </label>
        <button type="submit" disabled={busy} className="ml-auto inline-flex items-center gap-2 rounded-full bg-gradient-primary px-6 py-2.5 text-sm font-bold uppercase tracking-wider text-cream disabled:opacity-60">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Post
        </button>
      </div>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </form>
  );
}
