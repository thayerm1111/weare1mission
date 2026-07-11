"use client";

import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

interface Props {
  id: string;
  initialName: string;
  initialUsername: string;
  initialPhone: string;
}

const RESERVED = new Set([
  "login", "signup", "portal", "auth", "events", "shop", "start-here", "contact",
  "legal", "api", "admin", "account", "team", "forgot-password", "www", "1mission",
  "training", "schedule", "resources", "leadership", "trading", "updates",
]);

export function AccountForm({ id, initialName, initialUsername, initialPhone }: Props) {
  const [name, setName] = useState(initialName);
  const [username, setUsername] = useState(initialUsername);
  const [phone, setPhone] = useState(initialPhone);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    if (!supabase) return;

    const u = username.trim().toLowerCase();
    if (u) {
      if (!/^[a-z0-9-]{3,30}$/.test(u)) return fail("Username: 3–30 letters, numbers, or hyphens.");
      if (RESERVED.has(u)) return fail("That username is reserved. Please choose another.");
      if (u !== initialUsername) {
        const { data: available } = await supabase.rpc("is_username_available", { u });
        if (available === false) return fail("That username is already taken.");
      }
    }

    setStatus("saving"); setError("");
    const { error: err } = await supabase
      .from("profiles")
      .update({ full_name: name, username: u || null, phone: phone || null })
      .eq("id", id);
    if (err) fail(err.message.includes("duplicate") ? "That username is already taken." : "Couldn't save. Try again.");
    else setStatus("saved");
  }

  function fail(msg: string) { setStatus("error"); setError(msg); }

  const field = "w-full max-w-sm rounded-xl border border-[#E4DCCB] bg-cream px-4 py-3 text-sm outline-none focus:border-primary";
  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="acct-name" className="mb-1.5 block text-sm font-medium text-navy">Display name</label>
        <input id="acct-name" value={name} onChange={(e) => { setName(e.target.value); setStatus("idle"); }} className={field} placeholder="Your name" />
      </div>
      <div>
        <label htmlFor="acct-username" className="mb-1.5 block text-sm font-medium text-navy">Username (for your invite link)</label>
        <div className="flex max-w-sm items-center rounded-xl border border-[#E4DCCB] bg-cream focus-within:border-primary">
          <span className="pl-4 text-sm text-medium">/</span>
          <input id="acct-username" value={username} onChange={(e) => { setUsername(e.target.value.toLowerCase()); setStatus("idle"); }} className="w-full bg-transparent px-1 py-3 text-sm outline-none" placeholder="yourname" />
        </div>
        <p className="mt-1 text-xs text-charcoal/55">Your link becomes weare1mission.com/<span className="font-semibold">{username || "yourname"}</span></p>
      </div>
      <div>
        <label htmlFor="acct-phone" className="mb-1.5 block text-sm font-medium text-navy">Mobile number</label>
        <input id="acct-phone" type="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setStatus("idle"); }} className={field} placeholder="+1 555 123 4567" />
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={status === "saving"} className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-5 py-2.5 text-sm font-semibold text-cream disabled:opacity-60">
          {status === "saving" ? "Saving…" : "Save changes"}
        </button>
        {status === "saved" && <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600"><Check className="h-4 w-4" aria-hidden="true" /> Saved</span>}
        {status === "error" && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </form>
  );
}
