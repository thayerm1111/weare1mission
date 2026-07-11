"use client";

import { useState, type FormEvent } from "react";
import { Mail, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus("error"); setMessage("Please enter a valid email."); return;
    }
    const supabase = createClient();
    if (!supabase) { setStatus("error"); setMessage("The member area isn't connected yet."); return; }
    setStatus("sending");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset`,
    });
    if (error) { setStatus("error"); setMessage(error.message); }
    else setStatus("sent");
  }

  if (status === "sent") {
    return (
      <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-6 text-center shadow-card">
        <CheckCircle2 className="mx-auto h-10 w-10 text-primary" aria-hidden="true" />
        <h2 className="mt-3 text-lg font-bold text-navy">Check your email</h2>
        <p className="mt-2 text-sm text-charcoal/70">If an account exists for <span className="font-semibold text-navy">{email}</span>, we&apos;ve sent a link to reset your password.</p>
      </div>
    );
  }

  const field = "w-full rounded-xl border border-[#E4DCCB] bg-cream py-3.5 pl-12 pr-4 text-sm outline-none focus:border-primary";
  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor="fp-email" className="mb-1.5 block text-sm font-medium text-navy">Email address</label>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
          <input id="fp-email" type="email" className={field} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
        </div>
      </div>
      {status === "error" && <p className="text-sm text-red-600">{message}</p>}
      <button type="submit" disabled={status === "sending"} className="w-full rounded-full bg-gradient-primary px-6 py-3.5 text-sm font-semibold text-cream disabled:opacity-60">
        {status === "sending" ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
