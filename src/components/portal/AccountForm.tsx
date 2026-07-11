"use client";

import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function AccountForm({ id, initialName }: { id: string; initialName: string }) {
  const [name, setName] = useState(initialName);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    if (!supabase) return;
    setStatus("saving");
    const { error } = await supabase.from("profiles").update({ full_name: name }).eq("id", id);
    setStatus(error ? "error" : "saved");
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor="acct-name" className="mb-1.5 block text-sm font-medium text-navy">Display name</label>
        <input
          id="acct-name"
          value={name}
          onChange={(e) => { setName(e.target.value); setStatus("idle"); }}
          className="w-full max-w-sm rounded-xl border border-[#E4DCCB] bg-cream px-4 py-3 text-sm outline-none focus:border-primary"
          placeholder="Your name"
        />
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={status === "saving"} className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-5 py-2.5 text-sm font-semibold text-cream disabled:opacity-60">
          {status === "saving" ? "Saving…" : "Save changes"}
        </button>
        {status === "saved" && <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600"><Check className="h-4 w-4" aria-hidden="true" /> Saved</span>}
        {status === "error" && <span className="text-sm text-red-600">Couldn&apos;t save. Try again.</span>}
      </div>
    </form>
  );
}
