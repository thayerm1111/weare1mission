"use client";

import { useState, type FormEvent } from "react";
import { Lock, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

/**
 * Lets a signed-in member set or change their password without needing a reset
 * email. Uses the active session, so it always works while logged in.
 */
export function PasswordForm() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setStatus("error"); setMessage("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setStatus("error"); setMessage("The two passwords don't match."); return; }
    const supabase = createClient();
    if (!supabase) { setStatus("error"); setMessage("The member area isn't connected yet."); return; }
    setStatus("saving");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setStatus("error"); setMessage(error.message); }
    else { setStatus("saved"); setPassword(""); setConfirm(""); setMessage(""); }
  }

  const field = "w-full rounded-xl border border-[#E4DCCB] bg-cream py-3.5 pl-12 pr-4 text-sm outline-none focus:border-primary";
  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor="pw-new" className="mb-1.5 block text-sm font-medium text-navy">New password</label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
          <input id="pw-new" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" className={field} />
        </div>
      </div>
      <div>
        <label htmlFor="pw-confirm" className="mb-1.5 block text-sm font-medium text-navy">Confirm password</label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
          <input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter your password" className={field} />
        </div>
      </div>
      {status === "error" && <p className="text-sm text-red-600">{message}</p>}
      {status === "saved" && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-green-700">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Password updated. You can use it to log in next time.
        </p>
      )}
      <button type="submit" disabled={status === "saving"} className="rounded-full bg-gradient-primary px-6 py-3 text-sm font-semibold text-cream disabled:opacity-60">
        {status === "saving" ? "Saving…" : "Update password"}
      </button>
    </form>
  );
}
