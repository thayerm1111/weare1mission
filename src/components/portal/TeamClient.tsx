"use client";

import { useMemo, useState } from "react";
import {
  Copy, Check, Mail, MessageSquare, Send, Link2, Users, ChevronDown,
} from "lucide-react";
import { TIER_LABELS } from "@/lib/access";

export interface DownlineMember {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  username: string | null;
  tier: string;
  status: string;
  created_at: string;
  level: number;
}

interface Props {
  username: string | null;
  siteUrl: string;
  downline: DownlineMember[];
  emailEnabled: boolean;
  smsEnabled: boolean;
}

export function TeamClient({ username, siteUrl, downline, emailEnabled, smsEnabled }: Props) {
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string>("");

  const link = username ? `${siteUrl.replace(/\/$/, "")}/${username}` : "";

  const byLevel = useMemo(() => {
    const groups = new Map<number, DownlineMember[]>();
    downline.forEach((m) => {
      const arr = groups.get(m.level) ?? [];
      arr.push(m); groups.set(m.level, arr);
    });
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [downline]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function selectAll() {
    setSelected(new Set(downline.map((m) => m.id)));
  }
  function clearSel() { setSelected(new Set()); }

  async function send() {
    setResult("");
    if (selected.size === 0) { setResult("Select at least one person."); return; }
    if (!message.trim()) { setResult("Write a message first."); return; }
    if (channel === "email" && !subject.trim()) { setResult("Add a subject."); return; }
    setSending(true);
    const endpoint = channel === "email" ? "/api/send-email" : "/api/send-sms";
    const payload = channel === "email"
      ? { toIds: [...selected], subject, message }
      : { toIds: [...selected], message };
    try {
      const res = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) { setResult(`Sent to ${data.sent} ${data.sent === 1 ? "person" : "people"}.`); setMessage(""); setSubject(""); }
      else if (data.error?.includes("not-configured")) setResult("This channel isn't connected yet — use the per-person buttons below for now.");
      else setResult("Couldn't send. Please try again.");
    } catch { setResult("Couldn't send. Please try again."); }
    setSending(false);
  }

  const selectedList = downline.filter((m) => selected.has(m.id));
  const channelReady = channel === "email" ? emailEnabled : smsEnabled;
  // Fallback compose link (opens the member's own Mail/Messages app).
  const mailtoAll = `mailto:${selectedList.map((m) => m.email).filter(Boolean).join(",")}`;
  const smsAll = `sms:${selectedList.map((m) => m.phone).filter(Boolean).join(",")}`;

  return (
    <div className="space-y-8">
      {/* Referral link */}
      <section className="rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-6">
        <h2 className="flex items-center gap-2 text-base font-bold text-navy">
          <Link2 className="h-5 w-5 text-primary" aria-hidden="true" /> Your personal invite link
        </h2>
        {username ? (
          <>
            <p className="mt-1 text-sm text-charcoal/70">Share this link — anyone who signs up through it joins your team.</p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <code className="flex-1 truncate rounded-xl border border-[#E4DCCB] bg-cream px-4 py-3 text-sm text-navy">{link}</code>
              <button
                onClick={() => { navigator.clipboard?.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-primary px-5 py-3 text-sm font-semibold text-cream"
              >
                {copied ? <><Check className="h-4 w-4" aria-hidden="true" /> Copied</> : <><Copy className="h-4 w-4" aria-hidden="true" /> Copy</>}
              </button>
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-charcoal/70">
            Set a username on your <a href="/portal/account" className="font-semibold text-primary hover:text-medium">Account</a> page to get your personal invite link.
          </p>
        )}
      </section>

      {/* Downline */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-bold text-navy">
            <Users className="h-5 w-5 text-primary" aria-hidden="true" /> Your Team ({downline.length})
          </h2>
          {downline.length > 0 && (
            <div className="flex items-center gap-3 text-sm">
              <button onClick={selectAll} className="font-semibold text-primary hover:text-medium">Select all</button>
              {selected.size > 0 && <button onClick={clearSel} className="text-charcoal/60 hover:text-navy">Clear ({selected.size})</button>}
            </div>
          )}
        </div>

        {downline.length === 0 ? (
          <p className="mt-4 rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-6 text-sm text-charcoal/60">
            No one has joined through your link yet. Share your invite link above to start building your team.
          </p>
        ) : (
          <div className="mt-4 space-y-6">
            {byLevel.map(([level, members]) => (
              <div key={level}>
                <p className="mb-2 text-xs font-bold uppercase tracking-label text-medium">
                  Level {level} {level === 1 ? "· direct sign-ups" : ""} ({members.length})
                </p>
                <div className="space-y-2">
                  {members.map((m) => (
                    <div key={m.id} className="flex flex-col gap-3 rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
                      <label className="flex min-w-0 items-start gap-3">
                        <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} className="mt-1 h-4 w-4 accent-[#1A1610]" />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-bold text-navy">{m.full_name || "(no name)"}</span>
                            <span className="rounded-full bg-ice px-2 py-0.5 text-[11px] font-semibold text-navy">{TIER_LABELS[m.tier as keyof typeof TIER_LABELS] ?? m.tier}</span>
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${m.status === "active" ? "bg-emerald-100 text-emerald-700" : m.status === "pending" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700"}`}>{m.status}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-sm text-charcoal/60">{m.email}{m.phone ? ` · ${m.phone}` : ""}</span>
                        </span>
                      </label>
                      <div className="flex flex-shrink-0 items-center gap-2">
                        {m.email && <a href={`mailto:${m.email}`} className="inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] px-3 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"><Mail className="h-3.5 w-3.5" aria-hidden="true" /> Email</a>}
                        {m.phone && <a href={`sms:${m.phone}`} className="inline-flex items-center gap-1.5 rounded-full border border-[#E4DCCB] px-3 py-1.5 text-xs font-semibold text-navy hover:border-primary hover:text-primary"><MessageSquare className="h-3.5 w-3.5" aria-hidden="true" /> Text</a>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Bulk compose */}
      {downline.length > 0 && (
        <section className="rounded-2xl border border-[#E4DCCB] bg-offwhite/60 p-6">
          <h2 className="flex items-center gap-2 text-base font-bold text-navy"><Send className="h-5 w-5 text-primary" aria-hidden="true" /> Message your team</h2>
          <p className="mt-1 text-sm text-charcoal/70">{selected.size} selected. {selected.size === 0 && "Select people above first."}</p>

          <div className="mt-4 inline-flex rounded-xl border border-[#E4DCCB] bg-cream p-1">
            <button onClick={() => setChannel("email")} className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${channel === "email" ? "bg-primary text-cream" : "text-charcoal/70"}`}>Email</button>
            <button onClick={() => setChannel("sms")} className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${channel === "sms" ? "bg-primary text-cream" : "text-charcoal/70"}`}>Text</button>
          </div>

          {!channelReady && (
            <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Platform {channel === "email" ? "email (Resend)" : "SMS (Twilio)"} isn&apos;t connected yet. You can still use the
              per-person {channel === "email" ? "Email" : "Text"} buttons above, or open your {channel === "email" ? "mail app" : "messages"} for everyone selected:
              {" "}
              <a href={channel === "email" ? mailtoAll : smsAll} className="font-semibold underline">open now</a>.
            </p>
          )}

          <div className="mt-4 space-y-3">
            {channel === "email" && (
              <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="w-full rounded-xl border border-[#E4DCCB] bg-cream px-4 py-3 text-sm outline-none focus:border-primary" />
            )}
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} placeholder={`Write your ${channel === "email" ? "email" : "text"}…`} className="w-full rounded-xl border border-[#E4DCCB] bg-cream px-4 py-3 text-sm outline-none focus:border-primary" />
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button onClick={send} disabled={sending || !channelReady || selected.size === 0}
              className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-6 py-3 text-sm font-semibold text-cream disabled:opacity-50">
              {sending ? "Sending…" : `Send to ${selected.size}`}
            </button>
            {result && <span className="text-sm text-charcoal/70">{result}</span>}
          </div>
        </section>
      )}
    </div>
  );
}
