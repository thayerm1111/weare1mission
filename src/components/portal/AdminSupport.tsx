"use client";

/**
 * SUPPORT DESK — where the owner reads a ticket and sends the answer (owner 09-24).
 *
 * The shape of this screen follows from one rule: NOTHING REACHES A MEMBER WITHOUT A HUMAN PRESSING
 * SEND. Claude reads the threads, writes a triage note and leaves a suggested reply as a draft; the
 * draft is loaded into an editable box, and the text that is in that box when Send is pressed is what
 * the member receives. Editing it is not a special mode — it is the normal path.
 *
 * So each card shows, top to bottom: who and how urgent, what they said, what Claude thinks is going
 * on, and the reply box. The triage note is labelled as Claude's read of it rather than fact, because
 * it is a diagnosis from the data and can be wrong; the owner is the one who decides.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Send, Check, AlertTriangle, Bot, RefreshCw, Inbox } from "lucide-react";

type Msg = { id: string; role: string; body: string; created_at: string };
type Thread = {
  id: string;
  user_id: string;
  email: string | null;
  subject: string | null;
  status: string;
  priority: string | null;
  topic: string | null;
  triage_note: string | null;
  updated_at: string;
  last_member_at: string | null;
  last_staff_at: string | null;
  messages: Msg[];
  draft: { id: string; body: string; created_at: string } | null;
};

const ago = (iso: string | null) => {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const PRIORITY: Record<string, string> = {
  urgent: "bg-red-500/15 text-red-700 border-red-500/30",
  normal: "bg-navy/[0.06] text-navy/70 border-navy/15",
  low: "bg-charcoal/[0.05] text-charcoal/50 border-charcoal/15",
};

export function AdminSupport() {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [scope, setScope] = useState<"active" | "all">("active");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (s: "active" | "all") => {
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/support?status=${s}`, { cache: "no-store" });
      const d = await r.json();
      if (d?.ok) {
        const list = (d.threads ?? []) as Thread[];
        setThreads(list);
        // Seed each box with Claude's draft, but never clobber something the owner has already typed.
        setDrafts((prev) => {
          const next = { ...prev };
          for (const t of list) if (next[t.id] == null && t.draft?.body) next[t.id] = t.draft.body;
          return next;
        });
      } else setErr(d?.error === "forbidden" ? "Owner access only." : "Couldn't load the desk.");
    } catch { setErr("Network error."); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(scope); }, [load, scope]);
  useEffect(() => {
    const iv = setInterval(() => { void load(scope); }, 30_000);
    return () => clearInterval(iv);
  }, [load, scope]);

  async function send(t: Thread) {
    const body = (drafts[t.id] ?? "").trim();
    if (!body) return;
    setBusy(t.id); setErr("");
    try {
      const r = await fetch("/api/admin/support", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "send", threadId: t.id, body }),
      });
      const d = await r.json();
      if (!d?.ok) setErr(d?.detail || "Couldn't send.");
      else { setDrafts((p) => ({ ...p, [t.id]: "" })); await load(scope); }
    } catch { setErr("Network error."); }
    setBusy("");
  }

  async function setStatus(t: Thread, status: string) {
    setBusy(t.id);
    try {
      await fetch("/api/admin/support", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "status", threadId: t.id, status }),
      });
      await load(scope);
    } catch { setErr("Network error."); }
    setBusy("");
  }

  const waiting = useMemo(() => (threads ?? []).filter((t) => t.status === "open").length, [threads]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded-full border border-navy/15 bg-navy/[0.04] px-3 py-1 font-bold text-navy">
            {waiting} waiting
          </span>
          <button onClick={() => setScope("active")}
            className={`rounded-full px-3 py-1 text-xs font-bold ${scope === "active" ? "bg-navy text-white" : "border border-navy/15 text-navy/60"}`}>
            Active
          </button>
          <button onClick={() => setScope("all")}
            className={`rounded-full px-3 py-1 text-xs font-bold ${scope === "all" ? "bg-navy text-white" : "border border-navy/15 text-navy/60"}`}>
            Everything
          </button>
        </div>
        <button onClick={() => void load(scope)} className="inline-flex items-center gap-1.5 text-xs font-bold text-navy/60 hover:text-navy">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
        </button>
      </div>

      {err && (
        <p className="flex items-center gap-2 rounded-xl border border-red-500/25 bg-red-500/[0.06] px-4 py-2.5 text-sm font-semibold text-red-700">
          <AlertTriangle className="h-4 w-4" /> {err}
        </p>
      )}

      {threads == null ? (
        <p className="text-sm text-charcoal/60">Loading the desk…</p>
      ) : !threads.length ? (
        <div className="rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-8 text-center">
          <Inbox className="mx-auto h-6 w-6 text-charcoal/30" />
          <p className="mt-2 text-sm text-charcoal/60">Nothing in the queue.</p>
        </div>
      ) : threads.map((t) => {
        const last = t.messages.filter((m) => m.role === "member").slice(-1)[0] ?? null;
        return (
          <article key={t.id} className="rounded-2xl border border-[#E4DCCB] bg-white p-5 shadow-card">
            <header className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-navy">{t.email ?? "Unknown member"}</p>
                <p className="text-xs text-charcoal/50">
                  {t.topic ? `${t.topic} · ` : ""}last message {ago(t.last_member_at ?? t.updated_at)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold capitalize ${PRIORITY[t.priority ?? "normal"] ?? PRIORITY.normal}`}>
                  {t.priority ?? "normal"}
                </span>
                <span className="rounded-full border border-navy/15 px-2.5 py-0.5 text-[11px] font-bold capitalize text-navy/60">{t.status}</span>
              </div>
            </header>

            <div className="mt-3 space-y-2">
              {t.messages.slice(-6).map((m) => (
                <div key={m.id} className={`rounded-xl px-3.5 py-2.5 text-sm ${m.role === "staff" ? "ml-6 bg-navy/[0.05] text-navy" : "mr-6 bg-offwhite/80 text-charcoal"}`}>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-charcoal/35">
                    {m.role === "staff" ? "You" : "Member"} · {ago(m.created_at)}
                  </p>
                </div>
              ))}
            </div>

            {t.triage_note && (
              <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-50/70 p-3">
                <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.15em] text-amber-700">
                  <Bot className="h-3.5 w-3.5" /> Claude&rsquo;s read — check it before you send
                </p>
                <p className="mt-1.5 whitespace-pre-wrap text-sm text-charcoal/80">{t.triage_note}</p>
              </div>
            )}

            <div className="mt-3">
              <label className="text-[10px] font-black uppercase tracking-[0.15em] text-charcoal/45">
                Your reply{t.draft ? " — drafted for you, edit anything" : ""}
              </label>
              <textarea
                value={drafts[t.id] ?? ""}
                onChange={(e) => setDrafts((p) => ({ ...p, [t.id]: e.target.value }))}
                rows={4}
                placeholder={last ? "Answer them…" : "Write a reply…"}
                className="mt-1 w-full rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-3 text-sm text-charcoal outline-none focus:border-navy/40"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button onClick={() => void send(t)} disabled={busy === t.id || !(drafts[t.id] ?? "").trim()}
                  className="inline-flex items-center gap-2 rounded-xl bg-navy px-4 py-2 text-sm font-bold text-white disabled:opacity-40">
                  {busy === t.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send to member
                </button>
                {t.status !== "resolved" && (
                  <button onClick={() => void setStatus(t, "resolved")} disabled={busy === t.id}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-navy/20 px-3 py-2 text-sm font-semibold text-navy/70 disabled:opacity-40">
                    <Check className="h-4 w-4" /> Mark resolved
                  </button>
                )}
                {t.status === "resolved" && (
                  <button onClick={() => void setStatus(t, "open")} disabled={busy === t.id}
                    className="rounded-xl border border-navy/20 px-3 py-2 text-sm font-semibold text-navy/70 disabled:opacity-40">
                    Reopen
                  </button>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
