"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Play, User, Mail, Phone } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { VideoTracker } from "./VideoTracker";

export function ReferralExperience({
  username, firstName, videoUrl,
}: { username: string; firstName: string; videoUrl: string }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [leadId, setLeadId] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return fail("Please enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return fail("Please enter a valid email.");
    if (!form.phone.trim()) return fail("Please enter your mobile number.");

    const supabase = createClient();
    setStatus("saving"); setMessage("");
    if (supabase) {
      const { data } = await supabase.rpc("create_lead", {
        ref_username: username, p_name: form.name, p_email: form.email, p_phone: form.phone,
      });
      if (data) setLeadId(data as string);
    }
    setStarted(true);
    setStatus("idle");
  }

  function fail(m: string) { setStatus("error"); setMessage(m); }

  if (started) {
    return (
      <div className="space-y-6">
        {videoUrl ? (
          <VideoTracker url={videoUrl} leadId={leadId} />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center rounded-xl border border-dashed border-light bg-ice/60 text-center">
            <Play className="h-10 w-10 text-medium" aria-hidden="true" />
            <p className="mt-2 text-sm font-medium text-navy">The community video is coming soon.</p>
          </div>
        )}
        <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-6 text-center shadow-card">
          <h2 className="text-lg font-bold text-navy">Ready to join {firstName}&apos;s team?</h2>
          <p className="mt-1 text-sm text-charcoal/70">Create your account — your access is approved by the 1 Mission team.</p>
          <Link
            href={`/signup?ref=${encodeURIComponent(username)}`}
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-gradient-primary px-8 py-4 text-base font-semibold text-cream shadow-[0_8px_24px_rgba(26,22,16,0.20)] transition-transform hover:-translate-y-0.5"
          >
            Create your account <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    );
  }

  const field = "w-full rounded-xl border border-[#E4DCCB] bg-cream py-3.5 pl-12 pr-4 text-sm outline-none focus:border-primary";
  return (
    <div className="rounded-2xl border border-[#E4DCCB] bg-offwhite/70 p-6 shadow-card sm:p-8">
      <div className="flex items-center gap-2 text-sm font-semibold text-navy">
        <Play className="h-5 w-5 text-primary" aria-hidden="true" /> Watch the 2-minute overview
      </div>
      <p className="mt-1 text-sm text-charcoal/70">Enter your details to watch {firstName}&apos;s community overview video.</p>
      <form onSubmit={handleSubmit} noValidate className="mt-5 space-y-4">
        <Field id="ln-name" label="Full name" icon={User} value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Your name" />
        <Field id="ln-email" label="Email" type="email" icon={Mail} value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="you@example.com" />
        <Field id="ln-phone" label="Mobile number" type="tel" icon={Phone} value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="+1 555 123 4567" />
        {status === "error" && <p className="text-sm text-red-600">{message}</p>}
        <button type="submit" disabled={status === "saving"} className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-3.5 text-sm font-semibold text-cream disabled:opacity-60">
          {status === "saving" ? "Loading…" : (<>Watch the video <Play className="h-4 w-4" aria-hidden="true" /></>)}
        </button>
      </form>
    </div>
  );
}

function Field({ id, label, icon: Icon, value, onChange, placeholder, type = "text" }: {
  id: string; label: string; icon: React.ElementType; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div className="text-left">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-navy">{label}</label>
      <div className="relative">
        <Icon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
        <input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
          className="w-full rounded-xl border border-[#E4DCCB] bg-cream py-3.5 pl-12 pr-4 text-sm outline-none focus:border-primary" />
      </div>
    </div>
  );
}
