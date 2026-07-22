"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight, LineChart, Zap, Users2, GraduationCap, Video, Network,
  FolderOpen, Headphones, CheckCircle2, Compass,
} from "lucide-react";

type Side = "ones" | "builders";
type Tile = { href: string; icon: typeof LineChart; label: string; desc: string };

/**
 * PathHub — the side-aware member home. Reads the same `portal_side` the sidebar
 * uses and stays in sync via the "portal-side" event PortalNav dispatches, so the
 * dashboard becomes a distinct experience for The One vs The Builder.
 */
export function PathHub({ firstName }: { firstName: string }) {
  const [side, setSide] = useState<Side>("ones");

  useEffect(() => {
    try {
      const s = localStorage.getItem("portal_side");
      if (s === "ones" || s === "builders") setSide(s);
    } catch { /* ignore */ }
    const onSide = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d === "ones" || d === "builders") setSide(d);
    };
    window.addEventListener("portal-side", onSide as EventListener);
    return () => window.removeEventListener("portal-side", onSide as EventListener);
  }, []);

  return side === "builders" ? <BuilderHub firstName={firstName} /> : <OneHub firstName={firstName} />;
}

function HubTile({ t }: { t: Tile }) {
  const Icon = t.icon;
  return (
    <Link
      href={t.href}
      className="group flex flex-col rounded-2xl border border-[#E7E4DD] bg-white p-5 transition-all hover:-translate-y-0.5 hover:shadow-card"
    >
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-white" aria-hidden="true">
        <Icon className="h-5 w-5" />
      </span>
      <h3 className="mt-4 flex items-center gap-1 font-serif text-sm font-semibold uppercase tracking-[0.12em] text-navy">
        {t.label}
        <ArrowRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </h3>
      <p className="mt-1 text-sm text-charcoal/60">{t.desc}</p>
    </Link>
  );
}

function Banner({
  eyebrow, line1, line2, body, ctaLabel, ctaHref, altLabel, altHref,
}: {
  eyebrow: string; line1: string; line2: string; body: string;
  ctaLabel: string; ctaHref: string; altLabel: string; altHref: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-navy p-8 sm:p-10">
      <span className="eyebrow text-gold-light">{eyebrow}</span>
      <h1 className="mt-4 font-serif text-3xl font-semibold uppercase leading-[1.05] tracking-[0.02em] text-white sm:text-4xl">
        {line1}
        <br />
        <span className="text-gold-light">{line2}</span>
      </h1>
      <p className="mt-4 max-w-xl text-light/80">{body}</p>
      <div className="mt-7 flex flex-wrap gap-3">
        <Link
          href={ctaHref}
          className="group inline-flex items-center gap-2.5 rounded-none bg-white px-7 py-3.5 text-[13px] font-medium uppercase tracking-[0.14em] text-navy transition-colors hover:bg-ice"
        >
          {ctaLabel}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </Link>
        <Link
          href={altHref}
          className="inline-flex items-center gap-2 rounded-none border border-white/25 px-7 py-3.5 text-[13px] font-medium uppercase tracking-[0.14em] text-white transition-colors hover:bg-white/10"
        >
          {altLabel}
        </Link>
      </div>
    </div>
  );
}

