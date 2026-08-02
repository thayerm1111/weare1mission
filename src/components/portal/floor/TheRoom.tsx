"use client";

import { Video, Clock, ChevronRight, CalendarClock } from "lucide-react";
import { LIVE_URL, CALLS } from "@/lib/liveCalls";

/**
 * The Room — the live trading calls hub. We run daily sessions on Zoom via
 * 1MissionLive.com, so this shows the upcoming call schedule with a one-tap join
 * rather than an in-app stream. Swap in an embedded player once streaming is set up.
 */
export function TheRoom() {
  return (
    <div className="space-y-4">
      {/* Hero — join the live call */}
      <div className="relative overflow-hidden rounded-2xl border border-ice bg-gradient-to-b from-offwhite to-ice p-6 sm:p-8">
        <div className="pointer-events-none absolute inset-0 opacity-40 [background:radial-gradient(circle_at_50%_-10%,rgba(207,199,179,0.4),transparent_60%)]" />
        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-xs font-semibold">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/70" /><span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" /></span>
            Live daily on Zoom
          </span>
          <h2 className="mt-3 text-2xl font-black tracking-tight text-navy sm:text-3xl">Live trading calls</h2>
          <p className="mt-1 max-w-xl text-sm text-charcoal/60">
            Market overview and a live trading session every day. Tap below at any session time to join the room on 1MissionLive.com.
          </p>
          <a
            href={LIVE_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-navy to-primary px-6 py-3.5 text-sm font-bold text-cream shadow-card transition hover:shadow-cardhover"
          >
            <Video className="h-4 w-4" /> Join the live call
            <ChevronRight className="h-4 w-4" />
          </a>
          <p className="mt-2 text-[11px] text-charcoal/45">Zoom · 1MissionLive.com</p>
        </div>
      </div>

      {/* Upcoming calls */}
      <div>
        <p className="mb-3 inline-flex items-center gap-2 text-sm font-semibold">
          <CalendarClock className="h-4 w-4 text-gold-deep" /> Upcoming calls · every day
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {CALLS.map((c) => (
            <a
              key={c.t}
              href={LIVE_URL}
              target="_blank"
              rel="noreferrer"
              className={`group flex flex-col rounded-2xl border p-4 transition hover:shadow-cardhover ${c.hot ? "border-primary/50 bg-primary/[0.06]" : "border-ice bg-white"}`}
            >
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">
                <Clock className="h-3.5 w-3.5" /> {c.zone}
              </span>
              <span className="mt-1 text-2xl font-black tracking-tight text-navy">{c.t}</span>
              <span className="mt-1 text-sm text-charcoal/60">{c.label}</span>
              {c.hot && <span className="mt-2 inline-flex w-max items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">Live session</span>}
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-gold-deep opacity-0 transition group-hover:opacity-100">
                Join <ChevronRight className="h-3.5 w-3.5" />
              </span>
            </a>
          ))}
        </div>
      </div>

      {/* How it works */}
      <div className="rounded-2xl border border-ice bg-white p-4">
        <p className="text-sm font-semibold">How to join</p>
        <p className="mt-1 text-sm leading-relaxed text-charcoal/60">
          Sessions run daily at 3, 6 and 9 PM CST (4, 7 and 10 PM EST). Tap “Join the live call” at any session time and you’ll open the Zoom room at{" "}
          <a href={LIVE_URL} target="_blank" rel="noreferrer" className="font-semibold text-gold-deep underline">1MissionLive.com</a>. The 9 PM session includes a live trading session.
        </p>
      </div>
    </div>
  );
}
