"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { User, Lock, ArrowRight } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * One branded 1 Mission sign-in. Behind the scenes /api/auth/login decides how:
 *   - an ACTIVE Conectiv/Kuvera membership → signed in (account made silently),
 *   - an ADMIN-APPROVED email + password account → normal sign-in,
 * otherwise a friendly "not active / awaiting approval" message. The member
 * never sees anything about Kuvera — to them it's just the 1 Mission login.
 */
export function LoginForm({ redirect }: { redirect?: string }) {
  const [form, setForm] = useState({ login: "", password: "" });
  const [status, setStatus] = useState<"idle" | "signing" | "error">("idle");
  const [message, setMessage] = useState("");

  // Only allow same-site redirect targets (prevents open-redirects).
  const dest = redirect && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/portal";

  // Already signed in? Go straight into the portal.
  useEffect(() => {
    const supabase = createClient();
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) window.location.assign(dest);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fail(msg: string) {
    setStatus("error");
    setMessage(msg);
  }

  // Returns null on success, "invalid" for bad credentials, or an error message.
  async function passwordSignIn(email: string, password: string): Promise<string | null> {
    const supabase = createClient();
    if (!supabase) return "The member area isn't connected yet. Please check back soon.";
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return error.message.toLowerCase().includes("invalid") ? "invalid" : error.message;
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const login = form.login.trim();
    if (!login) return fail("Enter your member ID or email.");
    if (!form.password) return fail("Enter your password.");

    setStatus("signing");
    setMessage("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login, password: form.password }),
      });
      const data = (await res.json().catch(() => ({ action: "error" }))) as {
        action: string;
        email?: string;
        reason?: string;
        message?: string;
      };

      if (data.action === "signin" && data.email) {
        // Active membership — the server already synced the password.
        const err = await passwordSignIn(data.email, form.password);
        if (err) return fail("We confirmed your membership but couldn't open your portal. Please try again.");
        window.location.assign(dest);
        return;
      }

      if (data.action === "try_local") {
        // Admin-approved email + password account (needs an email to sign in).
        if (!login.includes("@")) {
          return fail("We couldn't confirm that login. Check your details, or your account may be awaiting approval.");
        }
        const err = await passwordSignIn(login, form.password);
        if (err === "invalid") {
          return fail("We couldn't sign you in. Check your details, or your account may be awaiting approval.");
        }
        if (err) return fail(err);
        window.location.assign(dest);
        return;
      }

      if (data.action === "blocked") {
        if (data.reason === "inactive") {
          return fail("We couldn't confirm an active membership for that login. If you just renewed, give it a few minutes and try again.");
        }
        if (data.reason === "physical_only") {
          return fail("That membership doesn't include member-area access.");
        }
        return fail("We couldn't sign you in right now. Please try again, or reach out to your team.");
      }

      return fail(data.message || "We couldn't sign you in. Please try again.");
    } catch {
      return fail("Something went wrong signing in. Please try again.");
    }
  }

  const field =
    "w-full rounded-xl border border-[#E4DCCB] bg-cream py-3.5 pl-12 pr-4 text-sm outline-none focus:border-primary";
  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {!isSupabaseConfigured && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Heads up: the member backend isn&apos;t connected yet. Sign-in will work once Supabase is configured.
        </p>
      )}
      <div>
        <label htmlFor="login-id" className="mb-1.5 block text-sm font-medium text-navy">
          Member ID or email
        </label>
        <div className="relative">
          <User className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
          <input
            id="login-id"
            type="text"
            autoComplete="username"
            value={form.login}
            onChange={(e) => setForm({ ...form, login: e.target.value })}
            placeholder="Your member ID or email"
            className={field}
          />
        </div>
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor="login-password" className="block text-sm font-medium text-navy">
            Password
          </label>
          <Link href="/forgot-password" className="text-xs font-semibold text-primary hover:text-medium">
            Forgot password?
          </Link>
        </div>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="Your password"
            className={field}
          />
        </div>
      </div>
      {status === "error" && <p className="text-sm text-red-600">{message}</p>}
      <button
        type="submit"
        disabled={status === "signing"}
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-3.5 text-sm font-semibold text-cream shadow-[0_8px_24px_rgba(26,22,16,0.20)] transition-transform hover:-translate-y-0.5 disabled:opacity-60"
      >
        {status === "signing" ? "Signing in…" : (
          <>
            Log in <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </>
        )}
      </button>
    </form>
  );
}