/* ─────────────────────────── The One (customer) ─────────────────────────── */
function OneHub({ firstName }: { firstName: string }) {
  const tiles: Tile[] = [
    { href: "/portal/trading", icon: LineChart, label: "The Floor", desc: "The live trading room" },
    { href: "/portal/trading?view=plays", icon: Zap, label: "Live Setups", desc: "Today's plays, shared" },
    { href: "/portal/leadership", icon: Users2, label: "Featured Traders", desc: "Learn from the ones ahead" },
    { href: "/portal/training", icon: GraduationCap, label: "Creator Launchpad", desc: "Trading & mindset training" },
  ];
  return (
    <div className="space-y-8">
      <Banner
        eyebrow="The One · Your Path"
        line1={`Welcome back, ${firstName}.`}
        line2="Master the markets. Master your mind."
        body="The floor is open. Show up, put in the reps, and trade alongside a room that has your back."
        ctaLabel="Enter The Floor"
        ctaHref="/portal/trading"
        altLabel="Continue Onboarding"
        altHref="/portal/start-here"
      />

      <div className="rounded-2xl border border-[#E7E4DD] bg-offwhite/70 p-6 sm:p-7">
        <span className="eyebrow">Today&apos;s Mindset</span>
        <p className="mt-3 font-serif text-xl font-semibold uppercase tracking-[0.01em] text-navy sm:text-2xl">
          Discipline is remembering what you want most.
        </p>
        <p className="mt-1.5 text-sm text-charcoal/55">Placeholder — set a fresh daily prompt for the community.</p>
      </div>

      <div>
        <span className="eyebrow">Your Focus</span>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tiles.map((t) => <HubTile key={t.href} t={t} />)}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── The Builder (affiliate) ─────────────────────── */
function BuilderHub({ firstName }: { firstName: string }) {
  const goals = [
    "Reach out to 5 new people",
    "Complete today's training module",
    "Follow up with your top 3 prospects",
    "Listen to your development audio",
  ];
  const tiles: Tile[] = [
    { href: "/portal/training", icon: GraduationCap, label: "Creator Launchpad", desc: "Sales & skills training" },
    { href: "/portal/prospects", icon: Video, label: "Next Up", desc: "Your prospect pipeline" },
    { href: "/portal/team", icon: Network, label: "My Circle", desc: "Your growing team" },
    { href: "/portal/resources", icon: FolderOpen, label: "Resources", desc: "Scripts, tools & assets" },
  ];
  return (
    <div className="space-y-8">
      <Banner
        eyebrow="The Builder · Your Path"
        line1={`Let's build, ${firstName}.`}
        line2="Build the business. Become the leader."
        body="Champions are made in the boring reps. Do the work today that your future self will thank you for."
        ctaLabel="Start Today's Work"
        ctaHref="/portal/training"
        altLabel="Your Pipeline"
        altHref="/portal/prospects"
      />

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Daily goals */}
        <div className="rounded-2xl border border-[#E7E4DD] bg-white p-6 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <span className="eyebrow">Today&apos;s Goals</span>
            <span className="text-xs text-medium">Placeholder — set daily targets</span>
          </div>
          <ul className="mt-4 space-y-2.5">
            {goals.map((g) => (
              <li key={g} className="flex items-center gap-3 rounded-xl border border-[#EEEDE8] bg-offwhite/60 px-4 py-3">
                <span className="grid h-5 w-5 flex-shrink-0 place-items-center rounded-full border border-primary/30 text-primary" aria-hidden="true">
                  <CheckCircle2 className="h-3.5 w-3.5 opacity-0" />
                </span>
                <span className="text-sm font-medium text-navy">{g}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Today's audio */}
        <div className="flex flex-col rounded-2xl bg-navy p-6 text-white">
          <span className="eyebrow text-gold-light">Today&apos;s Audio</span>
          <div className="mt-4 flex items-center gap-4">
            <span className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-full bg-white/10" aria-hidden="true">
              <Headphones className="h-5 w-5" />
            </span>
            <div>
              <p className="font-semibold">Your Daily Standard</p>
              <p className="text-sm text-light/70">10 min · Personal development</p>
            </div>
          </div>
          <button
            type="button"
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-none bg-white px-6 py-3 text-[13px] font-medium uppercase tracking-[0.14em] text-navy transition-colors hover:bg-ice"
          >
            <Compass className="h-4 w-4" aria-hidden="true" /> Play Audio
          </button>
          <p className="mt-3 text-xs text-light/45">Placeholder — connect your audio library here.</p>
        </div>
      </div>

      <div>
        <span className="eyebrow">Your Focus</span>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tiles.map((t) => <HubTile key={t.href} t={t} />)}
        </div>
      </div>
    </div>
  );
}
