"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function ResetForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setStatus("error"); setMessage("Password must be at least 8 characters."); return; }
    const supabase = createClient();
    if (!supabase) { setStatus("error"); setMessage("The member area isn't connected yet."); return; }
    setStatus("saving");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setStatus("error"); setMessage(error.message); }
    else router.push("/portal");
  }

  const field = "w-full rounded-xl border border-[#E4DCCB] bg-cream py-3.5 pl-12 pr-4 text-sm outline-none focus:border-primary";
  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor="rp-pass" className="mb-1.5 block text-sm font-medium text-navy">New password</label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-medium" aria-hidden="true" />
          <input id="rp-pass" type="password" className={field} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
        </div>
      </div>
      {status === "error" && <p className="text-sm text-red-600">{message}</p>}
      <button type="submit" disabled={status === "saving"} className="w-full rounded-full bg-gradient-primary px-6 py-3.5 text-sm font-semibold text-cream disabled:opacity-60">
        {status === "saving" ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
