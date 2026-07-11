"use client";

import { useState, type FormEvent } from "react";
import { Mail, CheckCircle2, ArrowRight } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export function LoginForm({ redirect }: { redirect?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus("error");
      setMessage("Please enter a valid email address.");
      return;
    }
    const supabase = createClient();
    if (!supabase) {
      setStatus("error");
      setMessage("The member area isn't connected yet. Please check back soon.");
      return;
    }
    setStatus("sending");
    const redirectTo = `${window.location.origin}/auth/callback${
      redirect ? `?redirect=${encodeURIComponent(redirect)}` : ""
    }`;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) {
      setStatus("error");
      setMessage(error.message);
    } else {
      setStatus("sent");
    }
  }

  if (status === "sent") {
    return (
      <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-6 text-center shadow-card">
        <CheckCircle2 className="mx-auto h-10 w-10 text-primary" aria-hidden="true" />
        <h2 className="mt-3 text-lg font-bold text-navy">Check your email</h2>
        <p className="mt-2 text-sm text-charcoal/70">
          We sent a secure sign-in link to <span className="font-semibold text-navy">{email}</span>.
          Click it to enter the member area. You can close this tab.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {!isSupabaseConfigured && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Heads up: the member backend isn&apos;t connected yet. Sign-in will work once Supabase is
          configured (see the README).
        </p>
      )}
      <div>
        <label htmlFor="login-email" className="mb-1.5 block text-sm font-medium text-navy">
          Email address
        </label>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-xl border border-[#E4DCCB] bg-cream py-3.5 pl-12 pr-4 text-sm outline-none focus:border-primary"
          />
        </div>
      </div>
      {status === "error" && <p className="text-sm text-red-600">{message}</p>}
      <button
        type="submit"
        disabled={status === "sending"}
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-3.5 text-sm font-semibold text-cream shadow-[0_8px_24px_rgba(26,22,16,0.20)] transition-transform hover:-translate-y-0.5 disabled:opacity-60"
      >
        {status === "sending" ? "Sending link…" : (<>Send me a sign-in link <ArrowRight className="h-4 w-4" aria-hidden="true" /></>)}
      </button>
      <p className="text-center text-xs text-charcoal/55">
        No password needed. We&apos;ll email you a secure one-time link.
      </p>
    </form>
  );
}
