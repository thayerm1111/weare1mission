"use client";

import { useState } from "react";
import { Play, Heart, Eye, Send, Smile, Calendar, PlayCircle } from "lucide-react";

const PRESENTER = { name: "RJ Antuna", role: "Forex Educator", topic: "Forex", lang: "English", viewers: 312 };

const CHAT = [
  { u: "Marcus", m: "gold looking clean today 🔥" },
  { u: "Dee", m: "what's the bias on XAU?" },
  { u: "RJ Antuna", m: "waiting for the London open, watch 4120", host: true },
  { u: "Sam", m: "in from 4127 🙏" },
  { u: "Priya", m: "ty for the breakdown" },
];

const REPLAYS = [
  { d: "2026-05-28 05:58", t: "London Session Breakdown" },
  { d: "2026-05-27 06:02", t: "NY Open — Gold + Indices" },
  { d: "2026-05-22 14:38", t: "Liquidity & Order Blocks" },
  { d: "2026-05-21 05:56", t: "Risk Management Live" },
  { d: "2026-05-20 05:56", t: "Pre-market Game Plan" },
  { d: "2026-05-15 16:03", t: "Weekly Review" },
];

const SCHEDULE = [
  { day: "Tuesday", time: "12:00 AM" },
  { day: "Wednesday", time: "1:00 AM" },
  { day: "Thursday", time: "1:00 AM" },
];

export function TheRoom() {
  const [following, setFollowing] = useState(false);

  return (
    <div className="space-y-4">
      {/* Stage: video + chat */}
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        {/* Video */}
        <div className="relative flex min-h-[58vh] items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-[#151206] via-[#0c0c0c] to-black">
          <div className="pointer-events-none absolute inset-0 opacity-40 [background:radial-gradient(circle_at_50%_40%,rgba(212,180,90,0.18),transparent_60%)]" />
          <span className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-xs font-semibold">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            LIVE
          </span>
          <span className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1 text-xs text-white/80">
            <Eye className="h-3.5 w-3.5" /> {PRESENTER.viewers}
          </span>

          <div className="relative z-10 flex flex-col items-center text-center">
            <button className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 backdrop-blur transition hover:bg-white/20">
              <Play className="ml-1 h-7 w-7" />
            </button>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.3em] text-white/50">
              {PRESENTER.role}
            </p>
            <p className="mt-2 rounded-md bg-gold/80 px-8 py-2 text-3xl font-bold tracking-tight text-black">
              {PRESENTER.name}
            </p>
          </div>
        </div>

        {/* Chat */}
        <div className="flex min-h-[58vh] flex-col rounded-2xl border border-white/10 bg-[#101010]">
          <div className="border-b border-white/10 px-4 py-3">
            <p className="text-sm font-semibold">Live chat</p>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {CHAT.map((c, i) => (
              <div key={i} className="text-sm leading-snug">
                <span className={`font-semibold ${c.host ? "text-gold-light" : "text-white/80"}`}>
                  {c.u}
                </span>{" "}
                <span className="text-white/60">{c.m}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-white/10 p-3">
            <input
              placeholder="Write something…"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none"
            />
            <button className="text-white/40 hover:text-white">
              <Smile className="h-5 w-5" />
            </button>
            <button className="rounded-lg bg-white px-2.5 py-2 text-black">
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Session info bar */}
      <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#101010] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gold/30 text-sm font-bold text-gold-light">
            RJ
          </div>
          <div>
            <p className="text-sm font-semibold">{PRESENTER.name}</p>
            <p className="text-xs text-white/50">
              <span className="text-gold-light">{PRESENTER.topic}</span> · {PRESENTER.lang}
            </p>
          </div>
        </div>
        <button
          onClick={() => setFollowing((v) => !v)}
          className={`inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-colors ${
            following ? "bg-gold text-black" : "border border-gold/50 text-gold-light hover:bg-gold/10"
          }`}
        >
          <Heart className={`h-4 w-4 ${following ? "fill-black" : ""}`} /> {following ? "Following" : "Follow"}
        </button>
      </div>

      {/* Replays + schedule */}
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div>
          <p className="mb-3 text-sm font-semibold">Session Replay</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {REPLAYS.map((r, i) => (
              <article key={i} className="overflow-hidden rounded-xl border border-white/10 bg-[#0f0f0f]">
                <div className="flex aspect-video items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-black">
                  <span className="text-xs font-bold uppercase tracking-widest text-white/40">
                    Starting soon
                  </span>
                </div>
                <div className="p-3">
                  <p className="flex items-center gap-1.5 text-[11px] text-white/40">
                    <Calendar className="h-3 w-3" /> {r.d}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-white">{r.t}</p>
                  <button className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-gold-light hover:text-gold">
                    <PlayCircle className="h-4 w-4" /> Watch replay
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-3 text-sm font-semibold">Live Schedule</p>
          <div className="space-y-2">
            {SCHEDULE.map((s, i) => (
              <div key={i} className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0f0f0f] p-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gold/30 text-xs font-bold text-gold-light">
                  RJ
                </div>
                <div>
                  <p className="text-sm font-semibold">{PRESENTER.name}</p>
                  <p className="flex items-center gap-1.5 text-xs text-white/50">
                    <Calendar className="h-3 w-3 text-gold-light" /> {s.time} · {s.day}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
