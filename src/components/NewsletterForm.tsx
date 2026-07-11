"use client";

import { useState, type FormEvent } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "./Button";

/**
 * NewsletterForm — email-interest capture (Shop "notify me").
 * Version 1 validates and shows a success message locally (no backend).
 * TODO: connect this to your email tool / Supabase table by POSTing `form`
 * inside handleSubmit where indicated.
 */
export function NewsletterForm({ productOptions }: { productOptions: string[] }) {
  const [form, setForm] = useState({ name: "", email: "", interest: productOptions[0] });
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});

  function validate() {
    const e: typeof errors = {};
    if (!form.name.trim()) e.name = "Please enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Please enter a valid email.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (!validate()) {
      setStatus("error");
      return;
    }
    // TODO: send `form` to your backend / email provider here.
    setStatus("success");
    setForm({ name: "", email: "", interest: productOptions[0] });
  }

  if (status === "success") {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-800" role="status">
        <CheckCircle2 className="h-6 w-6 flex-shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">You&apos;re on the list!</p>
          <p className="text-sm">We&apos;ll let you know the moment the shop opens.</p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor="nl-name" className="mb-1 block text-sm font-medium text-navy">Name</label>
        <input
          id="nl-name"
          type="text"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? "nl-name-err" : undefined}
          className="w-full rounded-xl border border-ice bg-white px-4 py-3 text-sm outline-none focus:border-primary"
          placeholder="Your name"
        />
        {errors.name && <p id="nl-name-err" className="mt-1 text-xs text-red-600">{errors.name}</p>}
      </div>
      <div>
        <label htmlFor="nl-email" className="mb-1 block text-sm font-medium text-navy">Email</label>
        <input
          id="nl-email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? "nl-email-err" : undefined}
          className="w-full rounded-xl border border-ice bg-white px-4 py-3 text-sm outline-none focus:border-primary"
          placeholder="you@example.com"
        />
        {errors.email && <p id="nl-email-err" className="mt-1 text-xs text-red-600">{errors.email}</p>}
      </div>
      <div>
        <label htmlFor="nl-interest" className="mb-1 block text-sm font-medium text-navy">Product interest</label>
        <select
          id="nl-interest"
          value={form.interest}
          onChange={(e) => setForm({ ...form, interest: e.target.value })}
          className="w-full rounded-xl border border-ice bg-white px-4 py-3 text-sm outline-none focus:border-primary"
        >
          {productOptions.map((p) => <option key={p}>{p}</option>)}
        </select>
      </div>
      <Button type="submit" size="lg" className="w-full">Notify Me</Button>
    </form>
  );
}
