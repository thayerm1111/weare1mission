import type { Metadata } from "next";
import { Smartphone, Share, Plus, MoreVertical, Download, Sparkles, Zap, Radio } from "lucide-react";

export const metadata: Metadata = {
  title: "Get the App — One Mission",
  description:
    "Install the One Mission app on your phone — the full trading floor and every AI tool, right on your home screen. Free for all members.",
};

const APP_URL = "https://weare1mission.com/app/";

export default function GetAppPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
      {/* Hero */}
      <div className="text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-gold-light/40 bg-gold-light/10 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-gold-light">
          <Smartphone className="h-3.5 w-3.5" /> One Mission App
        </span>
        <h1 className="mt-5 font-serif text-3xl font-bold text-navy sm:text-4xl">Get the app on your phone</h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-charcoal/70">
          The entire trading floor and every AI tool — the Strategy Scanner, OM AI Plays, MFXGHOST, Market Command,
          OM Charts and OM AI — right on your home screen. It installs in seconds, works like a native app, and it&apos;s
          free for every member.
        </p>

        <a
          href={APP_URL}
          className="mt-7 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-7 py-3.5 text-sm font-bold uppercase tracking-[0.12em] text-cream transition-opacity hover:opacity-90"
        >
          <Download className="h-4 w-4" /> Open the app
        </a>
        <p className="mt-3 text-xs text-charcoal/50">Sign in with your One Mission account — the same login you use here.</p>
      </div>

      {/* What you get */}
      <div className="mt-12 grid gap-3 sm:grid-cols-3">
        {[
          { icon: Radio, title: "The Floor", body: "Live plays and the room, always a tap away." },
          { icon: Zap, title: "Every AI tool", body: "Full setups, levels, scores and charts." },
          { icon: Sparkles, title: "Ask the desk", body: "Chat the AI about any live trade." },
        ].map((f) => (
          <div key={f.title} className="rounded-2xl border border-[#E7E4DD] bg-offwhite/60 p-4">
            <f.icon className="h-5 w-5 text-gold-light" />
            <p className="mt-2 font-serif text-base font-bold text-navy">{f.title}</p>
            <p className="mt-0.5 text-[13px] leading-snug text-charcoal/65">{f.body}</p>
          </div>
        ))}
      </div>

      {/* Install steps */}
      <div className="mt-12 grid gap-5 sm:grid-cols-2">
        {/* iPhone */}
        <div className="rounded-2xl border border-[#E7E4DD] bg-cream p-6 shadow-card">
          <h2 className="font-serif text-xl font-bold text-navy">On iPhone / iPad</h2>
          <p className="mt-1 text-[13px] text-charcoal/60">Use Safari (not Chrome) on iOS.</p>
          <ol className="mt-4 space-y-3">
            <Step n={1}>
              Open <a href={APP_URL} className="font-semibold text-primary underline">weare1mission.com/app</a> in Safari.
            </Step>
            <Step n={2}>
              Tap the <span className="inline-flex items-center gap-1 font-semibold text-navy"><Share className="h-4 w-4" /> Share</span> button at the bottom of the screen.
            </Step>
            <Step n={3}>
              Scroll down and tap <span className="inline-flex items-center gap-1 font-semibold text-navy"><Plus className="h-4 w-4" /> Add to Home Screen</span>.
            </Step>
            <Step n={4}>Tap <span className="font-semibold text-navy">Add</span> — the One Mission icon appears on your home screen. Open it and sign in.</Step>
          </ol>
        </div>

        {/* Android */}
        <div className="rounded-2xl border border-[#E7E4DD] bg-cream p-6 shadow-card">
          <h2 className="font-serif text-xl font-bold text-navy">On Android</h2>
          <p className="mt-1 text-[13px] text-charcoal/60">Use Chrome on Android.</p>
          <ol className="mt-4 space-y-3">
            <Step n={1}>
              Open <a href={APP_URL} className="font-semibold text-primary underline">weare1mission.com/app</a> in Chrome.
            </Step>
            <Step n={2}>
              Tap the <span className="inline-flex items-center gap-1 font-semibold text-navy"><MoreVertical className="h-4 w-4" /> menu</span> (three dots, top right).
            </Step>
            <Step n={3}>
              Tap <span className="font-semibold text-navy">Install app</span> (or <span className="font-semibold text-navy">Add to Home screen</span>).
            </Step>
            <Step n={4}>Confirm — the app installs to your home screen. Open it and sign in.</Step>
          </ol>
        </div>
      </div>

      {/* Share link */}
      <div className="mt-10 rounded-2xl border border-[#E7E4DD] bg-offwhite/60 p-6 text-center">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-charcoal/45">Share this page</p>
        <p className="mt-2 select-all break-all font-mono text-sm font-semibold text-navy">weare1mission.com/get-app</p>
        <p className="mt-2 text-[13px] text-charcoal/60">Send this link to the community — anyone can open it and follow the steps.</p>
      </div>

      <p className="mt-8 text-center text-xs text-charcoal/45">
        Already installed? Just open the One Mission icon on your home screen. Educational analysis, not financial advice.
      </p>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-primary text-[12px] font-bold text-cream">{n}</span>
      <span className="text-[13.5px] leading-relaxed text-charcoal/80">{children}</span>
    </li>
  );
}
