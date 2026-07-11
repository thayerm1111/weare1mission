"use client";

import { useState, type FormEvent } from "react";
import { CheckCircle2 } from "lucide-react";
import { preferredContactMethods } from "@/data/contactInformation";
import { Button } from "./Button";

/**
 * ContactForm — Version 1 validates and confirms locally (no backend).
 * TODO: POST `form` to your email tool / CRM / Supabase inside handleSubmit.
 */
export function ContactForm() {
  const [form, setForm] = useState({
    name: "", email: "", phone: "", instagram: "", invitedBy: "",
    message: "", preferred: preferredContactMethods[0],
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  function validate() {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Please enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Please enter a valid email.";
    if (!form.message.trim()) e.message = "Please enter a message.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    // TODO: send `form` to your backend here.
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-emerald-800" role="status">
        <CheckCircle2 className="h-7 w-7 flex-shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">Thanks — your message is on its way!</p>
          <p className="text-sm">Someone from the team will reach out soon. Be sure you&apos;re in the Telegram announcement channel too.</p>
        </div>
      </div>
    );
  }

  const field = "w-full rounded-xl border border-ice bg-white px-4 py-3 text-sm outline-none focus:border-primary";
  const labelCls = "mb-1 block text-sm font-medium text-navy";

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="c-name" className={labelCls}>Name *</label>
          <input id="c-name" className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={!!errors.name} aria-describedby={errors.name ? "c-name-e" : undefined} placeholder="Full name" />
          {errors.name && <p id="c-name-e" className="mt-1 text-xs text-red-600">{errors.name}</p>}
        </div>
        <div>
          <label htmlFor="c-email" className={labelCls}>Email *</label>
          <input id="c-email" type="email" className={field} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-invalid={!!errors.email} aria-describedby={errors.email ? "c-email-e" : undefined} placeholder="you@example.com" />
          {errors.email && <p id="c-email-e" className="mt-1 text-xs text-red-600">{errors.email}</p>}
        </div>
        <div>
          <label htmlFor="c-phone" className={labelCls}>Phone number</label>
          <input id="c-phone" type="tel" className={field} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Optional" />
        </div>
        <div>
          <label htmlFor="c-ig" className={labelCls}>Instagram username</label>
          <input id="c-ig" className={field} value={form.instagram} onChange={(e) => setForm({ ...form, instagram: e.target.value })} placeholder="@yourhandle" />
        </div>
        <div>
          <label htmlFor="c-invite" className={labelCls}>Who invited you?</label>
          <input id="c-invite" className={field} value={form.invitedBy} onChange={(e) => setForm({ ...form, invitedBy: e.target.value })} placeholder="Your mentor's name" />
        </div>
        <div>
          <label htmlFor="c-pref" className={labelCls}>Preferred contact method</label>
          <select id="c-pref" className={field} value={form.preferred} onChange={(e) => setForm({ ...form, preferred: e.target.value })}>
            {preferredContactMethods.map((m) => <option key={m}>{m}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="c-msg" className={labelCls}>Message *</label>
        <textarea id="c-msg" rows={5} className={field} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} aria-invalid={!!errors.message} aria-describedby={errors.message ? "c-msg-e" : undefined} placeholder="How can we help?" />
        {errors.message && <p id="c-msg-e" className="mt-1 text-xs text-red-600">{errors.message}</p>}
      </div>
      <Button type="submit" size="lg">Send Message</Button>
    </form>
  );
}
