"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Mail, Lock, User, ArrowRight, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

function readRefCookie(): string {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(/(?:^|;\s*)1m_ref=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

/**
 * 14-day free trial registration. POSTs to /api/trial/register (creates the
 * account, auto-approves it, grants the 200 trial credits), then signs the new
 * member straight in and lands them in the portal — one form, zero waiting.
 */
export function JoinForm({ refUsername }: { refUsername?: string }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", website: "" });
  const [status, setStatus] = useState<"idle" | "sending" | "entering" | "error">("idle");
  const [message, setMessage] = useState("");

  function fail(msg: string) { setStatus("error"); setMessage(msg); }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return fail("Please enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return fail("Please enter a valid email.");
    if (form.password.length < 8) return fail("Password must be at least 8 characters.");

    setStatus("sending");
    setMessage("");
    try {
      const res = await fetch("/api/trial/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          ref: (refUsername || readRefCookie() || "").toLowerCase(),
          website: form.website, // honeypot — stays empty for humans
        }),
      });
      const j = await res.json();
      if (!j?.ok) {
        if (j?.error === "already_registered") return fail(j.detail || "That email already has an account — log in instead.");
        return fail(j?.error || "Something went wrong — please try again.");
      }
      // Account is live — sign them in and walk them straight onto the desk.
      setStatus("entering");
      const supabase = createClient();
      if (supabase) {
        const { error } = await supabase.auth.signInWithPassword({ email: form.email.trim().toLowerCase(), password: form.password });
        if (!error) { window.location.assign("/portal"); return; }
      }
      // Sign-in hiccup: the account exists and is active — send them to log in.
      window.location.assign("/login");
    } catch {
      fail("Network hiccup — please try again.");
    }
  }

  if (status === "entering") {
    return (
      <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-6 text-center shadow-card">
        <CheckCircle2 className="mx-auto h-10 w-10 text-primary" aria-hidden="true" />
        <h2 className="mt-3 text-lg font-bold text-navy">You&apos;re in, {form.name.split(" ")[0]}!</h2>
        <p className="mt-2 text-sm leading-relaxed text-charcoal/70">
          Your 14-day trial is live with 200 credits on your account. Taking you to the platform…
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {!isSupabaseConfigured && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The member backend isn&apos;t connected yet. Registration will work once it&apos;s configured.
        </p>
      )}
      <Input id="jn-name" label="Full name" icon={User} value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Your name" autoComplete="name" />
      <Input id="jn-email" label="Email address" type="email" icon={Mail} value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="you@example.com" autoComplete="email" />
      <Input id="jn-pass" label="Create a password" type="password" icon={Lock} value={form.password} onChange={(v) => setForm({ ...form, password: v })} placeholder="At least 8 characters" autoComplete="new-password" />
      {/* Honeypot — invisible to people, irresistible to bots. */}
      <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="jn-web">Website</label>
        <input id="jn-web" type="text" tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
      </div>

      {status === "error" && <p className="text-sm text-red-600">{message}</p>}
      <button type="submit" disabled={status === "sending"} className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-3.5 text-sm font-semibold text-cream shadow-[0_8px_24px_rgba(26,22,16,0.20)] transition-transform hover:-translate-y-0.5 disabled:opacity-60">
        {status === "sending" ? "Setting up your trial…" : (<>Start my free trial <ArrowRight className="h-4 w-4" aria-hidden="true" /></>)}
      </button>
      <p className="text-center text-xs text-charcoal/55">
        14 days free · 200 credits included · instant access, no approval wait · no card required
      </p>
      <p className="text-center text-xs text-charcoal/55">
        Already a member? <Link href="/login" className="font-semibold text-primary hover:text-medium">Log in</Link>
      </p>
    </form>
  );
}

function Input({
  id, label, icon: Icon, value, onChange, placeholder, type = "text", autoComplete,
}: {
  id: string; label: string; icon: React.ElementType; value: string;
  onChange: (v: string) => void; placeholder?: string; type?: string; autoComplete?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-navy">{label}</label>
      <div className="relative">
        <Icon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
        <input id={id} type={type} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
          className="w-full rounded-xl border border-[#E4DCCB] bg-cream py-3.5 pl-12 pr-4 text-sm outline-none focus:border-primary" />
      </div>
    </div>
  );
}
