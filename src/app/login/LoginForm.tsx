"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { User, Lock, ArrowRight, Eye, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { safeLoginRedirect } from "./login-redirect";

const identity = (copy: string) => copy;
const SIGN_IN_UNAVAILABLE = "Sign-in is temporarily unavailable. Please try again later.";
type ErrorField = "login" | "password" | "credentials" | null;

export type LoginFormProps = {
  redirect?: string | string[];
  variant?: "default" | "premium";
  translate?: (copy: string) => string;
};

/**
 * One branded 1 Mission sign-in. Behind the scenes /api/auth/login decides how:
 *   - an ACTIVE Conectiv/Kuvera membership → signed in (account made silently),
 *   - an ADMIN-APPROVED email + password account → normal sign-in,
 * otherwise a friendly "not active / awaiting approval" message. The member
 * never sees anything about Kuvera — to them it's just the 1 Mission login.
 */
export function LoginForm({ redirect, variant = "default", translate = identity }: LoginFormProps) {
  const [form, setForm] = useState({ login: "", password: "" });
  const [status, setStatus] = useState<"idle" | "signing" | "error">("idle");
  const [message, setMessage] = useState("");
  const [errorField, setErrorField] = useState<ErrorField>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const submittingRef = useRef(false);
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const premium = variant === "premium";

  const dest = safeLoginRedirect(redirect);

  // Already signed in? Go straight into the portal.
  useEffect(() => {
    const supabase = createClient();
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active && data.session) window.location.assign(dest);
    }).catch(() => { /* Leave the sign-in form available when a session cannot be read. */ });
    return () => { active = false; };
  }, [dest]);

  function fail(msg: string, field: ErrorField = null) {
    submittingRef.current = false;
    setStatus("error");
    setMessage(msg);
    setErrorField(field);
    if (field === "login") loginRef.current?.focus();
    else if (field === "password" || field === "credentials") passwordRef.current?.focus();
  }

  // Returns null on success, "invalid" for bad credentials, or an error message.
  async function passwordSignIn(email: string, password: string): Promise<string | null> {
    const supabase = createClient();
    if (!supabase) return SIGN_IN_UNAVAILABLE;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return error.message.toLowerCase().includes("invalid") ? "invalid" : error.message;
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // A ref closes the gap before React commits the disabled-button state.
    if (submittingRef.current) return;
    const login = form.login.trim();
    const password = form.password;
    if (!login) return fail("Enter your member ID or email.", "login");
    if (!password) return fail("Enter your password.", "password");
    if (!isSupabaseConfigured) return fail(SIGN_IN_UNAVAILABLE);

    submittingRef.current = true;
    setStatus("signing");
    setMessage("");
    setErrorField(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login, password }),
      });
      const data = (await res.json().catch(() => ({ action: "error" }))) as {
        action: string;
        email?: string;
        reason?: string;
        message?: string;
      };

      if (data.action === "signin" && typeof data.email === "string" && data.email) {
        // Active membership — the server already synced the password.
        const err = await passwordSignIn(data.email, password);
        if (err) return fail("We confirmed your membership but couldn't open your portal. Please try again.");
        window.location.assign(dest);
        return;
      }

      if (data.action === "try_local") {
        // Admin-approved email + password account (needs an email to sign in).
        if (!login.includes("@")) {
          return fail("We couldn't confirm that login. Check your details, or your account may be awaiting approval.", "login");
        }
        const err = await passwordSignIn(login, password);
        if (err === "invalid") {
          return fail("We couldn't sign you in. Check your details, or your account may be awaiting approval.", "credentials");
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

      return fail(typeof data.message === "string" && data.message ? data.message : "We couldn't sign you in. Please try again.");
    } catch {
      return fail("Something went wrong signing in. Please try again.");
    }
  }

  const field = premium ? "om-login-input" : "w-full rounded-xl border border-[#E4DCCB] bg-cream py-3.5 pl-12 pr-4 text-sm outline-none focus:border-primary";
  const icon = premium ? "om-login-input-icon" : "pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium";
  const hasError = status === "error";
  const loginInvalid = hasError && (errorField === "login" || errorField === "credentials");
  const passwordInvalid = hasError && (errorField === "password" || errorField === "credentials");
  return (
    <form onSubmit={handleSubmit} noValidate className={premium ? "om-login-form" : "space-y-4"}
      data-no-i18n={translate !== identity ? "" : undefined}
      aria-busy={status === "signing"}
      aria-describedby={hasError ? "login-error" : !isSupabaseConfigured ? "login-notice" : undefined}>
      {!isSupabaseConfigured && (
        <p id="login-notice" className={premium ? "om-login-notice" : "rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"}>
          {translate(SIGN_IN_UNAVAILABLE)}
        </p>
      )}
      <div className={premium ? "om-login-field" : undefined}>
        <label htmlFor="login-id" className={premium ? "om-login-label" : "mb-1.5 block text-sm font-medium text-navy"}>
          {translate("Member ID or email")}
        </label>
        <div className={premium ? "om-login-input-wrap" : "relative"}>
          <User className={icon} aria-hidden="true" />
          <input
            ref={loginRef}
            id="login-id"
            name="login"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={form.login}
            onChange={(e) => setForm({ ...form, login: e.target.value })}
            placeholder={translate("Your member ID or email")}
            aria-invalid={loginInvalid || undefined}
            aria-describedby={loginInvalid ? "login-error" : undefined}
            className={field}
          />
        </div>
      </div>
      <div className={premium ? "om-login-field" : undefined}>
        <div className={premium ? "om-login-label-row" : "mb-1.5 flex items-center justify-between"}>
          <label htmlFor="login-password" className={premium ? "om-login-label" : "block text-sm font-medium text-navy"}>
            {translate("Password")}
          </label>
          <Link href="/forgot-password" className={premium ? "om-login-forgot" : "text-xs font-semibold text-primary hover:text-medium"}>
            {translate("Forgot password?")}
          </Link>
        </div>
        <div className={premium ? "om-login-input-wrap" : "relative"}>
          <Lock className={icon} aria-hidden="true" />
          <input
            ref={passwordRef}
            id="login-password"
            name="password"
            type={premium && passwordVisible ? "text" : "password"}
            autoComplete="current-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder={translate("Your password")}
            aria-invalid={passwordInvalid || undefined}
            aria-describedby={passwordInvalid ? "login-error" : undefined}
            className={field}
          />
          {premium && <button type="button" className="om-login-password-toggle"
            style={{ minWidth: 44, minHeight: 44 }}
            onClick={() => setPasswordVisible((visible) => !visible)}
            aria-label={translate(passwordVisible ? "Hide password" : "Show password")}
            aria-pressed={passwordVisible} aria-controls="login-password">
            {passwordVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>}
        </div>
      </div>
      {hasError && <p id="login-error" role="alert" className={premium ? "om-login-error" : "text-sm text-red-600"}>{translate(message)}</p>}
      <button
        type="submit"
        disabled={status === "signing"}
        className={premium ? "om-login-submit" : "inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-3.5 text-sm font-semibold text-cream shadow-[0_8px_24px_rgba(26,22,16,0.20)] transition-transform hover:-translate-y-0.5 disabled:opacity-60"}
      >
        {status === "signing" ? translate("Signing in…") : (
          <>
            {translate("Log in")} <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </>
        )}
      </button>
    </form>
  );
}
