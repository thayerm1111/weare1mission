"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

/**
 * Handles the password-recovery link. Establishes the recovery session from
 * whatever the link provides (a PKCE `code`, a URL hash token, or an existing
 * session), then lets the user set a new password.
 */
export function ResetForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const supabase = createClient();
    if (!supabase) { setPhase("invalid"); return; }

    const sub = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) setPhase("ready");
    });

    (async () => {
      try {
        const code = new URLSearchParams(window.location.search).get("code");
        if (code) {
          await supabase.auth.exchangeCodeForSession(code).catch(() => {});
        }
        const { data } = await supabase.auth.getSession();
        setPhase(data.session ? "ready" : "invalid");
      } catch {
        setPhase("invalid");
      }
    })();

    return () => sub.data.subscription.unsubscribe();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setStatus("error"); setMessage("Password must be at least 8 characters."); return; }
    const supabase = createClient();
    if (!supabase) return;
    setStatus("saving");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setStatus("error"); setMessage(error.message); }
    else { router.push("/portal"); router.refresh(); }
  }

  if (phase === "checking") {
    return <p className="text-center text-sm text-charcoal/60">Verifying your reset link…</p>;
  }

  if (phase === "invalid") {
    return (
      <div className="text-center">
        <p className="text-sm text-charcoal/70">
          This reset link is invalid or has expired. Reset links are only valid for a short time.
        </p>
        <Link href="/forgot-password" className="mt-5 inline-flex rounded-full bg-gradient-primary px-6 py-3 text-sm font-semibold text-cream">
          Send a new reset link
        </Link>
      </div>
    );
  }

  const field = "w-full rounded-xl border border-[#E4DCCB] bg-cream py-3.5 pl-12 pr-4 text-sm outline-none focus:border-primary";
  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor="rp-pass" className="mb-1.5 block text-sm font-medium text-navy">New password</label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
          <input id="rp-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" className={field} />
        </div>
      </div>
      {status === "error" && <p className="text-sm text-red-600">{message}</p>}
      <button type="submit" disabled={status === "saving"} className="w-full rounded-full bg-gradient-primary px-6 py-3.5 text-sm font-semibold text-cream disabled:opacity-60">
        {status === "saving" ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
