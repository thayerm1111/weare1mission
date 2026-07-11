"use client";

import { useState, type FormEvent } from "react";
import { Mail, Lock, User, CheckCircle2, ArrowRight } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import Link from "next/link";

export function SignupForm() {
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return fail("Please enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return fail("Please enter a valid email.");
    if (form.password.length < 8) return fail("Password must be at least 8 characters.");

    const supabase = createClient();
    if (!supabase) return fail("The member area isn't connected yet. Please check back soon.");

    setStatus("sending");
    const { error } = await supabase.auth.signUp({
      email: form.email,
      password: form.password,
      options: { data: { full_name: form.name } },
    });
    if (error) return fail(error.message);
    setStatus("done");
  }

  function fail(msg: string) {
    setStatus("error");
    setMessage(msg);
  }

  if (status === "done") {
    return (
      <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-6 text-center shadow-card">
        <CheckCircle2 className="mx-auto h-10 w-10 text-primary" aria-hidden="true" />
        <h2 className="mt-3 text-lg font-bold text-navy">Account created — pending approval</h2>
        <p className="mt-2 text-sm leading-relaxed text-charcoal/70">
          Thanks, {form.name.split(" ")[0]}! Your account is now awaiting approval from the 1 Mission
          team. Once you&apos;re approved, you&apos;ll have full access to the member area. We&apos;ll
          be in touch — reach out to your mentor if you have questions.
        </p>
        <Link href="/login" className="mt-6 inline-flex rounded-full bg-gradient-primary px-6 py-3 text-sm font-semibold text-cream">
          Go to log in
        </Link>
      </div>
    );
  }

  const field = "w-full rounded-xl border border-[#E4DCCB] bg-cream py-3.5 pl-12 pr-4 text-sm outline-none focus:border-primary";
  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {!isSupabaseConfigured && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The member backend isn&apos;t connected yet. Sign-up will work once Supabase is configured.
        </p>
      )}
      <div>
        <label htmlFor="su-name" className="mb-1.5 block text-sm font-medium text-navy">Full name</label>
        <div className="relative">
          <User className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
          <input id="su-name" className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your name" autoComplete="name" />
        </div>
      </div>
      <div>
        <label htmlFor="su-email" className="mb-1.5 block text-sm font-medium text-navy">Email address</label>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
          <input id="su-email" type="email" className={field} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" autoComplete="email" />
        </div>
      </div>
      <div>
        <label htmlFor="su-pass" className="mb-1.5 block text-sm font-medium text-navy">Password</label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
          <input id="su-pass" type="password" className={field} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="At least 8 characters" autoComplete="new-password" />
        </div>
      </div>
      {status === "error" && <p className="text-sm text-red-600">{message}</p>}
      <button type="submit" disabled={status === "sending"} className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-3.5 text-sm font-semibold text-cream shadow-[0_8px_24px_rgba(26,22,16,0.20)] transition-transform hover:-translate-y-0.5 disabled:opacity-60">
        {status === "sending" ? "Creating account…" : (<>Create account <ArrowRight className="h-4 w-4" aria-hidden="true" /></>)}
      </button>
      <p className="text-center text-xs text-charcoal/55">
        New accounts are reviewed and approved by the 1 Mission team before access is granted.
      </p>
    </form>
  );
}
